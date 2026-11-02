import test from 'node:test';
import assert from 'node:assert/strict';
import {mockSnapshot} from '../server/mock.ts';
import {existsSync} from 'node:fs';
import {mkdtemp,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {adjacency,exposures,findPath,impactOf,ingressIds,health,reachable} from '../shared/topology.ts';
import {finish,normalizeAws} from '../server/normalize.ts';
import {collectAwsAccount,collectAzureWith} from '../server/collectors.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {restrictSnapshot} from '../server/auth.ts';
import app,{liveSnapshot} from '../server/app.ts';
import {diffResources} from '../shared/diff.ts';
import {iconKey,groupIcon,providerLogo} from '../shared/iconKeys.ts';
import {scenarios} from '../shared/scenarios.ts';
import {buildScopeIndex} from '../shared/hierarchy.ts';
const load=async()=>{const s=await mockSnapshot('standard'),named=(n:string)=>s.resources.find(r=>r.name===n)!;return{s,named,graph:{resources:s.resources,links:s.links}};};
test('fixtures survive pagination and normalization across every provider',async()=>{
  const {s,named}=await load();
  for(const n of ['vnet-hub','afw-hub','sql-platform','aks-platform','tgw-core','rds-orders','alb-checkout','vpc-shared','gke-analytics','sql-analytics','sandbox-01'])assert.ok(named(n),n);
  assert.equal(named('sql-platform').parent,s.resources.find(r=>r.kind==='subnet'&&r.name==='data'&&r.provider==='azure')!.id);
  assert.equal(named('checkout-api-01').specs['vCPU'],'4');
  assert.equal(named('worker-gpu-01').specs['GPU'],'1 × NVIDIA T4');
  assert.equal(named('warehouse-01').status,'deallocated');
  assert.equal(named('vpn-seoul').status,'degraded');
});
test('peering from both sides is one relation, and unreadable peers stay visible as external',async()=>{
  const {s,named}=await load(),hub=named('vnet-hub').id,spoke=named('vnet-platform-prod').id;
  assert.equal(s.links.filter(l=>l.kind==='peering'&&[l.source,l.target].includes(hub)&&[l.source,l.target].includes(spoke)).length,1);
  assert.equal(named('vnet-partner-erp').kind,'external');
  assert.equal(named('vnet-partner-erp').status,'조회 권한 없음');
});
test('TGW attachments resolve to VPCs collected from other accounts',async()=>{
  const {s,named}=await load();
  assert.equal(named('vpc-commerce').kind,'network');
  assert.equal(named('vpc-commerce').scope,'444455556666');
  assert.ok(s.links.some(l=>l.source===named('tgw-core').id&&l.target===named('vpc-commerce').id));
});
test('path from a spoke VM reaches on-prem through hub gateway and circuit',async()=>{
  const {s,named,graph}=await load();
  const names=findPath(graph,named('api-prod-01').id,ingressIds(s.resources)).map(id=>s.resources.find(r=>r.id===id)!.name);
  for(const hop of ['vnet-platform-prod','vnet-hub','vgw-hub-er','er-seoul-01','Seoul datacenter'])assert.ok(names.includes(hop),`${hop} missing from ${names}`);
});
test('losing the circuit strands all Azure networks but no other cloud',async()=>{
  const {s,named}=await load(),{lost}=impactOf(s.resources,s.links,named('er-seoul-01').id);
  for(const n of ['vnet-hub','vnet-platform-prod','web-01','etl-01'])assert.ok(lost.includes(named(n).id),n);
  assert.ok(!lost.includes(named('checkout-api-01').id));
  assert.ok(!lost.includes(named('analytics-api-01').id));
});
test('policies are not connectivity hops',async()=>{
  const {s}=await load(),graph=adjacency(s.resources,s.links);
  for(const r of s.resources)if(r.kind==='firewall')assert.ok(!graph.has(r.id));
});
test('status maps to health without treating unknown text as healthy',()=>{
  for(const bad of ['inactive','INACTIVE','unavailable'])assert.equal(health(bad),'warn',bad);
  for(const neutral of ['backup','Updating','OS_UNPROVISIONED','deleted'])assert.equal(health(neutral),'neutral',neutral);
  assert.equal(health('Ready'),'ok');
  assert.equal(health('deallocated'),'stopped');assert.equal(health('degraded'),'warn');assert.equal(health('running'),'ok');assert.equal(health('구성 수집됨'),'neutral');assert.equal(health('조회 권한 없음'),'unknown');
});

test('every scenario validates, and only documented gaps lack an official icon',async()=>{
  for(const {id} of scenarios){
    const s=await mockSnapshot(id);assert.ok(s.resources.length>0,id);
    for(const r of s.resources){
      const key=iconKey(r);
      if(key)assert.ok(existsSync(`src/assets/csp-icons/${key}.svg`),`${id}: ${key}`);
      else assert.ok(r.provider==='onprem'||r.kind==='external'||r.type==='AWS::EC2::SecurityGroup'||r.type==='compute.googleapis.com/Subnetwork',`${id}: ${r.type} has no icon`);
    }
  }
  for(const key of [...Object.values(providerLogo),...Object.values(groupIcon).flatMap(v=>Object.values(v))])assert.ok(existsSync(`src/assets/csp-icons/${key}.svg`),key);
});
test('simple scenarios stay small; enterprise is large and multi-region',async()=>{
  assert.ok((await mockSnapshot('single-vm')).resources.length<=6);
  const s=await mockSnapshot('enterprise');
  assert.ok(s.resources.length>=500,`only ${s.resources.length}`);
  for(const p of ['azure','aws','gcp'])assert.ok(new Set(s.resources.filter(r=>r.provider===p&&r.kind!=='external').map(r=>r.region)).size>=2,p);
  assert.ok(new Set(s.resources.map(r=>r.scope)).size>=25);
});
test('redundant circuit: losing one does not strand the hub, but losing the gateway does',async()=>{
  const s=await mockSnapshot('enterprise'),named=(n:string)=>s.resources.find(r=>r.name===n)!;
  assert.deepEqual(impactOf(s.resources,s.links,named('er-seoul-01').id).lost,[]);
  const lost=impactOf(s.resources,s.links,named('vgw-hub-jp').id).lost;
  for(const n of ['vnet-commerce-jp','commerce-jp-app-01'])assert.ok(lost.includes(named(n).id),`peering is not transitive, so ${n} loses on-prem`);
});
test('TGW peering crosses regions and partner peers stay visible',async()=>{
  const s=await mockSnapshot('enterprise'),named=(n:string)=>s.resources.find(r=>r.name===n)!;
  assert.ok(s.links.some(l=>l.kind==='peering'&&[l.source,l.target].includes(named('tgw-core-kr').id)&&[l.source,l.target].includes(named('tgw-core-jp').id)));
  for(const n of ['vnet-partner-settlement','vpc-partner-analytics','vpc-partner-exchange'])assert.equal(named(n).kind,'external',n);
});
test('scenarios without on-prem have no impact analysis target but still trace',async()=>{
  const s=await mockSnapshot('web-tier');
  assert.deepEqual(ingressIds(s.resources),[]);
  const g={resources:s.resources,links:s.links},named=(n:string)=>s.resources.find(r=>r.name===n)!;
  assert.ok(findPath(g,named('shop-web-01').id,[named('sql-shop').id]).length>=2);
});
test('org trees from all three APIs nest scopes under their groups',async()=>{
  const s=await mockSnapshot('enterprise'),index=buildScopeIndex(s.hierarchy,s.resources);
  const named=(n:string)=>s.hierarchy.find(x=>x.name===n)!;
  assert.deepEqual(index.pathTo(named('Commerce Prod').id).map(n=>n.kind),['tenant','managementGroup','managementGroup','subscription']);
  assert.deepEqual(index.pathTo(named('checkout-prod').id).map(n=>n.kind),['organization','ou','ou','account']);
  assert.deepEqual(index.pathTo(named('atlas-recsys').id).map(n=>n.kind),['organization','folder','folder','project']);
  assert.equal(index.scopesUnder(named('Corp KR').id).length,5);
  assert.equal(index.stats.get(named('Legacy App (미수집)').id)!.resources,0);
  const collected=s.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external').length;
  assert.equal(Object.values(index.roots).flat().reduce((sum,n)=>sum+index.stats.get(n.id)!.resources,0),collected,'every collected resource rolls up to a root');
});
test('without org access, scopes still appear flat under the provider',async()=>{
  for(const id of ['single-vm','gke-app','hybrid-vpn'] as const){
    const s=await mockSnapshot(id),index=buildScopeIndex(s.hierarchy,s.resources);
    assert.ok(Object.values(index.roots).flat().length>=1,id);
    assert.ok(Object.values(index.roots).flat().every(n=>n.scope),id);
  }
});

test('deleted AWS items are not drawn',()=>{
  const n=normalizeAws({Vpcs:[{VpcId:'vpc-1'}],TransitGateways:[{TransitGatewayId:'tgw-1',State:'available'}],TransitGatewayVpcAttachments:[{TransitGatewayId:'tgw-1',VpcId:'vpc-1',VpcOwnerId:'A',State:'deleted'}],NatGateways:[{NatGatewayId:'nat-1',State:'deleted'}],VpnConnections:[{VpnConnectionId:'vpn-1',State:'deleted'}],Reservations:[{Instances:[{InstanceId:'i-1',State:{Name:'terminated'}}]}]},'A','r');
  assert.deepEqual(n.resources.map(r=>r.name).sort(),['tgw-1','vpc-1']);assert.equal(n.links.length,0);
});
test('a TGW shared across accounts stays one node',()=>{
  const net=normalizeAws({TransitGateways:[{TransitGatewayId:'tgw-1',State:'available',Tags:[{Key:'Name',Value:'tgw-core'}]}]},'NET','r');
  const member=normalizeAws({Vpcs:[{VpcId:'vpc-1'}],TransitGatewayVpcAttachments:[{TransitGatewayId:'tgw-1',VpcId:'vpc-1',VpcOwnerId:'MEM',State:'available'}]},'MEM','r');
  const merged=finish([net,member]);
  assert.deepEqual(merged.resources.map(r=>r.kind).sort(),['gateway','network']);
  assert.equal(merged.links[0].source,'aws:NET/r/tgw-1');
});
test('a global Direct Connect gateway collected from two regions is one node',async()=>{
  const api:Record<string,any>={DescribeDirectConnectGateways:{directConnectGateways:[{directConnectGatewayId:'dx-1',directConnectGatewayName:'dx',directConnectGatewayState:'available'}]}};
  const call=async(_s:string,op:string)=>api[op]??{};
  const merged=finish([await collectAwsAccount(call as any,'111','a'),await collectAwsAccount(call as any,'111','b')]);
  assert.equal(merged.resources.filter(r=>r.name==='dx').length,1);
});
test('Azure hierarchy roots at the tenant that owns the subscription',async()=>{
  const j=(b:unknown)=>new Response(JSON.stringify(b));
  const request=(async(u:unknown)=>{const t=String(u);if(t.includes('/tenants?'))return j({value:[{tenantId:'OTHER',displayName:'Other'},{tenantId:'MINE',displayName:'Mine'}]});if(t.includes('managementGroups/'))return j({properties:{children:[]}});if(t.includes('ResourceGraph'))return j({data:[]});return j({displayName:'sub',tenantId:'MINE'});}) as typeof fetch;
  const result=await collectAzureWith(['00000000-0000-4000-8000-000000000001'],async()=>'t',request);
  assert.ok(result.hierarchy?.some(n=>n.name==='Mine'&&n.kind==='tenant'));
  assert.ok(!result.hierarchy?.some(n=>n.name==='Other'));
});
test('peering is not transitive unless a route or gateway transit allows it',async()=>{
  const {s,named}=await load(),m={resources:s.resources,links:s.links};
  const withoutUdr={resources:s.resources,links:s.links.filter(l=>l.kind!=='route')};
  assert.deepEqual(findPath(withoutUdr,named('web-01').id,[named('etl-01').id]),[],'spoke to spoke needs a router');
  assert.ok(findPath(m,named('web-01').id,[named('etl-01').id]).includes('azure:'+named('afw-hub').nativeId),'the UDR sends it through the hub firewall');
  assert.ok(findPath(m,named('dev-sandbox-01').id,[named('Seoul datacenter').id]).length>0,'gateway transit reaches on-prem');
  assert.ok(!reachable(m,ingressIds(s.resources)).has(named('vnet-partner-erp').id),'on-prem does not reach a plain peer of the hub');
});
test('public exposure needs both a public address and a wide inbound rule',async()=>{
  const {s}=await load(),names=exposures(s.resources,s.links).map(e=>e.resource.name);
  assert.ok(names.includes('dev-sandbox-01'));assert.ok(names.includes('alb-checkout')===false,'the ALB has no policy link in this fixture');
  assert.ok(!names.includes('web-01'));
});
test('route tables reach subnets and networks on every provider',async()=>{
  const {named}=await load();
  assert.ok(named('vpc-shared').routes.length>0);
  const s=await mockSnapshot('standard'),azure=s.resources.find(r=>r.kind==='subnet'&&r.provider==='azure'&&r.name==='web')!,aws=s.resources.find(r=>r.kind==='subnet'&&r.name==='app-a')!;
  assert.equal(azure.routes[0].nextHop,'afw-hub');assert.ok(aws.routes.some(r=>r.via==='Transit Gateway'));
});
test('history keeps the previous snapshot and diff reports what changed',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),store=new FileSnapshotStore(root),base=await mockSnapshot('single-vm');
  const live=(resources:typeof base.resources,collectedAt:string)=>({...base,mode:'live' as const,scenario:undefined,links:[],changes:undefined,collectedAt,resources:resources.map(r=>({...r,metrics:undefined,iam:[]}))});
  const first=live(base.resources,'2026-01-01T00:00:00.000Z');await store.save('aws',first);assert.equal(await store.previous('aws'),null);
  const next=base.resources.filter(r=>r.name!=='igw-main').map(r=>r.name==='web-server'?{...r,status:'stopped'}:r);
  await store.save('aws',live(next,'2026-01-02T00:00:00.000Z'));
  assert.equal((await readdir(path.join(root,'history','aws'))).length,1);
  const changes=diffResources((await store.previous('aws'))!.resources,(await store.latest('aws'))!.resources);
  assert.ok(changes.some(c=>c.kind==='removed'&&c.name==='igw-main'));
  assert.ok(changes.some(c=>c.kind==='changed'&&c.name==='web-server'&&c.detail.includes('stopped')));
  const merged=await liveSnapshot(store);assert.ok(merged?.changes?.items.length);
});
const withServer=async(env:Record<string,string|undefined>,run:(base:string)=>Promise<void>)=>{
  const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);for(const k in env)if(env[k]===undefined)delete process.env[k];
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));
  try{await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);}finally{server.close();for(const k in saved){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
};
test('live mode fails closed without access configuration',async()=>{
  await withServer({DATA_MODE:'live',ACCESS_TOKENS:undefined,ATLAS_LOOPBACK_ONLY:undefined},async base=>{assert.equal((await fetch(`${base}/api/topology`)).status,503);});
});
test('live mode requires a valid token and never accepts a bad one',async()=>{
  const token='test-only-token',tokenSha256=createHash('sha256').update(token).digest('hex'),root=await mkdtemp(path.join(tmpdir(),'atlas-'));
  await withServer({DATA_MODE:'live',SNAPSHOT_DIR:root,ACCESS_TOKENS:JSON.stringify([{name:'tester',tokenSha256,scopes:['*']}])},async base=>{
    assert.equal((await fetch(`${base}/api/topology`)).status,401);
    assert.equal((await fetch(`${base}/api/topology`,{headers:{Authorization:'Bearer wrong'}})).status,401);
    assert.equal((await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'wrong'})})).status,401);
    const login=await fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
    assert.equal((await fetch(`${base}/api/topology`,{headers:{Cookie:cookie.split(';')[0]}})).status,503,'authorized, but nothing collected yet');
  });
});
test('a restricted user receives only their scopes from the server',async()=>{
  const s=await mockSnapshot('standard'),sub=s.hierarchy.find(n=>n.name==='Platform Prod')!.scope!,r=restrictSnapshot(s,[sub]);
  assert.ok(r.resources.length>0);assert.ok(r.resources.every(x=>x.scope===sub));
  const ids=new Set(r.resources.map(x=>x.id));assert.ok(r.links.every(l=>ids.has(l.source)&&ids.has(l.target)));
  assert.ok(!r.hierarchy.some(n=>n.scope&&n.scope!==sub));assert.ok(r.hierarchy.some(n=>n.kind==='tenant'));
  assert.ok(!JSON.stringify(r).includes('commerce-prod'),'no other scope name leaks');
});
