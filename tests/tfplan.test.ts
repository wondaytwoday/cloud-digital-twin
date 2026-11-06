import test from 'node:test';
import assert from 'node:assert/strict';
import {mockSnapshot} from '../server/mock.ts';
import {parsePlan,planImpact} from '../shared/tfplan.ts';
import {impactOf} from '../shared/topology.ts';

// The shape `terraform show -json plan.tfplan` prints (format 1.x): one entry per resource address with before/after attributes.
const plan=(...resource_changes:object[])=>JSON.stringify({format_version:'1.2',terraform_version:'1.9.5',resource_changes});
const change=(address:string,actions:string[],before:object|null,after:object|null,mode='managed')=>({address,mode,type:address.split('.')[0],name:address.split('.')[1],provider_name:'registry.terraform.io/hashicorp/x',change:{actions,before,after,after_unknown:{}}});
// Terraform keeps Azure IDs in the case the API returned; the collector stores them lower-cased.
const armCase=(id:string)=>id.replace('/resourcegroups/','/resourceGroups/').replace('/providers/microsoft.network/','/providers/Microsoft.Network/').replace('/networksecuritygroups/','/networkSecurityGroups/').replace('/virtualnetworkgateways/','/virtualNetworkGateways/');
const estate=async()=>{const s=await mockSnapshot('standard'),named=(n:string)=>s.resources.find(r=>r.name===n)!;return{s,named};};

test('an NSG rule change lands on its NSG and reaches what the NSG protects',async()=>{
  const {s,named}=await estate(),nsg=s.resources.find(r=>r.provider==='azure'&&r.kind==='firewall'&&s.links.some(l=>l.kind==='policy'&&l.source===r.id))!;
  const rule=`${armCase(nsg.nativeId)}/securityRules/AllowSSH`;
  const [c]=planImpact(s,plan(change('azurerm_network_security_rule.ssh',['update'],{id:rule,destination_port_range:'443'},{id:rule,destination_port_range:'22'}))).changes;
  assert.equal(c.action,'update');assert.deepEqual(c.subjects.map(x=>[x.resource.id,x.how]),[[nsg.id,'parent']]);
  const protectedIds=s.links.filter(l=>l.kind==='policy'&&l.source===nsg.id).map(l=>l.target);
  for(const t of protectedIds)assert.ok(c.candidates.some(x=>x.resource.id===t),`applied-to ${t}`);
  void named;
});
test('deleting a gateway lists what would lose its configured path to on-prem',async()=>{
  const {s,named}=await estate(),gw=named('vgw-hub-er'),lost=impactOf(s.resources,s.links,gw.id).lost;assert.ok(lost.length>0);
  const [c]=planImpact(s,plan(change('azurerm_virtual_network_gateway.hub',['delete'],{id:armCase(gw.nativeId)},null))).changes;
  assert.equal(c.action,'delete');assert.equal(c.subjects[0].how,'id');
  for(const id of lost)assert.ok(c.candidates.some(x=>x.resource.id===id&&/사내망/.test(x.why)),id);
  // An update to the same gateway keeps its contents in view but claims no outage.
  const [u]=planImpact(s,plan(change('azurerm_virtual_network_gateway.hub',['update'],{id:armCase(gw.nativeId)},{id:armCase(gw.nativeId)}))).changes;
  assert.ok(!u.candidates.some(x=>/사내망/.test(x.why)));
});
test('a new AWS rule has no ID yet, so it attaches to the security group it names',async()=>{
  const {s,named}=await estate(),sg=named('sg-alb'),raw=sg.nativeId.split('/').pop()!;
  const [c]=planImpact(s,plan(change('aws_security_group_rule.https',['create'],null,{security_group_id:raw,from_port:443,to_port:443,cidr_blocks:['0.0.0.0/0']}))).changes;
  assert.deepEqual(c.subjects.map(x=>[x.resource.id,x.how]),[[sg.id,'reference']]);
  assert.ok(c.candidates.length>0,'what the group protects is listed');
});
test('GCP matches by Terraform ID and by self_link',async()=>{
  const {s,named}=await estate(),fw=named('fw-allow-internal'),path=fw.nativeId.replace('//compute.googleapis.com/','');
  const r=planImpact(s,plan(change('google_compute_firewall.internal',['update'],{id:path},{id:path}),change('google_compute_instance.vm',['update'],{id:'x',network_interface:[{subnetwork:`https://www.googleapis.com/compute/v1/${named('gke-seoul').nativeId.replace('//compute.googleapis.com/','')}`}]},null)));
  const byAddress=new Map(r.changes.map(c=>[c.address,c]));
  assert.equal(byAddress.get('google_compute_firewall.internal')!.subjects[0].resource.id,fw.id);
  assert.equal(byAddress.get('google_compute_instance.vm')!.subjects[0].resource.id,named('gke-seoul').id);
});
test('replace counts as both, unmatched changes say why, and reads and no-ops are left out',async()=>{
  const {s,named}=await estate(),sub=named('gke-seoul'),id=sub.nativeId.replace('//compute.googleapis.com/','');
  const r=planImpact(s,plan(
    change('google_compute_subnetwork.gke',['delete','create'],{id},{id:null}),
    change('aws_route.default',['create'],null,{route_table_id:'rtb-unknown',destination_cidr_block:'0.0.0.0/0'}),
    change('aws_vpc.legacy',['delete'],{id:'vpc-not-collected'},null),
    change('data.aws_ami.ubuntu',['read'],null,{id:'ami-1'},'data'),change('aws_s3_bucket.logs',['no-op'],{id:'x'},{id:'x'})));
  assert.equal(r.ignored,2);assert.equal(r.terraformVersion,'1.9.5');
  assert.deepEqual(r.changes.map(c=>c.action),['delete','replace','create'],'removals first');
  assert.match(r.changes.find(c=>c.address==='aws_route.default')!.note!,/참조하는 수집 자원을 찾지 못했습니다/);
  assert.match(r.changes.find(c=>c.address==='aws_vpc.legacy')!.note!,/맞는 ID가 없습니다/);
  assert.ok(r.changes.find(c=>c.action==='replace')!.candidates.length>0);
});
test('only a plan is accepted, with a message that says how to make one',()=>{
  assert.throws(()=>parsePlan('not json'),/terraform show -json/);
  assert.throws(()=>parsePlan('{"values":{}}'),/Terraform plan JSON이 아닙니다/);
  assert.throws(()=>parsePlan('{"resource_changes":"x"}'),/Terraform plan JSON이 아닙니다/);
  assert.deepEqual(parsePlan('{"format_version":"1.2"}').resource_changes,[],'an empty plan is a plan');
});
