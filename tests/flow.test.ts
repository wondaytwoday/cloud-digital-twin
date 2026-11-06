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
  // The on-prem range is more specific than the default route, so the gateway takes it and the firewall is not crossed.
  const onprem=analyzeFlow(await demo,{from:await id('web-01'),to:'10.200.0.5',protocol:'tcp',port:443});
  assert.ok(kinds(onprem).includes('gateway'));assert.ok(!kinds(onprem).includes('appliance'));
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
