import test from 'node:test';
import assert from 'node:assert/strict';
import {mockSnapshot} from '../server/mock.ts';
import {existsSync} from 'node:fs';
import {adjacency,findPath,impactOf,ingressIds,health} from '../shared/topology.ts';
import {iconKey,groupIcon,providerLogo} from '../shared/iconKeys.ts';
import {scenarios} from '../shared/scenarios.ts';
import {buildScopeIndex} from '../shared/hierarchy.ts';
const load=async()=>{const s=await mockSnapshot('standard'),named=(n:string)=>s.resources.find(r=>r.name===n)!;return{s,named,graph:adjacency(s.resources,s.links)};};
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
  const {s,graph}=await load();
  for(const r of s.resources)if(r.kind==='firewall')assert.ok(!graph.has(r.id));
});
test('status maps to health without treating unknown text as healthy',()=>{
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
  assert.ok(impactOf(s.resources,s.links,named('vgw-hub-jp').id).lost.length===0,'JP stays reachable through the KR hub peering');
});
test('TGW peering crosses regions and partner peers stay visible',async()=>{
  const s=await mockSnapshot('enterprise'),named=(n:string)=>s.resources.find(r=>r.name===n)!;
  assert.ok(s.links.some(l=>l.kind==='peering'&&[l.source,l.target].includes(named('tgw-core-kr').id)&&[l.source,l.target].includes(named('tgw-core-jp').id)));
  for(const n of ['vnet-partner-settlement','vpc-partner-analytics','vpc-partner-exchange'])assert.equal(named(n).kind,'external',n);
});
test('scenarios without on-prem have no impact analysis target but still trace',async()=>{
  const s=await mockSnapshot('web-tier');
  assert.deepEqual(ingressIds(s.resources),[]);
  const g=adjacency(s.resources,s.links),named=(n:string)=>s.resources.find(r=>r.name===n)!;
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
