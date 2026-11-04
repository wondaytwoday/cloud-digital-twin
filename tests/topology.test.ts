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
import {costSpikes,summarizeCost} from '../shared/cost.ts';
import {cidrOverlaps,hybridLinks,parseCidr,portMatches} from '../shared/network.ts';
import {findings} from '../shared/findings.ts';
import {normalizeAwsIam,normalizeAzureIam,normalizeGcpIam} from '../server/normalize.ts';
import {configureCollector,runCollection,toSnapshot,type CollectorDrivers} from '../server/runner.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {restrictSnapshot} from '../server/auth.ts';
import app,{liveSnapshot} from '../server/app.ts';
import {diffResources} from '../shared/diff.ts';
import {iconKey,groupIcon,providerLogo} from '../shared/iconKeys.ts';
import {scenarios} from '../shared/scenarios.ts';
import {buildScopeIndex,focusFor,iamInScope,inScope} from '../shared/hierarchy.ts';
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

test('discovery finds enabled Azure subscriptions across pages',async()=>{
  const j=(b:unknown)=>new Response(JSON.stringify(b));
  const request=(async(u:unknown)=>String(u).includes('page2')?j({value:[{subscriptionId:'b',state:'Enabled'}]}):j({value:[{subscriptionId:'a',state:'Enabled'},{subscriptionId:'x',state:'Disabled'}],nextLink:'https://management.azure.com/page2'})) as typeof fetch;
  assert.deepEqual(await discoverAzureSubscriptions(async()=>'t',request),['a','b']);
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
