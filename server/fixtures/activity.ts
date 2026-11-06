import type {Activity,Resource} from '../../shared/schema.js';
// A week of invented change events, shaped like what each cloud's audit log returns, attached to resources that really are in the scenario.
const ACTORS:Record<string,{name:string;type:Activity['actorType']}[]>={
  azure:[{name:'kim.ops@atlas.example',type:'user'},{name:'jung.net@atlas.example',type:'user'},{name:'sp-terraform-prod',type:'service'},{name:'Azure Policy',type:'service'}],
  aws:[{name:'arn:aws:sts::assumed-role/AdminRole/kim.ops',type:'user'},{name:'arn:aws:iam::user/choi.dev',type:'user'},{name:'arn:aws:sts::assumed-role/GitHubDeploy/ci',type:'service'}],
  gcp:[{name:'lee.sec@atlas.example',type:'user'},{name:'deploy@atlas-net-host.iam.gserviceaccount.com',type:'service'},{name:'choi.dev@atlas.example',type:'user'}],
};
type Op={op:string;label:string;kind:Activity['kind']};
const OPS:Record<string,Partial<Record<Resource['kind'],Op[]>>>={
  azure:{compute:[{op:'Microsoft.Compute/virtualMachines/write',label:'VM 생성·변경',kind:'write'},{op:'Microsoft.Compute/virtualMachines/restart/action',label:'VM 다시 시작',kind:'action'},{op:'Microsoft.Compute/virtualMachines/deallocate/action',label:'VM 할당 해제',kind:'action'}],firewall:[{op:'Microsoft.Network/networkSecurityGroups/securityRules/write',label:'NSG 규칙 변경',kind:'write'},{op:'Microsoft.Network/networkSecurityGroups/securityRules/delete',label:'NSG 규칙 삭제',kind:'delete'}],network:[{op:'Microsoft.Network/virtualNetworks/write',label:'VNet 변경',kind:'write'}],database:[{op:'Microsoft.Sql/servers/firewallRules/write',label:'SQL 방화벽 변경',kind:'write'}],storage:[{op:'Microsoft.Storage/storageAccounts/listKeys/action',label:'스토리지 키 조회',kind:'action'}]},
  aws:{compute:[{op:'RunInstances',label:'인스턴스 시작',kind:'write'},{op:'StopInstances',label:'인스턴스 중지',kind:'action'},{op:'ModifyInstanceAttribute',label:'인스턴스 속성 변경',kind:'write'}],firewall:[{op:'AuthorizeSecurityGroupIngress',label:'보안 그룹 인바운드 허용',kind:'write'},{op:'RevokeSecurityGroupIngress',label:'보안 그룹 규칙 제거',kind:'delete'}],network:[{op:'CreateRoute',label:'라우트 추가',kind:'write'}],database:[{op:'ModifyDBInstance',label:'RDS 변경',kind:'write'}],gateway:[{op:'CreateTransitGatewayVpcAttachment',label:'TGW 연결 생성',kind:'write'}]},
  gcp:{compute:[{op:'v1.compute.instances.insert',label:'인스턴스 생성',kind:'write'},{op:'v1.compute.instances.stop',label:'인스턴스 중지',kind:'action'},{op:'v1.compute.instances.setMetadata',label:'메타데이터 변경',kind:'write'}],firewall:[{op:'v1.compute.firewalls.patch',label:'방화벽 규칙 변경',kind:'write'},{op:'v1.compute.firewalls.delete',label:'방화벽 규칙 삭제',kind:'delete'}],network:[{op:'v1.compute.subnetworks.patch',label:'서브넷 변경',kind:'write'}],cluster:[{op:'google.container.v1.ClusterManager.UpdateCluster',label:'GKE 클러스터 변경',kind:'write'}]},
};
const SOURCE:Record<string,string>={azure:'Azure Activity Log',aws:'AWS CloudTrail',gcp:'GCP Admin Activity 감사 로그'};
export function demoActivity(resources:Resource[],now:Date):Activity[]{
  let x=7;const r=()=>{x=(x*1103515245+12345)%2147483648;return x/2147483648;};
  const out:Activity[]=[],candidates=resources.filter(res=>OPS[res.provider]?.[res.kind]);
  const total=Math.min(260,Math.max(12,Math.round(candidates.length*2.2)));
  for(let i=0;i<total&&candidates.length;i++){
    const res=candidates[Math.floor(r()*candidates.length)],ops=OPS[res.provider][res.kind]!,op=ops[Math.floor(r()*ops.length)],actors=ACTORS[res.provider],actor=actors[Math.floor(r()*actors.length)];
    const at=now.getTime()-r()*7*86_400_000;
    out.push({id:`demo-activity-${i}`,provider:res.provider,at:new Date(at).toISOString(),actor:actor.name,actorType:actor.type,operation:op.op,label:op.label,kind:op.kind,target:res.id,targetName:res.name,scope:res.scope,outcome:r()<.06?'failed':'ok',ip:actor.type==='user'?`203.0.113.${Math.floor(r()*200)+10}`:undefined,source:SOURCE[res.provider]});
  }
  return out.sort((a,b)=>b.at.localeCompare(a.at));
}
