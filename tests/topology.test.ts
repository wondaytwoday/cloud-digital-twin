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
import {accountRoles,azureCost,collectAwsAccount,collectAwsCost,collectAwsIam,collectAwsInventory,collectAzureWith,collectGcpAuto,collectGcpCost,costWindow,discoverAzureSubscriptions,parseAccounts} from '../server/collectors.ts';
import {billingCurrencies,convertTo,costSpikes,parseFx,summarizeCost} from '../shared/cost.ts';
import {cidrOverlaps,hybridLinks,parseCidr,portMatches} from '../shared/network.ts';
import {findings} from '../shared/findings.ts';
import {normalizeAwsIam,normalizeAzureIam,normalizeGcpIam} from '../server/normalize.ts';
import {checkCredentials,configureCollector,emptyStatus,explainAuth,liveStatus,needsCollection,readCollectionStatus,runCollection,toSnapshot,type CollectorDrivers} from '../server/runner.ts';
import {newStages,overallProgress,providerProgress} from '../shared/collect.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {restrictSnapshot} from '../server/auth.ts';
import app,{liveSnapshot} from '../server/app.ts';
import {diffResources} from '../shared/diff.ts';
import {GLYPH_KINDS,iconKey,groupIcon,providerLogo} from '../shared/iconKeys.ts';
import {scenarios} from '../shared/scenarios.ts';
import {buildScopeIndex,focusFor,iamInScope,inScope} from '../shared/hierarchy.ts';
const load=async()=>{const s=await mockSnapshot('standard'),named=(n:string)=>s.resources.find(r=>r.name===n)!;return{s,named,graph:{resources:s.resources,links:s.links}};};
test('fixtures survive pagination and normalization across every provider',async()=>{
  const {s,named}=await load();
  for(const n of ['vnet-hub','afw-hub','sql-platform','aks-platform','tgw-core','rds-orders','alb-checkout','vpc-shared','gke-analytics','sql-analytics','sandbox-01'])assert.ok(named(n),n);
  // A managed service is not inside the subnet: its private endpoint is, joined to it by private_link.
  const dataSubnet=s.resources.find(r=>r.kind==='subnet'&&r.name==='data'&&r.provider==='azure')!.id,pe=named('pe-sql-platform');
  assert.equal(named('sql-platform').parent,undefined);assert.equal(pe.kind,'endpoint');assert.equal(pe.parent,dataSubnet);assert.equal(pe.ip,'10.10.3.5');
  assert.ok(s.links.some(l=>l.kind==='private_link'&&l.source===pe.id&&l.target===named('sql-platform').id));
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
      else assert.ok(r.provider==='onprem'||r.kind==='external'||GLYPH_KINDS.has(r.kind)||r.type==='AWS::EC2::SecurityGroup'||r.type==='compute.googleapis.com/Subnetwork',`${id}: ${r.type} has no icon`);
    }
  }
  for(const key of [...Object.values(providerLogo),...Object.values(groupIcon).flatMap(v=>Object.values(v))])assert.ok(existsSync(`src/assets/csp-icons/${key}.svg`),key);
});
test('simple scenarios stay small; enterprise is large and multi-region',async()=>{
  assert.ok((await mockSnapshot('single-vm')).resources.filter(r=>r.kind!=='service').length<=6);
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
  assert.ok(names.includes('dev-sandbox-01'));assert.ok(names.includes('alb-checkout'),'an internet-facing ALB counts through its own security group');
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
  const live=(resources:typeof base.resources,collectedAt:string)=>({...base,mode:'live' as const,scenario:undefined,links:[],changes:undefined,activity:[],collectedAt,resources:resources.map(r=>({...r,metrics:undefined,iam:[]}))});
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

test('discovery finds enabled Azure subscriptions across pages',async()=>{
  const j=(b:unknown)=>new Response(JSON.stringify(b));
  const request=(async(u:unknown)=>String(u).includes('page2')?j({value:[{subscriptionId:'b',state:'Enabled'}]}):j({value:[{subscriptionId:'a',state:'Enabled'},{subscriptionId:'x',state:'Disabled'}],nextLink:'https://management.azure.com/page2'})) as typeof fetch;
  assert.deepEqual(await discoverAzureSubscriptions(async()=>'t',request),['a','b']);
});
test('Azure discovery names the fix for each way it fails',async()=>{
  const j=(b:unknown,status=200)=>(async()=>new Response(JSON.stringify(b),{status})) as unknown as typeof fetch;
  await assert.rejects(discoverAzureSubscriptions(async()=>'t',j({value:[]})),/Reader 역할/);
  await assert.rejects(discoverAzureSubscriptions(async()=>'t',j({value:[{subscriptionId:'a',state:'Disabled'}]})),/활성 상태가 아닙니다 \(Disabled\)/);
  await assert.rejects(discoverAzureSubscriptions(async()=>'t',j({error:{code:'InvalidAuthenticationTokenTenant',message:'wrong issuer'}},401)),/401 InvalidAuthenticationTokenTenant.*AZURE_TENANT_ID/);
  await assert.rejects(discoverAzureSubscriptions(async()=>'t',j({error:{code:'AuthorizationFailed'}},403)),/403 AuthorizationFailed/);
  const down=(async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ENOTFOUND'}});}) as unknown as typeof fetch;
  await assert.rejects(discoverAzureSubscriptions(async()=>'t',down),/ENOTFOUND.*HTTPS_PROXY/);
});
test('an unreadable Azure subscription is skipped, not fatal',async()=>{
  const j=(b:unknown,status=200)=>new Response(JSON.stringify(b),{status});
  const good='00000000-0000-4000-8000-000000000001',bad='00000000-0000-4000-8000-000000000002';
  const request=(async(u:unknown)=>{const t=String(u);if(t.includes(bad))return j({},403);if(t.includes('/tenants?'))return j({value:[]});if(t.includes('ResourceGraph'))return j({data:[]});return j({displayName:'ok',tenantId:'T'});}) as typeof fetch;
  const result=await collectAzureWith([good,bad],async()=>'t',request);
  assert.deepEqual(result.incomplete,[bad]);assert.ok(result.warnings.some(w=>w.includes(bad)));
  await assert.rejects(collectAzureWith([bad],async()=>'t',request));
});
test('a denied AWS service keeps everything else and marks the account incomplete',async()=>{
  const denied=Object.assign(new Error('not authorized'),{name:'AccessDeniedException'});
  const call=async(service:string,op:string)=>{if(service==='eks'||op==='DescribeDBInstances')throw denied;return op==='DescribeVpcs'?{Vpcs:[{VpcId:'vpc-1',CidrBlock:'10.0.0.0/16'}]}:{};};
  const result=await collectAwsAccount(call as any,'111','r');
  assert.equal(result.resources[0].name,'vpc-1');assert.deepEqual(result.incomplete,['111']);assert.match(result.warnings[0],/ListClusters.*|DescribeDBInstances/);
});
test('a service absent from a region is not a gap, and a dead credential still stops the run',async()=>{
  const absent=async(service:string)=>{if(service==='eks')throw Object.assign(new Error('getaddrinfo ENOTFOUND eks.x'),{name:'Error'});return {};};
  assert.equal((await collectAwsAccount(absent as any,'111','r')).incomplete,undefined);
  const expired=async()=>{throw Object.assign(new Error('expired'),{name:'ExpiredToken'});};
  await assert.rejects(collectAwsAccount(expired as any,'111','r'),/expired/);
});
test('GCP falls back to projects when the organization cannot be read',async()=>{
  const request=async(url:string)=>{
    if(url.includes('organizations:search'))return {organizations:[{name:'organizations/1'}]};
    if(url.includes('cloudresourcemanager.googleapis.com/v1/projects'))return {projects:[{projectId:'p1'},{projectId:'p2'}]};
    if(url.includes('/organizations/1/'))throw new Error('403 denied');
    if(url.includes('/projects/p2/'))throw new Error('Cloud Asset API disabled');
    const types=new URL(url).searchParams.getAll('assetTypes');
    return !types.length?{assets:[{name:'//compute.googleapis.com/projects/p1/global/networks/n',assetType:'compute.googleapis.com/Network',resource:{location:'global',data:{name:'n'}}}]}:{assets:[]};
  };
  const result=await collectGcpAuto(request);
  assert.deepEqual(result.resources.map(r=>r.name),['n']);assert.deepEqual(result.incomplete,['p2']);
});
test('per-project GCP collection still groups projects under their folders',async()=>{
  const request=async(url:string,init?:{method:string})=>{
    if(url.includes('organizations:search'))return {organizations:[]};
    if(url.includes(':getAncestry')){const p=url.match(/projects\/([^:]+):/)![1];if(p==='p3')throw new Error('403');return {ancestor:[{resourceId:{type:'project',id:p}},{resourceId:{type:'folder',id:p==='p1'?'11':'12'}},{resourceId:{type:'folder',id:'10'}},{resourceId:{type:'organization',id:'1'}}]};}
    if(url.includes('folders:search'))return {folders:[{name:'folders/10',displayName:'Production',parent:'organizations/1'},{name:'folders/11',displayName:'Apps',parent:'folders/10'}]};
    if(url.includes('/v3/folders/12'))return {name:'folders/12',displayName:'Data',parent:'folders/10'};
    if(url.includes('/v3/organizations/1'))throw new Error('403');
    if(url.includes('/v1/projects?'))return {projects:[{projectId:'p1',name:'App One'},{projectId:'p2'},{projectId:'p3',parent:{type:'folder',id:'11'}}]};
    void init;return {assets:[]};
  };
  const result=await collectGcpAuto(request as any),by=new Map(result.hierarchy!.map(n=>[n.id,n]));
  assert.equal(by.get('gcp:folders/11')?.name,'Apps');assert.equal(by.get('gcp:folders/11')?.parent,'gcp:folders/10');
  assert.equal(by.get('gcp:folders/12')?.name,'Data');assert.equal(by.get('gcp:folders/10')?.parent,'gcp:organizations/1');
  assert.equal(by.get('gcp:organizations/1')?.name,'조직 1');
  const project=(id:string)=>result.hierarchy!.find(n=>n.kind==='project'&&n.nativeId===id)!;
  assert.equal(project('p1').parent,'gcp:folders/11');assert.equal(project('p1').name,'App One');assert.equal(project('p2').parent,'gcp:folders/12');
  assert.equal(project('p3').parent,'gcp:folders/11','a project without ancestry keeps its direct parent');
  assert.ok(result.warnings.some(w=>/Browser/.test(w)),'missing names say which role fixes them');
});
test('listed accounts become read roles',()=>{
  assert.deepEqual(accountRoles(parseAccounts('two=222,333'),'AtlasReader'),[{label:'two',roleArn:'arn:aws:iam::222:role/AtlasReader'},{label:'333',roleArn:'arn:aws:iam::333:role/AtlasReader'}]);
});
const fakeResult=async(id:'web-tier'|'single-vm')=>{const s=await mockSnapshot(id);return{resources:s.resources.map(r=>({...r,metrics:undefined,iam:[]})),links:s.links.filter(l=>l.kind!=='simulation'),warnings:[],scopeLabels:s.scopeLabels,hierarchy:s.hierarchy};};
test('runner: clouds are independent and a failure keeps the last good snapshot',async()=>{
  const store=new FileSnapshotStore(await mkdtemp(path.join(tmpdir(),'atlas-')));let awsCalls=0;
  const drivers=(awsFails:boolean):CollectorDrivers=>({azure:{detect:async()=>'a',collect:()=>fakeResult('web-tier')},aws:{detect:async()=>'b',collect:async()=>{awsCalls++;if(awsFails)throw new Error('throttled');return fakeResult('single-vm');}},gcp:{detect:async()=>{throw new Error('Could not load the default credentials');},collect:async()=>{throw new Error('must not run');}}});
  configureCollector(drivers(false));
  let status=await runCollection(store);
  assert.equal(status.providers.azure.state,'ok');assert.equal(status.providers.aws.state,'ok');assert.equal(status.providers.gcp.state,'unauthenticated');
  const saved=(await store.latest('aws'))!.collectedAt;
  configureCollector(drivers(true));status=await runCollection(store);
  assert.equal(status.providers.aws.state,'failed');assert.equal((await store.latest('aws'))!.collectedAt,saved);assert.equal(awsCalls,2);
  assert.equal((await store.readStatus())?.running,false);
});
test('runner: overlapping requests share one run',async()=>{
  const store=new FileSnapshotStore(await mkdtemp(path.join(tmpdir(),'atlas-')));let calls=0;
  const driver={detect:async()=>'x',collect:async()=>{calls++;return fakeResult('web-tier');}};
  configureCollector({azure:driver,aws:{detect:async()=>{throw new Error('no');},collect:driver.collect},gcp:{detect:async()=>{throw new Error('no');},collect:driver.collect}});
  await Promise.all([runCollection(store),runCollection(store)]);assert.equal(calls,1);
});
test('gaps from a partial collection are not reported as deletions',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),store=new FileSnapshotStore(root),base=await fakeResult('single-vm'),scope=base.resources[0].scope;
  await store.save('aws',toSnapshot(base));
  const kept=base.resources.filter(r=>r.kind!=='compute'),ids=new Set(kept.map(r=>r.id));
  await store.save('aws',toSnapshot({...base,resources:kept,links:base.links.filter(l=>ids.has(l.source)&&ids.has(l.target)),incomplete:[scope]}));
  const merged=await liveSnapshot(store);
  assert.ok(!merged?.changes?.items.some(c=>c.kind==='removed'),'a read failure is not a deletion');
});
test('loopback mode serves only local hostnames',async()=>{
  await withServer({DATA_MODE:'live',ACCESS_TOKENS:undefined,ATLAS_LOOPBACK_ONLY:'1',SNAPSHOT_DIR:await mkdtemp(path.join(tmpdir(),'atlas-'))},async base=>{
    assert.equal((await fetch(`${base}/api/collect/status`)).status,200);
    const port=new URL(base).port;
    const http=await import('node:http');
    const status=await new Promise<number>(done=>{http.get({host:'127.0.0.1',port,path:'/api/collect/status',headers:{Host:'evil.example'}},r=>{r.resume();done(r.statusCode!);});});
    assert.equal(status,403,'DNS rebinding is refused');
  });
});

test('every AWS operation the collector calls exists in the installed SDK',async()=>{
  const [ec2,elb,rds,dx,eks,org,sts,awsIamSdk,ceSdk,rexSdk]=await Promise.all([import('@aws-sdk/client-ec2'),import('@aws-sdk/client-elastic-load-balancing-v2'),import('@aws-sdk/client-rds'),import('@aws-sdk/client-direct-connect'),import('@aws-sdk/client-eks'),import('@aws-sdk/client-organizations'),import('@aws-sdk/client-sts'),import('@aws-sdk/client-iam'),import('@aws-sdk/client-cost-explorer'),import('@aws-sdk/client-resource-explorer-2')]);
  const uses:[Record<string,unknown>,string[]][]=[[ec2,['DescribeRegions','DescribeVpcs','DescribeSubnets','DescribeInstances','DescribeSecurityGroups','DescribeInternetGateways','DescribeNatGateways','DescribeTransitGateways','DescribeTransitGatewayVpcAttachments','DescribeTransitGatewayPeeringAttachments','DescribeVpcPeeringConnections','DescribeRouteTables','DescribeVpnGateways','DescribeVpnConnections','DescribeInstanceTypes']],[elb,['DescribeLoadBalancers','DescribeTargetGroups','DescribeTargetHealth']],[rds,['DescribeDBInstances']],[dx,['DescribeDirectConnectGateways','DescribeDirectConnectGatewayAssociations']],[eks,['ListClusters','DescribeCluster']],[org,['DescribeOrganization','ListRoots','ListAccountsForParent','ListOrganizationalUnitsForParent']],[sts,['GetCallerIdentity','AssumeRole']],[awsIamSdk,['ListUsers','ListAttachedUserPolicies','ListGroupsForUser','ListAttachedGroupPolicies','ListMFADevices','ListAccessKeys','ListRoles','ListAttachedRolePolicies']],[ceSdk,['GetCostAndUsage']],[rexSdk,['ListResources']]];
  for(const [module,operations] of uses)for(const op of operations)assert.equal(typeof module[`${op}Command`],'function',op);
});

const NOW=new Date(Date.UTC(2026,10,15));
const row=(month:string,amount:number,over:Partial<{provider:'aws'|'azure'|'gcp';scope:string;service:string;currency:string}>={})=>({provider:'aws' as const,scope:'a',service:'S',month,amount,currency:'USD',...over});
test('cost: a partial month is projected, not compared raw',()=>{
  const s=summarizeCost([row('2026-09',1000),row('2026-10',1200),row('2026-11',600)],NOW);
  assert.equal(s.currentMonth,'2026-11');assert.equal(s.currentTotal,600);assert.equal(s.previousTotal,1200);assert.equal(s.projected,1200,'half the month spent projects to double');
  assert.equal(s.services[0].change,.2,'service change compares the last two complete months');
});
test('cost: mixed currencies are never added into one headline',()=>{
  const s=summarizeCost([row('2026-10',100),row('2026-10',100,{currency:'KRW',provider:'gcp'})],NOW);
  assert.equal(s.mixed,true);assert.equal(s.currency,null);
});
test('cost: mixed currencies are totalled per currency until a rate is set, then in one',()=>{
  const rows=[row('2026-10',100),row('2026-10',150_000,{currency:'KRW',provider:'azure'}),row('2026-11',50),row('2026-11',70_000,{currency:'KRW',provider:'azure'})];
  const raw=summarizeCost(rows,NOW);
  assert.deepEqual(raw.currencyTotals,[{currency:'KRW',current:70_000,previous:150_000},{currency:'USD',current:50,previous:100}]);
  const fx=parseFx({ATLAS_COST_CURRENCY:'krw',ATLAS_FX_RATES:'USD=1400, bad, EUR=-1'})!;
  assert.deepEqual(fx,{base:'KRW',rates:{USD:1400},source:'ATLAS_FX_RATES'});
  const one=summarizeCost(rows,NOW,fx);
  assert.equal(one.mixed,false);assert.equal(one.currency,'KRW');assert.deepEqual(one.converted,['USD']);
  assert.equal(one.currentTotal,70_000+50*1400);assert.equal(one.previousTotal,150_000+100*1400);
  assert.equal(parseFx({}),undefined,'no rates, no conversion');
  assert.deepEqual(billingCurrencies(rows),[{provider:'aws',currencies:['USD']},{provider:'azure',currencies:['KRW']}]);
});
test('cost: the chosen currency is the only one shown, either way round',()=>{
  const rows=[row('2026-10',100),row('2026-10',140_000,{currency:'KRW',provider:'azure'}),row('2026-10',5,{currency:'EUR',provider:'gcp'})];
  const fx={base:'KRW',rates:{USD:1400},source:'t'};
  const krw=summarizeCost(rows,NOW,fx,'KRW'),usd=summarizeCost(rows,NOW,fx,'USD');
  assert.equal(krw.currency,'KRW');assert.equal(krw.mixed,false);assert.equal(krw.currentTotal,280_000);
  assert.equal(usd.currency,'USD');assert.equal(usd.currentTotal,200);
  assert.deepEqual(krw.dropped,[{currency:'EUR',providers:['gcp'],count:1}],'a currency without a rate is left out and reported');
  assert.equal(convertTo(rows,'USD').rows.length,1,'no rates: only rows already in USD');
});
test('cost spikes use a floor that fits the currency',()=>{
  const krw=[row('2026-09',1000,{currency:'KRW'}),row('2026-10',2000,{currency:'KRW'}),row('2026-09',1_000_000,{currency:'KRW',service:'big'}),row('2026-10',2_000_000,{currency:'KRW',service:'big'})];
  assert.deepEqual(costSpikes(krw,NOW).map(x=>[x.service,x.currency]),[['big','KRW']],'a 1,000 KRW rise is noise');
});
test('cost spikes ignore the partial current month and small noise',()=>{
  const rows=[row('2026-09',1000),row('2026-10',1800),row('2026-11',100),row('2026-09',10,{service:'small'}),row('2026-10',40,{service:'small'})];
  const spikes=costSpikes(rows,NOW);assert.equal(spikes.length,1);assert.equal(spikes[0].service,'S');assert.ok(Math.abs(spikes[0].change-.8)<1e-9);
});
test('cost window spans six calendar months through today',()=>{assert.deepEqual(costWindow(NOW),{start:'2026-06-01',end:'2026-11-16'});});
test('provider cost responses normalize to one row shape',async()=>{
  const j=(b:unknown,status=200)=>new Response(JSON.stringify(b),{status});
  const request=(async(u:unknown)=>String(u).includes('bad')?j({},403):j({properties:{columns:[{name:'Cost'},{name:'BillingMonth'},{name:'ServiceName'},{name:'Currency'}],rows:[[12.5,'2026-10-01T00:00:00','Storage','KRW']]}})) as typeof fetch;
  const azure=await azureCost(['good','bad'],async()=>'t',request,NOW);
  assert.deepEqual(azure.rows,[{provider:'azure',scope:'good',service:'Storage',month:'2026-10',amount:12.5,currency:'KRW'}]);assert.deepEqual(azure.failed,['bad']);
  let pages=0;const aws=await collectAwsCost((async()=>({ResultsByTime:[{TimePeriod:{Start:'2026-10-01'},Groups:[{Keys:['111','EC2'],Metrics:{UnblendedCost:{Amount:'3.5',Unit:'USD'}}}]}],...(pages++===0?{NextPageToken:'n'}:{})})) as any,NOW);
  assert.equal(aws.length,2,'follows pagination');assert.equal(aws[0].scope,'111');
  const gcp=await collectGcpCost(async()=>({jobComplete:true,rows:[{f:[{v:'202610'},{v:'p1'},{v:'BigQuery'},{v:'USD'},{v:'9.5'}]}]}),'proj.ds.tbl',NOW);
  assert.deepEqual(gcp,[{provider:'gcp',scope:'p1',service:'BigQuery',month:'2026-10',amount:9.5,currency:'USD'}]);
  await assert.rejects(collectGcpCost(async()=>({}),'bad; DROP',NOW),/형식/);
});
test('IAM: privilege, external trust, and public members are detected per provider',()=>{
  const azure=normalizeAzureIam([{id:'/x/roleDefinitions/g1',type:'microsoft.authorization/roledefinitions',properties:{roleName:'Owner'}},{id:'/subscriptions/s/a1',type:'microsoft.authorization/roleassignments',properties:{principalId:'P',principalType:'User',scope:'/subscriptions/s',roleDefinitionId:'/subscriptions/s/roleDefinitions/G1'}}],new Map([['p','kim@x']]));
  assert.deepEqual([azure[0].principal,azure[0].role,azure[0].scope,azure[0].privileged,azure[0].level],['kim@x','Owner','s',true,'scope']);
  const aws=normalizeAwsIam({users:[{UserName:'u',mfa:false,policies:[{PolicyName:'AdministratorAccess'}],keys:[{Status:'Active',CreateDate:'2025-01-01'},{Status:'Inactive',CreateDate:'2020-01-01'}]}],roles:[{RoleName:'r',AssumeRolePolicyDocument:encodeURIComponent(JSON.stringify({Statement:[{Principal:{AWS:'arn:aws:iam::999999999999:root'}}]})),policies:[{PolicyName:'ReadOnlyAccess'}]},{RoleName:'mine',AssumeRolePolicyDocument:encodeURIComponent(JSON.stringify({Statement:[{Principal:{AWS:'arn:aws:iam::111111111111:root'}}]})),policies:[{PolicyName:'ReadOnlyAccess'}]}]},'111111111111',Date.parse('2026-01-01'));
  assert.equal(aws[0].privileged,true);assert.equal(aws[0].keyAgeDays,365,'inactive keys do not count');assert.equal(aws[1].external,true);assert.equal(aws[2].external,false);
  const gcp=normalizeGcpIam([{name:'//cloudresourcemanager.googleapis.com/projects/123',assetType:'cloudresourcemanager.googleapis.com/Project',iamPolicy:{bindings:[{role:'roles/viewer',members:['allUsers','user:a@corp.example','user:b@other.example']}]}}],new Map([['123','my-proj']]),undefined,'corp.example');
  assert.deepEqual(gcp.map(g=>[g.principalType,g.external,g.scope]),[['public',true,'my-proj'],['user',false,'my-proj'],['user',true,'my-proj']]);
});
test('Resource Explorer fills the inventory without duplicating described types',async()=>{
  const call=(async()=>({Resources:[{Arn:'arn:aws:s3:::b',ResourceType:'s3:bucket',Region:'r',OwningAccountId:'1'},{Arn:'arn:aws:ec2:r:1:vpc/v',ResourceType:'ec2:vpc',Region:'r',OwningAccountId:'1'}]})) as any;
  const {rows}=await collectAwsInventory(call);assert.equal(rows.length,1);
  const merged=finish([{resources:[],links:[],warnings:[],scopeLabels:{},awsInventory:{account:'1',rows}}]);
  assert.deepEqual(merged.resources.map(r=>[r.name,r.kind,r.scope]),[['b','service','1']]);
  const denied=await collectAwsInventory((async()=>{throw Object.assign(new Error('x'),{name:'UnauthorizedException'});}) as any);
  assert.equal(denied.rows.length,0);assert.match(denied.warning!,/Resource Explorer/);
});
test('AWS IAM failure is a warning, not a lost account',async()=>{
  const {iam,warning}=await collectAwsIam((async()=>{throw Object.assign(new Error('no'),{name:'AccessDenied'});}) as any,'1');
  assert.deepEqual(iam,[]);assert.match(warning!,/AccessDenied/);
});
test('network helpers: CIDR math, overlaps across networks only, port matching',async()=>{
  assert.deepEqual(parseCidr('10.0.0.0/24'),{from:167772160,to:167772415});assert.equal(parseCidr('nope'),null);assert.equal(parseCidr('300.0.0.0/8'),null);
  const s=await mockSnapshot('standard'),overlaps=cidrOverlaps(s.resources);
  assert.ok(overlaps.some(o=>[o.a.name,o.b.name].includes('vpc-dev')&&[o.a.name,o.b.name].includes('sandbox')),'the planted overlap is found');
  assert.ok(!overlaps.some(o=>o.a.parent===o.b.id||o.b.parent===o.a.id),'a subnet does not overlap its own network');
  assert.equal(hybridLinks(s.resources,s.links).length,3);
  assert.ok(portMatches('443',443));assert.ok(portMatches('22, 443',22));assert.ok(portMatches('8000–9000',8443));assert.ok(portMatches('All',1));assert.ok(!portMatches('443',80));
});
test('findings cover every domain, ordered by severity, with a way to act',async()=>{
  const s=await mockSnapshot('enterprise'),list=findings(s);
  for(const c of ['infra','network','iam','cost'])assert.ok(list.some(f=>f.category===c),c);
  const order=['critical','high','medium','info'],ranks=list.map(f=>order.indexOf(f.severity));assert.deepEqual(ranks,[...ranks].sort((a,b)=>a-b));
  assert.equal(new Set(list.map(f=>f.id)).size,list.length);
});
test('scope restriction also covers cost and IAM',async()=>{
  const s=await mockSnapshot('standard'),sub=s.hierarchy.find(n=>n.name==='Platform Prod')!.scope!,r=restrictSnapshot(s,[sub]);
  assert.ok(r.cost.length>0&&r.cost.every(c=>c.scope===sub));assert.ok(r.iam.length>0&&r.iam.every(a=>a.scope===sub));
});
test('every scenario has cost and IAM flowing through the collectors, and inventory beyond the network',async()=>{
  for(const {id} of scenarios){const s=await mockSnapshot(id);assert.ok(s.cost.length>0,`${id} cost`);assert.ok(s.iam.length>0,`${id} iam`);assert.ok(s.resources.some(r=>r.kind==='service'),`${id} service`);}
  const gcp=await mockSnapshot('standard');assert.ok(gcp.iam.some(a=>a.provider==='gcp'&&a.scope==='atlas-sandbox'&&a.external),'project numbers resolve to project IDs');
});
test('cost APIs run at most daily; other runs keep the last figures',async()=>{
  const store=new FileSnapshotStore(await mkdtemp(path.join(tmpdir(),'atlas-')));const flags:(boolean|undefined)[]=[];
  const cost=[row('2026-10',5)];
  const driver={detect:async()=>'x',collect:async(o:{withCost?:boolean})=>{flags.push(o.withCost);const base=await fakeResult('web-tier');return{...base,cost:o.withCost?cost:undefined};}},off={detect:async()=>{throw new Error('no');},collect:driver.collect};
  configureCollector({azure:driver,aws:off,gcp:off});
  await runCollection(store);await runCollection(store);
  assert.deepEqual(flags,[true,false]);assert.deepEqual((await store.latest('azure'))!.cost,cost);
});

test('findings: admin ports outrank a public load balancer, and repeats across accounts collapse',async()=>{
  const s=await mockSnapshot('enterprise'),list=findings(s),by=(text:string)=>list.filter(f=>f.title.includes(text));
  assert.equal(by('dev-kr-web-01')[0]?.severity,'critical','SSH open to the internet on a public VM');
  assert.equal(by('alb-checkout-prod')[0]?.severity,'info','HTTPS on a public LB is usually the design');
  assert.equal(by('legacy-admin 특권 사용자 MFA 없음').length,1);assert.match(by('legacy-admin 특권 사용자 MFA 없음')[0].detail,/범위 \d+개/);
});
test('focus: a group covers its leaves, and a leaf inherits assignments from above but not from siblings',async()=>{
  const s=await mockSnapshot('enterprise'),index=buildScopeIndex(s.hierarchy,s.resources);
  const group=s.hierarchy.find(n=>n.kind==='managementGroup'&&index.scopesUnder(n.id).length>1)!,leaf=index.scopesUnder(group.id)[0],focus=focusFor(index,group.id),one=focusFor(index,`azure:scope:${leaf}`);
  assert.equal(focus.provider,'azure');assert.ok(inScope(focus,'azure',leaf));assert.ok(!inScope(focus,'aws',leaf));assert.ok(!inScope(focus,'azure','elsewhere'));
  const row={provider:'azure'} as const;
  assert.ok(iamInScope(one,{...row,scope:group.nativeId,level:'group'}),'parent group reaches the leaf');
  assert.ok(iamInScope(one,{...row,scope:'tenant',level:'org'}),'org level reaches everything in that cloud');
  assert.ok(!iamInScope(one,{provider:'gcp',scope:'x',level:'org'}),'another cloud does not');
  const sibling=s.hierarchy.find(n=>n.kind==='managementGroup'&&n.parent===group.parent&&n.id!==group.id);
  if(sibling)assert.ok(!iamInScope(focusFor(index,group.id),{...row,scope:sibling.nativeId,level:'group'}),'a sibling group does not');
  assert.ok(iamInScope(one,{...row,scope:'not-in-the-tree',level:'group'}),'an unplaceable group stays visible');
  const providerOnly=focusFor(index,'provider:aws');assert.equal(providerOnly.scopes,null);assert.equal(focusFor(index,'all').provider,'all');
});
test('findings narrow with the focus, and an overlap stays visible from either side',async()=>{
  const s=await mockSnapshot('enterprise'),index=buildScopeIndex(s.hierarchy,s.resources),all=findings(s);
  const aws=findings(s,undefined,focusFor(index,'provider:aws'));
  assert.ok(aws.length>0&&aws.length<all.length);assert.ok(aws.every(f=>!f.provider||f.provider==='aws'));
  const o=cidrOverlaps(s.resources)[0];assert.ok(o,'fixture has an overlap');
  for(const side of [o.a,o.b]){const list=findings(s,undefined,focusFor(index,`${side.provider}:scope:${side.scope}`));assert.ok(list.some(f=>f.id===`overlap:${o.a.id}:${o.b.id}`));}
  const leaf=s.hierarchy.find(n=>n.scope&&s.iam.some(a=>a.scope===n.scope&&a.privileged))!,scoped=findings(s,undefined,focusFor(index,leaf.id));
  assert.ok(scoped.length<all.length);assert.ok(scoped.filter(f=>f.scope).every(f=>f.scope===leaf.scope||s.iam.some(a=>a.level!=='scope'&&a.scope===f.scope)));
});
test('env files fill gaps but never override the shell, and Vercel tokens stay out',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'atlas-env-')),{writeFile}=await import('node:fs/promises'),{loadEnvFiles}=await import('../server/env.ts');
  await writeFile(path.join(dir,'.env'),'AZURE_CLIENT_ID=from-env\nAZURE_TENANT_ID=from-env\nAWS_PROFILE=from-env\n');await writeFile(path.join(dir,'.env.local'),'AZURE_TENANT_ID=from-local\nVERCEL_OIDC_TOKEN=secret\n');
  const env:NodeJS.ProcessEnv={AWS_PROFILE:'from-shell'};loadEnvFiles(env,[path.join(dir,'.env.local'),path.join(dir,'.env'),path.join(dir,'.missing')]);
  assert.equal(env.AWS_PROFILE,'from-shell');assert.equal(env.AZURE_TENANT_ID,'from-local');assert.equal(env.AZURE_CLIENT_ID,'from-env');assert.equal(env.VERCEL_OIDC_TOKEN,undefined);
});
test('a restart collects again whenever a cloud has no good result yet',()=>{
  const at=new Date(1_000_000_000).toISOString(),soon=1_000_000_000+60_000,ok={state:'ok' as const},status=(gcp:'ok'|'unauthenticated'|'failed')=>({running:false,finishedAt:at,providers:{azure:ok,aws:ok,gcp:{state:gcp}}});
  assert.equal(needsCollection(null,60,soon),true,'never collected');
  assert.equal(needsCollection(status('ok'),60,soon),false,'recent and complete');
  assert.equal(needsCollection(status('unauthenticated'),60,soon),true,'credentials were just added');
  assert.equal(needsCollection(status('failed'),60,soon),true);
  assert.equal(needsCollection(status('ok'),60,soon+3_600_000),true,'stale');
});
test('sign-in failures say what to change',()=>{
  const azureEnv={AZURE_TENANT_ID:'t',AZURE_CLIENT_ID:'c',AZURE_CLIENT_SECRET:'s'};
  assert.match(explainAuth('azure',new Error('x'),{AZURE_TENANT_ID:'t'}),/AZURE_CLIENT_ID, AZURE_CLIENT_SECRET/);
  assert.match(explainAuth('azure',new Error('ChainedTokenCredential authentication failed.\nClientSecretCredential: AADSTS7000215: Invalid client secret'),azureEnv),/비밀 ID가 아닌 비밀 값/);
  assert.match(explainAuth('azure',new Error('ChainedTokenCredential authentication failed.'),{}),/az login/);
  assert.match(explainAuth('aws',new Error('x'),{AWS_ACCESS_KEY_ID:'a'}),/함께 설정/);
  assert.match(explainAuth('aws',new Error('The provided authorization grant is invalid, expired, revoked, or malformed'),{}),/aws login/);
  assert.match(explainAuth('aws',new Error('Could not load credentials from any providers'),{AWS_PROFILE:'p'}),/프로필 p/);
  assert.match(explainAuth('gcp',new Error('x'),{GOOGLE_APPLICATION_CREDENTIALS:'/no/such/file.json'}),/파일을 찾지 못했습니다/);
  assert.match(explainAuth('gcp',new Error('Could not load the default credentials.'),{}),/gcloud auth/);
});
test('runner: progress names the current stage, skips cost by policy, and settles every stage',async()=>{
  const store=new FileSnapshotStore(await mkdtemp(path.join(tmpdir(),'atlas-')));let seen:string[]=[];
  const collect=async({report}:any)=>{report('scopes',{state:'done',detail:'구독 1개'});report('resources',{detail:'자원 5개 읽음',done:1,total:2});seen=liveStatus()?.providers.azure.stages?.map(s=>`${s.id}:${s.state}`)??[];assert.equal(liveStatus()?.running,true);assert.equal(liveStatus()?.providers.azure.stages?.find(s=>s.id==='resources')?.detail,'자원 5개 읽음');return fakeResult('web-tier');};
  const none={detect:async()=>{throw new Error('Could not load credentials from any providers');},collect:async()=>{throw new Error('must not run');}};
  configureCollector({azure:{detect:async()=>'a',collect},aws:none,gcp:{detect:async()=>'g',collect:async()=>{throw new Error('boom');}}});
  const status=await runCollection(store,()=>{}),stages=(p:'azure'|'aws'|'gcp')=>Object.fromEntries(status.providers[p].stages!.map(s=>[s.id,s.state]));
  assert.ok(seen.includes('auth:done'));assert.equal(status.pid,process.pid);assert.ok(status.startedAt);
  assert.deepEqual(stages('azure'),{auth:'done',scopes:'done',resources:'done',iam:'done',activity:'done',cost:'done',save:'done'});
  assert.deepEqual(stages('aws'),{auth:'failed',scopes:'skipped',resources:'skipped',iam:'skipped',activity:'skipped',cost:'skipped',save:'skipped'});
  assert.match(status.providers.aws.message!,/자격 증명을 찾지 못했습니다/);assert.equal(status.providers.gcp.state,'failed');
  assert.equal(providerProgress(status.providers.aws.stages),1,'a skipped cloud does not hold the bar back');assert.equal(overallProgress(status)>.9,true);
  configureCollector({azure:{detect:async()=>'a',collect:()=>fakeResult('web-tier')},aws:none,gcp:none});
  const again=await runCollection(store);assert.equal(again.providers.azure.stages?.find(s=>s.id==='cost')?.state,'skipped','cost ran moments ago');
});
test('a status left by a killed process does not read as running forever',async()=>{
  const store=new FileSnapshotStore(await mkdtemp(path.join(tmpdir(),'atlas-'))),base=emptyStatus();
  base.providers.aws={state:'running',stages:newStages('aws').map(s=>s.id==='auth'?{...s,state:'running' as const}:s)};
  await store.writeStatus({...base,running:true,pid:2_147_483_000});
  const read=await readCollectionStatus(store);assert.equal(read.running,false);assert.equal(read.providers.aws.state,'failed');assert.equal(read.providers.aws.stages?.[0].state,'failed');assert.equal(read.providers.aws.stages?.[1].state,'skipped');
  await store.writeStatus({...base,running:true,pid:process.pid});assert.equal((await readCollectionStatus(store)).running,true,'a live process is left alone');
});
test('collectors report progress through a real page walk',async()=>{
  const events:string[]=[],report=(id:string,p:any={})=>events.push(`${id}:${p.state??'running'}:${p.detail??''}`);
  const request=(async()=>new Response(JSON.stringify({data:[],displayName:'S',tenantId:'t',value:[],properties:{columns:[],rows:[]}}),{status:200})) as typeof fetch;
  await collectAzureWith(['00000000-0000-4000-8000-000000000001'],async()=>'t',request,{report:report as any});
  for(const want of ['scopes:running:구독 접근 확인','scopes:done:구독 1개','resources:running:Resource Graph 조회','resources:running:자원 0개 읽음','resources:done:자원 0개','iam:done:할당 0건','cost:done:0행'])assert.ok(events.includes(want),want);
  events.length=0;
  const gcp=async(url:string)=>url.includes('organizations:search')?{organizations:[]}:url.includes('/projects?')?{projects:[{projectId:'p1'}]}:{assets:[]};
  await collectGcpAuto(gcp as any,{report:report as any});
  for(const want of ['scopes:done:프로젝트 1개','resources:running:projects/p1 · 자원 0개 읽음','iam:running:projects/p1','resources:done:범위 1개','cost:skipped:ATLAS_GCP_BILLING_TABLE 미설정'])assert.ok(events.includes(want),want);
});
test('the credential check reports a sign-in that sees no scope as not connected',async()=>{
  const collect=async()=>{throw new Error('unused');},none={detect:async()=>{throw new Error('Could not load credentials');},collect};
  configureCollector({azure:{detect:async()=>'Azure 자격 증명',scope:async()=>{throw new Error('Azure: 역할이 할당된 구독이 없습니다.');},collect},aws:none,gcp:{detect:async()=>'g',scope:async()=>'프로젝트 2개',collect}});
  const r=Object.fromEntries((await checkCredentials()).map(x=>[x.provider,x]));
  assert.equal(r.azure.ok,false);assert.match(r.azure.detail,/로그인됨 \(Azure 자격 증명\).*역할이 할당된 구독이 없습니다/);
  assert.equal(r.gcp.ok,true);assert.equal(r.gcp.detail,'g · 프로젝트 2개');
  configureCollector();
});
