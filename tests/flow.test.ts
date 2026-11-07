import test from 'node:test';
import assert from 'node:assert/strict';
import {mockSnapshot} from '../server/mock.ts';
import {analyzeFlow,resolveEndpoint} from '../shared/flow.ts';
import {validateSnapshot,type Link,type Resource,type Snapshot} from '../shared/schema.ts';

const demo=mockSnapshot('standard');
const id=async(name:string)=>(await demo).resources.find(r=>r.name===name)!.id;
const flow=async(from:string,to:string,port=443)=>analyzeFlow(await demo,{from:/^\d/.test(from)?from:await id(from),to:/^\d/.test(to)?to:await id(to),protocol:'tcp',port});
const kinds=(r:{path:{kind:string}[]})=>r.path.map(h=>h.kind);

// A minimal Azure estate built by hand, for rules the demo cannot isolate.
type Spec={vnets:{name:string;cidr:string;subnets:{name:string;cidr:string;nsg?:string;routes?:Resource['routes']}[]}[];peerings?:[string,string,boolean?][];vms?:{name:string;subnet:string;ip:string}[];appliances?:{name:string;subnet:string;ip:string}[];nsgs?:{name:string;rules:[string,string,string,string,string,string,number][]}[]};
function azure(spec:Spec):Snapshot{
  const R=(id:string,name:string,kind:Resource['kind'],extra:Partial<Resource>={})=>({id:`azure:${id}`,nativeId:id,name,provider:'azure' as const,kind,type:kind,scope:'sub',region:'kc',source:'test',...extra});
  const resources:object[]=[],links:Link[]=[];
  for(const n of spec.nsgs??[])resources.push(R(`nsg/${n.name}`,n.name,'firewall',{rules:n.rules.map(([name,direction,action,protocol,ports,source,priority])=>({name,direction,action,protocol,ports,source,destination:'*',priority:String(priority)}))}));
  for(const v of spec.vnets){resources.push(R(`vnet/${v.name}`,v.name,'network',{cidr:v.cidr}));for(const sn of v.subnets){resources.push(R(`subnet/${sn.name}`,sn.name,'subnet',{parent:`azure:vnet/${v.name}`,cidr:sn.cidr,routes:sn.routes??[]}));if(sn.nsg)links.push({id:`p:${sn.name}`,source:`azure:nsg/${sn.nsg}`,target:`azure:subnet/${sn.name}`,kind:'policy',label:'NSG',evidence:'test'});}}
  for(const [a,b,transit] of spec.peerings??[])links.push({id:`peer:${a}:${b}`,source:`azure:vnet/${a}`,target:`azure:vnet/${b}`,kind:'peering',label:'Peering',evidence:'test',...(transit?{transit}:{})});
  for(const vm of spec.vms??[]){resources.push(R(`vm/${vm.name}`,vm.name,'compute',{parent:`azure:subnet/${vm.subnet}`,ip:vm.ip}),R(`nic/${vm.name}`,`${vm.name}-nic`,'nic',{parent:`azure:subnet/${vm.subnet}`,ip:vm.ip}));links.push({id:`a:${vm.name}`,source:`azure:vm/${vm.name}`,target:`azure:nic/${vm.name}`,kind:'attachment',label:'기본 NIC',evidence:'test'});}
  for(const a of spec.appliances??[])resources.push(R(`fw/${a.name}`,a.name,'appliance',{parent:`azure:subnet/${a.subnet}`,ip:a.ip,specs:{'종류':'Azure Firewall'}}));
  return validateSnapshot({version:1,mode:'mock',collectedAt:new Date().toISOString(),resources,links,warnings:[],scopes:['sub']});
}
const hubAndSpokes=(udr=false)=>azure({
  vnets:[{name:'hub',cidr:'10.0.0.0/16',subnets:[{name:'fw',cidr:'10.0.1.0/24'}]},
    {name:'a',cidr:'10.1.0.0/16',subnets:[{name:'a1',cidr:'10.1.1.0/24',...(udr?{routes:[{destination:'10.0.0.0/8',nextHop:'fw',via:'VirtualAppliance',nextHopIp:'10.0.1.4',origin:'user'as const}]}:{})}]},
    {name:'b',cidr:'10.2.0.0/16',subnets:[{name:'b1',cidr:'10.2.1.0/24',...(udr?{routes:[{destination:'10.0.0.0/8',nextHop:'fw',via:'VirtualAppliance',nextHopIp:'10.0.1.4',origin:'user'as const}]}:{})}]}],
  peerings:[['hub','a'],['hub','b']],vms:[{name:'vm-a',subnet:'a1',ip:'10.1.1.10'},{name:'vm-b',subnet:'b1',ip:'10.2.1.10'}],appliances:[{name:'fw',subnet:'fw',ip:'10.0.1.4'}]});
const run=(s:Snapshot,from:string,to:string,port=443)=>analyzeFlow(s,{from:`azure:vm/${from}`,to:`azure:vm/${to}`,protocol:'tcp',port});

test('1. being in the same network decides nothing: the destination\'s policy does',async()=>{
  const s=azure({vnets:[{name:'v',cidr:'10.0.0.0/16',subnets:[{name:'s1',cidr:'10.0.1.0/24'},{name:'s2',cidr:'10.0.2.0/24',nsg:'deny-from-s1'}]}],nsgs:[{name:'deny-from-s1',rules:[['DenyS1','Inbound','Deny','*','*','10.0.1.0/24',100]]}],vms:[{name:'x',subnet:'s1',ip:'10.0.1.10'},{name:'y',subnet:'s2',ip:'10.0.2.10'}]});
  const r=run(s,'x','y');
  assert.equal(r.status,'blocked');assert.equal(r.policies.find(p=>p.verdict==='deny')?.rule?.name,'DenyS1');
  // In the demo, the data subnet admits SQL from the app subnet only, so a web VM in the same VNet is refused.
  const web=await flow('web-01','pe-sql-platform',1433),app=await flow('api-prod-01','pe-sql-platform',1433);
  assert.notEqual(web.status,'allowed');assert.equal(app.status,'allowed');
});
test('2. two VMs in one subnet get different answers when one NIC carries its own NSG',async()=>{
  const https=await flow('web-01','web-02',443),ssh=await flow('web-01','web-02',22);
  assert.equal(https.status,'allowed');assert.equal(ssh.status,'blocked');
  assert.deepEqual(ssh.policies.find(p=>p.verdict==='deny')&&{name:ssh.policies.find(p=>p.verdict==='deny')!.name,at:ssh.policies.find(p=>p.verdict==='deny')!.at},{name:'nsg-web-02',at:'도착 NIC web-02-nic'});
});
test('3. peering is not transitive: two spokes of one hub do not reach each other without a route',()=>{
  const r=run(hubAndSpokes(),'vm-a','vm-b');
  assert.equal(r.status,'blocked');assert.ok(!kinds(r).includes('appliance'));assert.ok(r.gaps.some(g=>/피어링은 전이되지 않습니다/.test(g.text)));
  // With a route that sends spoke traffic to the hub firewall, it is a candidate path through that firewall, undecided because its rules are not collected.
  const via=run(hubAndSpokes(true),'vm-a','vm-b');
  assert.equal(via.status,'unknown');assert.deepEqual(via.path.filter(h=>h.kind==='appliance').map(h=>h.label),['fw']);
  assert.match(via.policies.find(p=>p.direction==='through')!.reason,/Azure Firewall 정책/);
});
test('4. a firewall appears in the path only where a route sends traffic to it',async()=>{
  const platform=await flow('web-01','8.8.8.8'),dev=await flow('dev-sandbox-01','8.8.8.8');
  assert.ok(kinds(platform).includes('appliance'),'the platform spoke routes 0.0.0.0/0 to afw-hub');
  assert.ok(!kinds(dev).includes('appliance'),'the dev spoke has no such route');
  // The dev spoke has no route table, so on-prem goes straight to the hub gateway; the platform spoke's 10.0.0.0/8 UDR sends it through the firewall,
  // a user route winning over the gateway's system route of the same length.
  const direct=analyzeFlow(await demo,{from:await id('dev-sandbox-01'),to:'10.200.0.5',protocol:'tcp',port:443});
  assert.ok(kinds(direct).includes('gateway'));assert.ok(!kinds(direct).includes('appliance'));
  const viaFirewall=analyzeFlow(await demo,{from:await id('web-01'),to:'10.200.0.5',protocol:'tcp',port:443});
  assert.ok(kinds(viaFirewall).includes('appliance'));
});
test('5. NSGs are policies applied to a hop, never a hop themselves',async()=>{
  for(const r of [await flow('web-01','web-02',22),await flow('web-01','8.8.8.8'),await flow('api-prod-01','pe-sql-platform',1433)]){
    const s=await demo,policyIds=new Set(s.resources.filter(x=>x.kind==='firewall').map(x=>x.id));
    assert.ok(!r.path.some(h=>h.id&&policyIds.has(h.id)),'no policy on the path');assert.ok(r.policies.some(p=>p.policy&&policyIds.has(p.policy)),'policies are listed as checks');
  }
});
test('6. two NICs and secondary IPs stay distinct, and the one holding the address decides',async()=>{
  const s=await demo,second=resolveEndpoint(s,'10.11.2.20'),secondary=resolveEndpoint(s,'10.10.1.12');
  assert.equal(second.nic?.name,'etl-01-nic-2');assert.equal(second.subnet?.name,'warehouse');assert.equal(second.resource?.name,'etl-01');
  assert.equal(secondary.nic?.name,'web-01-nic');assert.equal(secondary.resource?.name,'web-01');
  const etl=s.resources.find(r=>r.name==='etl-01')!;assert.deepEqual(etl.addresses?.map(a=>a.ip),['10.11.1.10','10.11.2.20']);
  assert.equal(s.links.filter(l=>l.source===etl.id&&l.kind==='attachment'&&s.resources.find(r=>r.id===l.target)?.kind==='nic').length,2,'one attachment per NIC');
});
test('7. object storage is reached through its endpoint, and the service itself sits in no subnet',async()=>{
  const s=await demo,st=s.resources.find(r=>r.name==='stplatformlogs')!,r=await flow('api-prod-01','stplatformlogs');
  assert.equal(st.kind,'bucket');assert.equal(st.parent,undefined);
  assert.equal(r.to.resource?.kind,'endpoint');assert.equal(r.to.ip,'10.10.3.6');assert.deepEqual(kinds(r).slice(-2),['endpoint','service']);
  assert.ok(r.conditions.some(c=>/해석하는지는 확인하지 않았습니다/.test(c)),'name resolution is not assumed');
});
test('10. missing rules or an unreadable condition give unknown, never allowed',()=>{
  const asg=azure({vnets:[{name:'v',cidr:'10.0.0.0/16',subnets:[{name:'s1',cidr:'10.0.1.0/24'},{name:'s2',cidr:'10.0.2.0/24',nsg:'n'}]}],nsgs:[{name:'n',rules:[['FromAppAsg','Inbound','Deny','*','*','*',100]]}],vms:[{name:'x',subnet:'s1',ip:'10.0.1.10'},{name:'y',subnet:'s2',ip:'10.0.2.10'}]});
  (asg.resources.find(r=>r.name==='n')!.rules[0] as {peers?:string[]}).peers=['asg:/subscriptions/x/applicationSecurityGroups/app'];
  const r=run(asg,'x','y');assert.equal(r.status,'unknown');assert.ok(r.policies[0].unevaluated?.length);
  const tag=azure({vnets:[{name:'v',cidr:'10.0.0.0/16',subnets:[{name:'s1',cidr:'10.0.1.0/24'},{name:'s2',cidr:'10.0.2.0/24',nsg:'n'}]}],nsgs:[{name:'n',rules:[['FromStorage','Inbound','Allow','*','*','Storage.KoreaCentral',100]]}],vms:[{name:'x',subnet:'s1',ip:'10.0.1.10'},{name:'y',subnet:'s2',ip:'10.0.2.10'}]});
  // An unreadable Allow above a definite Allow cannot change a first-match result, so that one is decidable; an unreadable Allow above a definite Deny is not.
  assert.equal(run(tag,'x','y').status,'allowed');
  const mixed=azure({vnets:[{name:'v',cidr:'10.0.0.0/16',subnets:[{name:'s1',cidr:'10.0.1.0/24'},{name:'s2',cidr:'10.0.2.0/24',nsg:'n'}]}],nsgs:[{name:'n',rules:[['FromStorage','Inbound','Allow','*','*','Storage.KoreaCentral',100],['DenyAll','Inbound','Deny','*','*','*',200]]}],vms:[{name:'x',subnet:'s1',ip:'10.0.1.10'},{name:'y',subnet:'s2',ip:'10.0.2.10'}]});
  assert.equal(run(mixed,'x','y').status,'unknown');
});
test('return path: a request through a firewall whose reply bypasses it is reported as asymmetric',()=>{
  const s=hubAndSpokes(true);s.resources.find(r=>r.name==='b1')!.routes=[];
  const r=run(s,'vm-a','vm-b');
  assert.equal(r.returnPath.status,'unknown');assert.match(r.returnPath.notes[0],/비대칭/);
});
test('every result says it is configuration, not observation, and when its data was collected',async()=>{
  const r=await flow('web-01','web-02');assert.equal(r.observed,'not-integrated');assert.ok(r.analyzedAt);assert.ok('azure' in r.dataAt);
});

// ---- AWS
const awsFlow=async(from:string,to:string,port:number,s?:Snapshot)=>analyzeFlow(s??await demo,{from:/^\d/.test(from)?from:await id(from),to:await id(to),protocol:'tcp',port});
test('AWS 1. same VPC decides nothing: a security group admits only what a rule allows',async()=>{
  const r=await awsFlow('checkout-api-01','checkout-api-02',8443);
  assert.equal(r.status,'blocked');assert.match(r.summary,/허용하는 규칙이 없습니다/);
  assert.equal(r.policies.find(p=>p.verdict==='deny')?.at,'도착 ENI eni-checkout2-0');
});
test('AWS: a NACL refuses what the security group would never be asked about, by rule number',async()=>{
  const ok=await awsFlow('checkout-api-01','rds-orders',5432),refused=await awsFlow('checkout-api-02','rds-orders',5432);
  assert.equal(ok.status,'allowed');assert.equal(ok.returnPath.status,'allowed');
  assert.equal(refused.status,'blocked');assert.equal(refused.policies.find(p=>p.verdict==='deny')?.rule?.name,'#90');
});
test('AWS: a NACL that drops the reply\'s ephemeral ports blocks a request it lets in',async()=>{
  const s=structuredClone(await demo),acl=s.resources.find(r=>r.name==='acl-data')!;
  acl.rules=acl.rules.filter(r=>!(r.direction==='Outbound'&&r.ports==='1024-65535'));
  const r=await awsFlow('checkout-api-01','rds-orders',5432,s);
  assert.equal(r.returnPath.status,'blocked');assert.equal(r.status,'blocked');assert.match(r.summary,/응답/);
});
test('AWS: S3 through a gateway endpoint: a route-table target with no ENI, and the bucket outside the VPC',async()=>{
  const s=await demo,r=await awsFlow('checkout-api-01','commerce-prod-assets',443),ep=s.resources.find(x=>x.name==='vpce-s3')!;
  assert.equal(ep.kind,'endpoint');assert.equal(ep.ip,undefined);assert.ok(!ep.addresses?.length,'no address is invented for a gateway endpoint');
  assert.ok(!s.links.some(l=>l.kind==='attachment'&&(l.source===ep.id||l.target===ep.id)&&s.resources.find(x=>x.id===(l.source===ep.id?l.target:l.source))?.kind==='nic'),'and no NIC');
  assert.deepEqual(kinds(r).slice(1,4),['route','endpoint','service']);assert.ok(r.gaps.some(g=>/버킷 정책/.test(g.text)));
  assert.equal(s.resources.find(x=>x.name==='commerce-prod-assets')!.parent,undefined);
});
test('AWS 6. a second ENI keeps its own subnet, groups and address',async()=>{
  const s=await demo,r=resolveEndpoint(s,'10.21.3.30');
  assert.equal(r.nic?.name,'eni-orders-1');assert.equal(r.subnet?.name,'data-a');assert.equal(r.resource?.name,'orders-worker-01');
  const vm=s.resources.find(x=>x.name==='orders-worker-01')!;assert.deepEqual(vm.addresses?.map(a=>[a.ip,a.primary]),[['10.21.1.30',true],['10.21.3.30',false]]);
  // Same instance, other ENI: its own security group (sg-db, no egress rules) refuses to start the connection.
  assert.equal((await awsFlow('10.21.3.30','rds-orders',5432)).policies[0].verdict,'deny');
});

// ---- GCP
test('GCP 2. a firewall rule targets tags: of two instances side by side, only the tagged one admits',async()=>{
  const tagged=await awsFlow('analytics-api-02','analytics-api-01',443),untagged=await awsFlow('analytics-api-01','analytics-api-02',443);
  assert.equal(tagged.status,'allowed');assert.match(tagged.policies.find(p=>p.direction==='inbound')!.reason,/대상 태그 analytics/);
  assert.equal(untagged.status,'blocked');assert.match(untagged.policies.find(p=>p.direction==='inbound')!.name,/암묵적 인그레스 거부/);
});
test('GCP: VPC routes, peering by exchanged subnet routes, and the policies not collected are named',async()=>{
  const r=await awsFlow('analytics-api-01','sandbox-01',443);
  assert.ok(kinds(r).includes('peering'));assert.ok(r.gaps.some(g=>/계층형 방화벽 정책/.test(g.text)&&!g.undecided));
});
test('GCP: when a Cloud Router\'s dynamic routes could not be read, a private range covered only by the default route is undecided',async()=>{
  const s=structuredClone(await demo),router=s.resources.find(r=>r.name==='router-seoul')!,vpc=s.resources.find(r=>r.id===router.parent)!;
  router.specs['동적 경로']='수집 실패';vpc.routes=vpc.routes.filter(r=>r.via!=='BGP');
  const r=analyzeFlow(s,{from:s.resources.find(x=>x.name==='analytics-api-01')!.id,to:'10.200.0.1',protocol:'tcp',port:443});
  assert.equal(r.status,'unknown');assert.ok(r.gaps.some(g=>g.undecided&&/BGP/.test(g.text)));
});
test('GCP: BGP routes read from the router lead on-prem',async()=>{
  const r=analyzeFlow(await demo,{from:await id('analytics-api-01'),to:'10.200.0.1',protocol:'tcp',port:443});
  assert.equal(r.status,'allowed');assert.equal(r.completeness,'partial');assert.deepEqual(kinds(r).slice(-2),['gateway','onprem']);
  assert.match(r.path.find(h=>h.kind==='route')!.evidence,/BGP/);
});
test('GCP: without an external IP, the internet is reached only through a Cloud NAT that serves the subnet',async()=>{
  const apps=analyzeFlow(await demo,{from:await id('analytics-api-01'),to:'8.8.8.8',protocol:'tcp',port:443}),data=analyzeFlow(await demo,{from:await id('inference-gpu-01'),to:'8.8.8.8',protocol:'tcp',port:443});
  assert.equal(apps.status,'allowed');assert.match(apps.path.find(h=>h.kind==='internet')!.label,/Cloud NAT nat-seoul/);
  assert.equal(data.status,'blocked');assert.match(data.summary,/Cloud NAT도 없어/);
});
test('GCP: instances keep their NICs, tags, service account and collected disk',async()=>{
  const s=await demo,vm=s.resources.find(r=>r.name==='analytics-api-01')!,out=s.links.filter(l=>l.source===vm.id);
  assert.deepEqual(vm.netTags,['analytics']);
  assert.ok(out.some(l=>l.kind==='uses_identity'&&s.resources.find(x=>x.id===l.target)?.specs['이메일']?.startsWith('analytics-api@')));
  assert.ok(out.some(l=>l.kind==='attachment'&&s.resources.find(x=>x.id===l.target)?.kind==='disk'),'its disk asset is joined');
  const twin=s.resources.find(r=>r.name==='analytics-api-02')!;assert.ok(!s.links.some(l=>l.source===twin.id&&s.resources.find(x=>x.id===l.target)?.kind==='disk'),'a disk whose asset was not collected is not invented');
});

// ---- 11, 12: what a restricted user and live data may carry
import {restrictSnapshot} from '../server/auth.ts';
test('11. a restricted user cannot analyse into, or learn about, another scope',async()=>{
  const s=await demo,platform=s.hierarchy.find(n=>n.name==='Platform Prod')!.scope!,mine=restrictSnapshot(s,[platform]);
  const web=mine.resources.find(r=>r.name==='web-01')!,r=analyzeFlow(mine,{from:web.id,to:'8.8.8.8',protocol:'tcp',port:443});
  // The firewall in the hub belongs to another subscription: the route's next hop stays as the address the user configured, the device is not revealed.
  assert.ok(!r.path.some(h=>h.label==='afw-hub'),'no device from another scope appears');assert.equal(r.status,'unknown');
  assert.ok(!mine.links.some(l=>!mine.resources.some(x=>x.id===l.source)||!mine.resources.some(x=>x.id===l.target)),'every relation has both ends in scope');
  assert.equal(mine.crossRefs,undefined);
  for(const p of mine.resources.filter(x=>x.kind==='firewall'))assert.equal(p.scope,platform);
});
test('12. live data refuses demo traffic and observed relations, and every collector link says how it was established',async()=>{
  const {validateSnapshot:v}=await import('../shared/schema.ts');
  const base={version:1,mode:'live',collectedAt:new Date().toISOString(),resources:[{id:'a',nativeId:'a',name:'a',provider:'azure',kind:'compute',type:'t',scope:'s',region:'r',source:'x'},{id:'b',nativeId:'b',name:'b',provider:'azure',kind:'compute',type:'t',scope:'s',region:'r',source:'x'}],warnings:[],scopes:['s']};
  assert.throws(()=>v({...base,links:[{id:'1',source:'a',target:'b',kind:'simulation',label:'x',evidence:'x'}]}),/synthetic/);
  assert.throws(()=>v({...base,links:[{id:'1',source:'a',target:'b',kind:'observed_flow',label:'x',evidence:'x'}]}),/observation source/);
  assert.throws(()=>v({...base,links:[{id:'1',source:'a',target:'b',kind:'attachment',label:'x',evidence:'x',basis:'observed'}]}),/observation source/);
  const s=await demo,collected=s.links.filter(l=>l.kind!=='simulation');
  assert.ok(collected.every(l=>l.basis),'no collector link lacks its basis');
  assert.ok(collected.some(l=>l.basis==='inferred')&&collected.filter(l=>l.basis==='inferred').every(l=>l.note||l.evidence),'inferred links say how');
});

// ---- Azure Firewall rules
test('a collected Azure Firewall policy decides in group and collection order, with its default deny',async()=>{
  const fw=(r:Awaited<ReturnType<typeof flow>>)=>r.policies.find(p=>p.direction==='through')!;
  const https=await flow('web-01','8.8.8.8',443),ssh=await flow('web-01','8.8.8.8',22),sql=await flow('web-01','etl-01',1433);
  assert.equal(fw(https).verdict,'allow');assert.match(fw(https).rule!.name!,/internet-https/);
  assert.equal(ssh.status,'blocked');assert.match(fw(ssh).reason,/기본 거부/);
  assert.equal(sql.status,'allowed');assert.match(fw(sql).rule!.name!,/spoke-to-spoke/);assert.equal(sql.returnPath.status,'allowed','both spokes route the supernet through the firewall');
  const dev=analyzeFlow(await demo,{from:await id('dev-sandbox-01'),to:await id('etl-01'),protocol:'tcp',port:1433});
  assert.notEqual(dev.status,'allowed');
});
test('an application rule matches by FQDN, so an address alone leaves the firewall undecided',async()=>{
  const r=await flow('web-01','8.8.8.8',80),fw=r.policies.find(p=>p.direction==='through')!;
  assert.equal(fw.verdict,'unknown');assert.match(fw.reason,/FQDN/);
});
test('a firewall whose policy rules could not be read stays undecided',async()=>{
  const s=structuredClone(await demo),afw=s.resources.find(r=>r.name==='afw-hub')!;afw.specs['정책 규칙']='미수집';
  const r=analyzeFlow(s,{from:s.resources.find(x=>x.name==='web-01')!.id,to:'8.8.8.8',protocol:'tcp',port:443});
  assert.equal(r.status,'unknown');assert.match(r.policies.find(p=>p.direction==='through')!.reason,/수집하지 못해/);
});

// ---- Transit Gateway route tables
const withoutTgwRoute=(s:Snapshot,table:string,dest:string)=>{const tgw=s.resources.find(r=>r.name==='tgw-core')!;tgw.routes=tgw.routes.filter(r=>!(r.tags?.includes(table)&&r.destination===dest));return s;};
test('TGW: the table the source VPC is associated with decides, and on-prem is reached through the VPN it names',async()=>{
  const r=analyzeFlow(await demo,{from:await id('checkout-api-01'),to:'10.200.0.1',protocol:'tcp',port:443});
  assert.equal(r.status,'allowed');assert.equal(r.completeness,'partial');
  assert.ok(r.path.some(h=>/tgw-rtb-prod: 10\.0\.0\.0\/8 → vpn-seoul/.test(h.label)));assert.deepEqual(kinds(r).slice(-1),['onprem']);
});
test('TGW: an on-prem supernet propagated into the table sends dev-bound traffic to the VPN, which is reported, not assumed isolated',async()=>{
  const r=await awsFlow('checkout-api-01','dev-app-01',22);
  assert.equal(r.status,'unknown');assert.ok(r.gaps.some(g=>g.undecided&&/VPN·DX로 보내지만/.test(g.text)));
});
test('TGW: without a route in the source table the segment is isolated',async()=>{
  const s=withoutTgwRoute(structuredClone(await demo),'tgw-rtb-prod','10.0.0.0/8'),r=await awsFlow('checkout-api-01','dev-app-01',22,s);
  assert.equal(r.status,'blocked');assert.match(r.summary,/tgw-rtb-prod에 .* 경로가 없습니다/);
});
test('TGW: a request that arrives but has no route back is blocked on the reply',async()=>{
  const s=structuredClone(await demo),tgw=s.resources.find(r=>r.name==='tgw-core')!;
  tgw.routes=tgw.routes.filter(r=>!(r.tags?.includes('tgw-rtb-prod')&&r.destination==='10.0.0.0/8'));tgw.routes.push({destination:'10.22.0.0/16',nextHop:'vpc-dev',via:'vpc',origin:'user',tags:['tgw-rtb-prod']});
  tgw.routes=tgw.routes.filter(r=>!(r.tags?.includes('tgw-rtb-dev')&&r.destination==='10.0.0.0/8'));
  const r=await awsFlow('checkout-api-01','dev-app-01',22,s);
  assert.equal(r.status,'blocked');assert.equal(r.returnPath.status,'blocked');assert.match(r.returnPath.notes[0],/tgw-rtb-dev에 .*돌아가는 경로가 없습니다/);
});
test('TGW: without collected route tables the answer stays undecided, as before',async()=>{
  const s=structuredClone(await demo);delete s.resources.find(r=>r.name==='tgw-core')!.associations;
  const r=analyzeFlow(s,{from:s.resources.find(x=>x.name==='checkout-api-01')!.id,to:'10.200.0.1',protocol:'tcp',port:443});
  assert.equal(r.status,'unknown');assert.ok(r.gaps.some(g=>/라우트 테이블을 수집하지 않아/.test(g.text)));
});

// ---- ASG membership and IP groups
test('an NSG rule naming an ASG matches by NIC membership, not by address',async()=>{
  const member=await flow('web-01','api-prod-01',9100),other=await flow('api-prod-02','api-prod-01',9100);
  assert.equal(member.status,'allowed');assert.equal(member.policies.find(p=>p.name==='nsg-app')!.rule!.name,'AllowMetricsFromWebAsg');
  assert.equal(other.status,'blocked');assert.equal(other.policies.find(p=>p.verdict==='deny')!.rule!.name,'DenyMetrics');
});
test('ASG membership that was not collected leaves an ASG rule undecided',async()=>{
  const s=structuredClone(await demo);delete s.resources.find(r=>r.name==='web-01-nic')!.netTags;
  const r=analyzeFlow(s,{from:s.resources.find(x=>x.name==='web-01')!.id,to:s.resources.find(x=>x.name==='api-prod-01')!.id,protocol:'tcp',port:9100});
  assert.equal(r.status,'unknown');assert.match(r.policies.find(p=>p.name==='nsg-app')!.reason,/ASG 구성원 미수집/);
});
test('a firewall rule on a collected IP group uses its addresses; an uncollected group is undecided',async()=>{
  const r=await flow('web-01','203.0.113.5',443);assert.equal(r.status,'blocked');assert.match(r.policies.find(p=>p.direction==='through')!.rule!.name!,/blocklist/);
  assert.match(r.policies.find(p=>p.direction==='through')!.rule!.destination,/203\.0\.113\.0\/24/);
  const s=structuredClone(await demo),rule=s.resources.find(x=>x.name==='afw-hub')!.rules.find(x=>x.name?.includes('blocklist'))!;rule.destination='';rule.peers=['ipgroup-dst:/subscriptions/x/ipgroups/unknown'];
  const u=analyzeFlow(s,{from:s.resources.find(x=>x.name==='web-01')!.id,to:'8.8.8.8',protocol:'tcp',port:443});
  assert.equal(u.status,'unknown','an unreadable deny ahead of the allow could apply');
});

// ---- Azure service tags and AWS managed prefix lists
test('an NSG rule naming a service tag matches by the tag\'s published ranges',async()=>{
  const storage=await flow('api-prod-01','20.150.4.10',443),other=await flow('api-prod-01','8.8.8.8',443);
  assert.equal(storage.status,'allowed');assert.equal(storage.policies.find(p=>p.name==='nsg-app')!.rule!.name,'AllowStorageOut');
  assert.equal(other.status,'blocked');assert.equal(other.policies.find(p=>p.verdict==='deny')!.rule!.name,'DenyInternetOut');
});
test('service tag ranges that were not collected leave the tag rule undecided',async()=>{
  const s=structuredClone(await demo);delete s.serviceTags;
  const r=analyzeFlow(s,{from:s.resources.find(x=>x.name==='api-prod-01')!.id,to:'20.150.4.10',protocol:'tcp',port:443});
  assert.equal(r.status,'unknown');assert.match(r.policies.find(p=>p.name==='nsg-app')!.reason,/Storage\.KoreaCentral/);
});
test('a security group rule naming a prefix list matches by its entries, and an unread list is undecided',async()=>{
  const s3=await flow('batch-nightly-01','52.219.57.1',443),other=await flow('batch-nightly-01','8.8.8.8',443);
  assert.equal(s3.policies.find(p=>p.name==='sg-batch')!.verdict,'allow');assert.equal(other.status,'blocked');
  const s=structuredClone(await demo);delete s.prefixLists;
  const u=analyzeFlow(s,{from:s.resources.find(x=>x.name==='batch-nightly-01')!.id,to:'52.219.57.1',protocol:'tcp',port:443});
  assert.equal(u.status,'unknown');assert.match(u.policies.find(p=>p.name==='sg-batch')!.reason,/pl-78a54011/);
});
test('to S3 through a gateway endpoint, the prefix list in the subnet route is what the group rule names',async()=>{
  const r=await flow('batch-nightly-01','commerce-prod-assets',443);
  assert.equal(r.status,'allowed');assert.equal(r.policies.find(p=>p.name==='sg-batch')!.verdict,'allow');
});
test('a restricted operator keeps service tag and prefix list ranges, which are public',async()=>{
  const s=await demo,limited=restrictSnapshot(s,[s.resources.find(r=>r.name==="api-prod-01")!.scope]);
  assert.deepEqual(limited.serviceTags,s.serviceTags);assert.deepEqual(limited.prefixLists,s.prefixLists);
});
