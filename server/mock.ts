import { azureFixture,awsFixture,gcpFixture } from './fixtures.js';
import { normalizeAzure,normalizeAws,normalizeGcp } from './normalize.js';
import { ResourceSchema, validateSnapshot, type Link } from '../shared/schema.js';
export function mockSnapshot(){
  const normalized=[normalizeAzure(azureFixture),normalizeAws(awsFixture,'111122223333','ap-northeast-2'),normalizeGcp(gcpFixture)];
  const resources=normalized.flatMap(n=>n.resources),links=normalized.flatMap(n=>n.links);
  resources.unshift(ResourceSchema.parse({id:'onprem:seoul',nativeId:'demo/onprem/seoul',name:'Seoul datacenter',provider:'onprem',kind:'onprem',type:'Corporate network',scope:'Corporate',region:'Seoul',cidr:'10.0.0.0/16',specs:{'네트워크':'사내망 · 데모','연결':'시뮬레이션 경로'},source:'Synthetic fixture'}));
  for(const [i,r] of resources.filter(r=>r.kind==='compute').entries()){
    r.specs['vCPU']='4';r.specs['메모리']='16 GiB';if(r.provider==='azure'&&r.name.includes('gpu')){r.specs['메모리']='28 GiB';r.specs['GPU']='1 × NVIDIA T4';}
    if(!r.specs['GPU']||r.specs['GPU'].includes('조회'))r.specs['GPU']='없음';
    r.metrics={cpu:24+i*7,memory:41+i*5,history:[18,25,20,31,26,35,28,33,27,40,32,24+i*7]};
    r.iam=[{principal:r.provider==='azure'?'platform-operators':r.provider==='aws'?'PlatformReadOnly':'platform@example.internal',role:r.provider==='azure'?'Reader':r.provider==='aws'?'ReadOnlyAccess':'roles/viewer',scope:r.scope}];
  }
  const connect=(source:string,target:string,label:string,protocol:string,ports:string,rate:string):Link=>({id:`demo:${source}:${target}`,source,target,kind:'simulation',label,evidence:'명시적으로 작성한 시연 경로. 실제 패킷·경로 검증 결과가 아닙니다.',protocol,ports,rate});
  for(const p of ['azure','aws','gcp']){
    const gateway=resources.find(r=>r.provider===p&&r.kind==='gateway'&&(p!=='azure'||r.type.includes('expressRouteCircuits')))!;
    const vm=resources.find(r=>r.provider===p&&r.kind==='compute')!;
    // Cloud Router is control plane: terminate GCP's hybrid illustration at the VPC, not Router.
    const endpoint=p==='gcp'?resources.find(r=>r.provider===p&&r.kind==='network')!:gateway;
    links.push(connect('onprem:seoul',endpoint.id,p==='azure'?'Private peering':p==='aws'?'IPsec tunnel':'Hybrid attachment · 예시',p==='aws'?'IPsec':'Private link','—',p==='azure'?'128 Mbps':p==='aws'?'64 Mbps':'96 Mbps'));
    if(p!=='gcp')links.push(connect(gateway.id,vm.id,'업무 트래픽','TCP','443','12.4 Mbps'));
    const second=resources.filter(r=>r.provider===p&&r.kind==='compute')[1];
    links.push(connect(vm.id,second.id,'서비스 호출','TCP','443','4.8 Mbps'));
  }
  return validateSnapshot({version:1,mode:'mock',collectedAt:new Date().toISOString(),resources,links,warnings:normalized.flatMap(n=>n.warnings),scopes:['Azure · platform-prod','AWS · commerce-prod','GCP · analytics-prod']});
}
