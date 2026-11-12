import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import type {AddressInfo} from 'node:net';
import app,{liveSnapshot} from '../server/app.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {snapshotCache} from '../server/snapshot-cache.ts';
import {compactInventory} from '../server/inventory.ts';
import {RequestGate} from '../server/request-gate.ts';
import {requestAdvice} from '../server/request-error.ts';
import {fetchRetry} from '../server/async.ts';
import {collectGcpAuto,discoverAzureSubscriptions} from '../server/collectors.ts';
import {configureCollector,runCollection,toSnapshot} from '../server/runner.ts';
import {finish,normalizeAws,normalizeAzure,normalizeAzureIam,normalizeGcp,normalizeGcpIam} from '../server/normalize.ts';
import {ResourceSchema,validateSnapshot,type Resource} from '../shared/schema.ts';
import {projectSnapshot} from '../shared/presentation.ts';
import {restrictSnapshot} from '../server/auth.ts';
import {exposures,adjacency} from '../shared/topology.ts';
import {classifyResource,collectionTier} from '../shared/classification.ts';

const resource=(id='vm',extra:Partial<Resource>={})=>ResourceSchema.parse({id:`aws:${id}`,nativeId:id,name:id,provider:'aws',kind:'compute',scope:'111111111111',region:'r',type:'AWS::EC2::Instance',source:'fake',...extra});
const normalized=(resources:Resource[]=[resource()])=>({resources,links:[],warnings:[],scopeLabels:{},collectedScopes:['111111111111']});
async function env<T>(values:Record<string,string|undefined>,work:()=>Promise<T>){const old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));for(const [k,v] of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;try{return await work();}finally{for(const [k,v] of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;}}
async function withStore(work:(store:FileSnapshotStore,root:string)=>Promise<void>){const root=await mkdtemp(path.join(tmpdir(),'atlas-six-'));try{await work(new FileSnapshotStore(root),root);}finally{configureCollector();await rm(root,{recursive:true,force:true});}}
const off={detect:async()=>{throw new Error('fake missing credentials');},collect:async()=>normalized()};

test('file revisions invalidate merged caches, concurrent reads share work, and failed builds are retried',async()=>withStore(async(store,root)=>{
  let calls=0;const cached=snapshotCache(async s=>{calls++;await pause(2);return s.latest('aws');});
  await store.save('aws',toSnapshot(normalized()));
  const [a,b]=await Promise.all([cached(store),cached(store)]);assert.equal(a,b);assert.equal(calls,1);
  await cached(store);assert.equal(calls,1);
  const next=toSnapshot(normalized([resource('new')]));await writeFile(path.join(root,'aws.json'),JSON.stringify(next));
  assert.equal((await cached(store))?.resources[0].name,'new');assert.equal(calls,2);
  await writeFile(path.join(root,'aws.json'),'invalid');await assert.rejects(cached(store));await assert.rejects(cached(store));assert.equal(calls,4);
}));

test('compact JSON and daily history bound repeated same-day collections while keeping the previous revision',async()=>withStore(async(store,root)=>{
  for(let i=0;i<12;i++)await store.save('aws',{...toSnapshot(normalized()),collectedAt:`2026-11-10T00:${String(i).padStart(2,'0')}:00.000Z`});
  const raw=await readFile(path.join(root,'aws.json'),'utf8');assert.equal(raw.includes('\n  '),false);
  assert.equal((await store.previous('aws'))!.collectedAt,'2026-11-10T00:10:00.000Z');
  assert.ok((await readdir(path.join(root,'history','aws'))).length<=3);
}));

test('HTTP compression and private ETags keep authentication, scope isolation and file invalidation',async()=>withStore(async(store,root)=>{
  const snapshot=toSnapshot(normalized([resource('allowed',{specs:{value:'a'.repeat(4000)}}),resource('secret',{scope:'222222222222'})]));
  await store.save('aws',snapshot);
  const tokens=JSON.stringify(['a','b'].map((token,i)=>({name:`fake-${token}`,tokenSha256:createHash('sha256').update(token).digest('hex'),scopes:[i?'222222222222':'111111111111']})));
  await env({DATA_MODE:'live',SNAPSHOT_DIR:root,ACCESS_TOKENS:tokens},async()=>{
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/topology`;
    try{
      const first=await fetch(url,{headers:{Authorization:'Bearer a','Accept-Encoding':'gzip'}}),etag=first.headers.get('etag')!;
      assert.equal(first.headers.get('content-encoding'),'gzip');assert.match(first.headers.get('cache-control')!,/private/);
      assert.doesNotMatch(JSON.stringify(await first.json()),/secret/);
      assert.equal((await fetch(url,{headers:{Authorization:'Bearer a','If-None-Match':etag}})).status,304);
      assert.equal((await fetch(url,{headers:{'If-None-Match':etag}})).status,401);
      const other=await fetch(url,{headers:{Authorization:'Bearer b','If-None-Match':etag}});assert.equal(other.status,200);assert.doesNotMatch(JSON.stringify(await other.json()),/allowed/);
      const full=await (await fetch(`${url}?part=map&transport=1`,{headers:{Authorization:'Bearer a'}})).json();
      assert.ok(full.snapshot);assert.match(full.revision,/^[a-f0-9]{64}$/);
      const reused=await (await fetch(`${url}?part=network&transport=1&base=${full.revision}`,{headers:{Authorization:'Bearer a'}})).json();
      assert.ok(reused.metadata);assert.equal(reused.snapshot,undefined);assert.equal(reused.metadata.resources,undefined);
      const isolated=await (await fetch(`${url}?part=network&transport=1&base=${full.revision}`,{headers:{Authorization:'Bearer b'}})).json();
      assert.ok(isolated.snapshot);assert.doesNotMatch(JSON.stringify(isolated),/allowed/);
      assert.equal((await fetch(`${url}?part=network&transport=1&base=${full.revision}`)).status,401);
      const small=await fetch(`${url}?part=scopes`,{headers:{Authorization:'Bearer a'}}),summary=await small.json();assert.deepEqual(summary.resources,[]);assert.equal(summary.presentation.scopeStats['111111111111'].resources,1);assert.equal(summary.presentation.scopeStats['222222222222'],undefined);
      await store.save('aws',toSnapshot(normalized([resource('changed')])));
      const changed=await fetch(url,{headers:{Authorization:'Bearer a','If-None-Match':etag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);
    }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  });
}));

test('page projections omit unrelated payloads without weakening full snapshot validation',()=>{
  const full=toSnapshot(normalized());full.cost=[{provider:'aws',scope:'111111111111',service:'fake',month:'2026-11',amount:1,currency:'USD'}];
  assert.deepEqual(projectSnapshot(full,'inventory').cost,[]);assert.equal(projectSnapshot(full,'cost').resources.length,0);
  assert.equal(projectSnapshot(full,'cost').cost.length,1);assert.equal(projectSnapshot(full,'scopes').presentation!.scopeStats['111111111111'].resources,1);
  assert.throws(()=>validateSnapshot({...projectSnapshot(full,'map'),resources:[resource('vm'),resource('vm')]}),/Duplicate/);
  full.activity=Array.from({length:20},(_,i)=>({id:`fake-${i}`,provider:'aws',at:'2026-11-10T00:00:00Z',actor:'fake',actorType:'service',operation:'Write',label:'fake',kind:i<3?'delete':'write',target:'aws:vm',targetName:'vm',scope:'111111111111',outcome:'ok',source:'fake'}));
  const dashboard=projectSnapshot(full,'dashboard');assert.equal(dashboard.activity.length,0);
  assert.equal(dashboard.presentation!.activitySummary!.reduce((n,a)=>n+a.count,0),20);
  assert.equal(dashboard.presentation!.activitySummary!.find(a=>a.kind==='delete')!.count,3);
  assert.equal(projectSnapshot(full,'audit').activity.length,0,'activity uses a separate paginated API');
});

test('GCP empty export remains pending, retains prior cost and timestamp, then retries on arrival',async()=>withStore(async store=>{
  let hasRows=false;const flags:boolean[]=[];
  const request=async(url:string)=>url.includes('bigquery.googleapis.com')?{jobComplete:true,rows:hasRows?[{f:['202611','p','Compute','USD','25'].map(v=>({v}))}]:[]}:url.includes('/v1/projects?')?{projects:[{projectId:'p'}]}:{assets:[],projects:[],organizations:[],folders:[]};
  await env({ATLAS_GCP_BILLING_TABLE:'fake.dataset.table',ATLAS_GCP_ALLOW_EMPTY_COST:undefined},async()=>{
    const initial=toSnapshot({...normalized([]),collectedScopes:['p'],cost:[{provider:'gcp',scope:'p',service:'Compute',month:'2026-11',amount:10,currency:'USD'}],costCoverage:[{provider:'gcp',state:'failed',failedScopes:[]}]},'2026-11-01T00:00:00Z');await store.save('gcp',initial);
    configureCollector({azure:off,aws:off,gcp:{detect:async()=>'fake',collect:options=>{flags.push(!!options.withCost);return collectGcpAuto(request,{...options,withActivity:false});}}});
    await runCollection(store,undefined,{providers:['gcp']});let saved=(await store.latest('gcp'))!;
    assert.equal(saved.costCoverage[0].state,'pending');assert.equal(saved.costAt,initial.costAt);assert.equal(saved.cost[0].amount,10);
    hasRows=true;await runCollection(store,undefined,{providers:['gcp']});saved=(await store.latest('gcp'))!;assert.equal(saved.costCoverage[0].state,'complete');assert.equal(saved.cost[0].amount,25);
    await runCollection(store,undefined,{providers:['gcp']});assert.deepEqual(flags,[true,true,false]);
  });
}));
test('an explicit empty-cost opt-in is required for a normal empty GCP export',async()=>{
  await env({ATLAS_GCP_BILLING_TABLE:'fake.dataset.table',ATLAS_GCP_ALLOW_EMPTY_COST:'1'},async()=>{
    const result=await collectGcpAuto(async url=>url.includes('bigquery')?{jobComplete:true,rows:[]}:url.includes('/v1/projects?')?{projects:[{projectId:'p'}]}:{assets:[],projects:[],organizations:[],folders:[]},{withActivity:false});
    assert.equal(result.costCoverage?.[0].state,'complete');
  });
});

test('a previously cached complete but empty GCP export is retried before its 24-hour expiry',async()=>withStore(async store=>{
  const initial=toSnapshot({...normalized([]),collectedScopes:['p'],cost:[],costCoverage:[{provider:'gcp',state:'complete',failedScopes:[]}]},new Date().toISOString());
  let withCost:boolean|undefined;
  configureCollector({azure:off,aws:off,gcp:{detect:async()=>'fake',collect:async options=>{
    withCost=options.withCost;return{...normalized([]),collectedScopes:['p'],cost:[],costCoverage:[{provider:'gcp',state:'pending',reason:'waiting-data',failedScopes:[]}]};
  }}});
  await env({ATLAS_GCP_ALLOW_EMPTY_COST:undefined},async()=>{
    await store.save('gcp',initial);const status=await runCollection(store,undefined,{providers:['gcp']});
    assert.equal(status.providers.gcp.message?.match(/이전 비용이 있으면 유지합니다/g)?.length,1);
    assert.equal(withCost,true);assert.equal((await store.latest('gcp'))!.costCoverage[0].state,'pending');
  });
  await env({ATLAS_GCP_ALLOW_EMPTY_COST:'1'},async()=>{
    await store.save('gcp',initial);await runCollection(store,undefined,{providers:['gcp']});
    assert.equal(withCost,false);assert.equal((await store.latest('gcp'))!.costCoverage[0].state,'complete');
  });
}));

test('shared request gates bound concurrency and cancellation removes queued work',async()=>{
  const gate=new RequestGate(2);let active=0,max=0;
  await Promise.all(Array.from({length:12},()=>gate.run(async()=>{active++;max=Math.max(max,active);await pause(2);active--;})));assert.equal(max,2);
  const one=new RequestGate(1),controller=new AbortController();let release!:()=>void,started=false;
  const first=one.run(()=>new Promise<void>(r=>{release=r;}));
  const queued=one.run(async()=>{started=true;},controller.signal);controller.abort();await assert.rejects(queued);release();await first;assert.equal(started,false);
  assert.equal(await one.run(async()=>42),42);
});
test('connection timeouts retry, real permission denials do not, and proxy/cancel advice is accurate',async()=>{
  let calls=0;const request=(async()=>{if(calls++===0)throw Object.assign(new TypeError('fetch failed'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});return new Response('{}');}) as typeof fetch;
  await fetchRetry('https://example.invalid',{},request,{wait:async()=>{}});assert.equal(calls,2);
  calls=0;await discoverAzureSubscriptions(async()=>'fake',(async()=>{calls++;return new Response('{}',{status:403});}) as typeof fetch,{wait:async()=>{}}).catch(()=>{});assert.equal(calls,1);
  await env({HTTPS_PROXY:'https://fake.invalid'},async()=>{
    const advice=requestAdvice('Azure',{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});assert.match(advice,/프록시 연결 대기/);assert.doesNotMatch(advice,/프록시를 설정/);
    assert.match(requestAdvice('GCP',{code:'ERR_CANCELED'}),/요청이 중단/);assert.doesNotMatch(requestAdvice('GCP',{code:'ERR_CANCELED'}),/권한/);
    assert.match(requestAdvice('GCP',{response:{status:403}}),/권한 거부/);
  });
});
test('provider concurrency is configurable across the full run, not only inside AWS',async()=>withStore(async store=>{
  await env({ATLAS_PROVIDER_CONCURRENCY:'1'},async()=>{
    let active=0,max=0;
    const driver={detect:async()=>'fake',collect:async()=>{active++;max=Math.max(max,active);await pause(3);active--;return normalized([]);}};
    configureCollector({azure:driver,aws:driver,gcp:driver});await runCollection(store);assert.equal(max,1);
  });
}));

test('collection tiers reduce repeated configuration, preserve security and unresolved types, and restrict summaries',()=>{
  const aux=Array.from({length:500},(_,i)=>resource(`config-${i}`,{kind:'configuration',type:'ssm:association',auxiliary:true}));
  const policy=resource('sg',{kind:'firewall',rules:[{direction:'Inbound',action:'Allow',protocol:'tcp',ports:'22',source:'0.0.0.0/0',destination:'All',priority:'1'}]}),vm=resource('vm',{publicIp:'192.0.2.1'});
  const input={...normalized([policy,vm,...aux,resource('future',{kind:'service',type:'new:type'})]),links:[{id:'p',source:policy.id,target:vm.id,kind:'policy' as const,label:'fake policy',evidence:'fake'}]};
  const result=compactInventory(input);assert.equal(result.resources.length,3);assert.equal(result.inventorySummary![0].count,500);assert.equal(result.inventorySummary![0].examples.length,3);
  assert.deepEqual(exposures(input.resources,input.links),exposures(result.resources,result.links));assert.equal(collectionTier(policy),1);assert.equal(classifyResource('aws','new:type').kind,'service');
  const snapshot=toSnapshot(result);assert.deepEqual(restrictSnapshot(snapshot,['222222222222']).inventorySummary,[]);
  assert.equal(compactInventory(input,null,'full').resources.length,input.resources.length);
});
test('switching to summarized inventory is not reported as resource deletion and partial scopes retain old summaries',async()=>withStore(async store=>{
  const resources=[resource(),...Array.from({length:20},(_,i)=>resource(`aux-${i}`,{kind:'configuration',type:'ssm:association',auxiliary:true}))];
  await store.save('aws',{...toSnapshot(normalized(resources)),collectedAt:'2026-11-09T00:00:00Z'});
  const compacted=compactInventory(normalized(resources));await store.save('aws',toSnapshot(compacted));
  const combined=await liveSnapshot(store);assert.ok(!combined!.changes!.items.some(c=>c.kind==='removed'));
  const partial=compactInventory({...normalized([]),incomplete:['111111111111']},toSnapshot(compacted));
  assert.equal(partial.inventorySummary![0].count,20);assert.equal(partial.inventorySummary![0].retained,true);
  const old=toSnapshot(compacted),some={...normalized(resources.slice(0,3)),incomplete:['111111111111']};
  for(const mode of ['summary','full'] as const){
    const summary=compactInventory(some,old,mode).inventorySummary![0];
    assert.equal(summary.count,20);assert.equal(summary.retained,true);assert.equal(summary.collectedAt,old.collectedAt);
  }
}));
test('confirmed SG rule IDs fold into the owner and unmatched inventory rules remain visible',()=>{
  const data={SecurityGroups:[{GroupId:'sg-a',VpcId:'vpc-a'}],SecurityGroupRules:[{GroupId:'sg-a',SecurityGroupRuleId:'sgr-a',IsEgress:false,IpProtocol:'tcp',FromPort:22,ToPort:22,CidrIpv4:'0.0.0.0/0'}]};
  const detailed=normalizeAws(data,'111111111111','r');
  const inventory={...normalized([]),awsInventory:{account:'111111111111',rows:['sgr-a','sgr-unknown'].map(id=>({Arn:`arn:aws:ec2:r:111111111111:security-group-rule/${id}`,Region:'r',ResourceType:'ec2:security-group-rule'}))}};
  const result=finish([detailed,inventory]);assert.equal(result.resources.filter(r=>r.type==='ec2:security-group-rule').length,1);
  assert.equal(result.resources.find(r=>r.kind==='firewall')!.rules[0].id,'sgr-a');
  assert.ok(result.resources.some(r=>r.nativeId.endsWith('sgr-unknown')));
});
test('resource IAM targets and workload references preserve exact evidence without connectivity hops',()=>{
  const azure=normalizeAzureIam([{id:'/assignments/a',type:'Microsoft.Authorization/roleAssignments',properties:{scope:'/subscriptions/a/resourceGroups/g/providers/Microsoft.Storage/storageAccounts/s',principalId:'fake-principal',roleDefinitionId:'reader'}}]);
  assert.equal(azure[0].targetResource,'azure:/subscriptions/a/resourcegroups/g/providers/microsoft.storage/storageaccounts/s');
  const binding=normalizeGcpIam([{name:'//storage.googleapis.com/projects/_/buckets/fake',assetType:'storage.googleapis.com/Bucket',iamPolicy:{bindings:[{role:'roles/storage.objectViewer',members:['serviceAccount:fake@example.invalid']}]}}],new Map(),'p');
  assert.equal(binding[0].level,'resource');assert.equal(binding[0].targetResource,'gcp://storage.googleapis.com/projects/_/buckets/fake');
  const vm=normalizeGcp([{name:'//compute.googleapis.com/projects/p/zones/z/instances/vm',assetType:'compute.googleapis.com/Instance',resource:{data:{machineType:'zones/z/machineTypes/e2-medium',disks:[{source:'projects/p/zones/z/disks/d'}],serviceAccounts:[{email:'fake@example.invalid'}]}}}]);
  assert.equal(vm.links.filter(l=>l.kind==='reference').length,2);
  const snapshot=toSnapshot(finish([vm]));assert.equal(adjacency(snapshot.resources,snapshot.links).get(vm.resources[0].id)?.size,0);
  const noReferences=normalizeGcp([{name:'//compute.googleapis.com/projects/p/zones/z/instances/none',assetType:'compute.googleapis.com/Instance',resource:{data:{}}}]);assert.equal(noReferences.links.length,0);
});
