import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ResourceSchema,validateSnapshot} from '../shared/schema.ts';
import {SelectionSchema,selectedItems,resourceItem} from '../shared/collection-items.ts';
import {mergeSelected} from '../server/selected-collection.ts';
import {collectAwsAccount,collectAwsWith,collectAzureWith,collectGcpWith,type AwsRuntime} from '../server/collectors.ts';
import {CollectionConflictError,configureCollector,runCollection,toSnapshot} from '../server/runner.ts';
import {FileSnapshotStore} from '../server/store.ts';
import type {Normalized} from '../server/normalize.ts';
const at='2026-11-12T00:00:00.000Z',oldAt='2026-11-11T00:00:00.000Z';
const row=(id:string,type:string,extra={})=>ResourceSchema.parse({id,nativeId:id,name:id,provider:'azure',scope:'a',region:'r',kind:'compute',type,source:'fake',...extra});
const part=(resources:ReturnType<typeof row>[]=[]):Normalized=>({resources,links:[],warnings:[],scopeLabels:{a:'A'},collectedScopes:['a']});
const prior=()=>validateSnapshot({version:1,mode:'live',collectedAt:oldAt,resources:[row('vm','microsoft.compute/virtualmachines'),row('db','microsoft.sql/servers'),row('old','microsoft.storage/storageaccounts')],links:[],warnings:[],scopes:['a'],scopeCollectedAt:{a:oldAt},itemCollection:[{provider:'azure',scope:'a',item:'inventory',state:'complete',attemptedAt:oldAt,collectedAt:oldAt}],iam:[{id:'iam',provider:'azure',principal:'user',principalType:'user',role:'Reader',scope:'a',level:'scope',privileged:false,external:false,source:'fake'}],activity:[{id:'event',provider:'azure',at:oldAt,actor:'user',actorType:'user',operation:'Write',label:'write',kind:'write',target:'vm',targetName:'vm',scope:'a',outcome:'ok',source:'fake'}]});

test('selection validates unknown, empty and mismatched input and adds only resource dependencies',()=>{
  for(const input of [{mode:'selected',items:[]},{mode:'selected',items:[{provider:'aws',item:'unknown'}]},{mode:'selected',items:[{provider:'azure',item:'compute',extra:true}]},{mode:'all',items:[]}])assert.equal(SelectionSchema.safeParse(input).success,false);
  assert.deepEqual(selectedItems({mode:'selected',items:[{provider:'azure',item:'compute'},{provider:'azure',item:'compute'}]},'azure'),['compute','network']);
  assert.deepEqual(selectedItems({mode:'selected',items:[{provider:'aws',item:'cost'}]},'aws'),['cost']);
  assert.equal(resourceItem(row('same-kind','microsoft.storage/storageaccounts')),'storage');
});
test('successful empty selected item deletes only its own rows, leaving values and dates byte-equivalent',()=>{
  const before=prior(),copy=structuredClone(before),merged=mergeSelected(part(),before,'azure',['compute'],at);
  assert.deepEqual(merged.resources,copy.resources.filter(r=>r.id!=='vm'));
  assert.deepEqual(merged.iam,copy.iam);assert.deepEqual(merged.activity,copy.activity);
  assert.deepEqual(merged.itemCollection?.find(r=>r.item==='inventory'),copy.itemCollection[0]);
  assert.equal(merged.itemCollection?.find(r=>r.item==='compute')?.collectedAt,at);
  assert.deepEqual(before,copy,'merging must not mutate the previous generation');
});
test('partial selected reads retain missing rows and last successful item dates',()=>{
  const before=prior();before.itemCollection.push({provider:'azure',scope:'a',item:'compute',state:'complete',attemptedAt:oldAt,collectedAt:oldAt});
  const merged=mergeSelected({...part(),incomplete:['a']},before,'azure',['compute'],at);
  assert.deepEqual(merged.resources,before.resources);
  assert.equal(merged.itemCollection?.find(r=>r.item==='compute')?.state,'partial');
  assert.equal(merged.itemCollection?.find(r=>r.item==='compute')?.collectedAt,oldAt);
  const activity=mergeSelected({...part(),activityIncomplete:['a']},before,'azure',['activity'],at);
  assert.deepEqual(activity.activity,before.activity);
});
test('selected AWS APIs skip unrelated services, IAM, inventory, activity and cost',async()=>{
  const operations:string[]=[];
  await collectAwsAccount(async(_service,operation)=>{operations.push(operation);return{};},'a','r',undefined,['network','compute']);
  assert.ok(operations.includes('DescribeInstances'));assert.ok(operations.includes('DescribeVpcs'));
  assert.ok(!operations.some(x=>/DB|Clusters|Cluster/.test(x)));
  const never=async()=>{throw new Error('unselected call');};
  const runtime:AwsRuntime={identity:async()=>'a',hierarchy:async()=>[],assume:async()=>({}),regions:async()=>['r'],resources:async()=>part(),iam:never,inventory:never,activity:never,cost:never};
  const result=await collectAwsWith(runtime,['r'],[],{items:['network','compute'],withIam:false,withCost:false,withActivity:false});
  assert.deepEqual(result.collectedScopes,['a']);assert.deepEqual(result.incomplete,[]);
});
test('Azure and GCP selected VM queries include network context and skip IAM and activity calls',async()=>{
  const queries:string[]=[],json=(value:unknown)=>new Response(JSON.stringify(value));
  const azure=(async(url,init)=>{
    const text=String(url);
    if(text.toLowerCase().includes('resourcegraph')){queries.push(JSON.parse(String(init?.body)).query);return json({data:[]});}
    if(text.includes('/subscriptions/a?'))return json({displayName:'A'});
    return json({value:[]});
  }) as typeof fetch;
  await collectAzureWith(['a'],async()=>'fake',azure,{items:['network','compute'],withIam:false,withCost:false,withActivity:false});
  assert.equal(queries.length,1);assert.match(queries[0],/where.*microsoft.compute\/virtualmachines/);assert.match(queries[0],/microsoft.network\//);assert.doesNotMatch(queries[0],/roleassignments/i);
  const urls:string[]=[];
  await collectGcpWith('projects/a',async url=>{urls.push(url);return{assets:[]};},{items:['network','compute'],withIam:false,withCost:false,withActivity:false});
  assert.equal(urls.length,1);const query=new URL(urls[0]).searchParams;
  assert.ok(query.getAll('assetTypes').includes('compute.googleapis.com/Instance'));assert.ok(query.getAll('assetTypes').includes('compute.googleapis.com/Subnetwork'));assert.equal(query.get('contentType'),'RESOURCE');
});
test('runner preserves whole-scope age, forces selected cost, coalesces identical requests and rejects different ones',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-selected-')),store=new FileSnapshotStore(root);
  const off={detect:async()=>{throw new Error('unselected provider');},collect:async()=>part()};
  try{
    await store.save('azure',prior());let release!:()=>void;
    const held=new Promise<void>(r=>{release=r;});let reads=0;
    configureCollector({aws:off,gcp:off,azure:{detect:async()=>'fake',collect:async options=>{reads++;assert.deepEqual(options.items,['compute','network']);assert.equal(options.withCost,false);assert.equal(options.withIam,false);await held;return part();}}});
    const selection={mode:'selected' as const,items:[{provider:'azure' as const,item:'compute' as const}]};
    const first=runCollection(store,undefined,{selection});assert.equal(runCollection(store,undefined,{selection}),first);
    assert.throws(()=>runCollection(store,undefined,{selection:{mode:'selected',items:[{provider:'azure',item:'cost'}]}}),CollectionConflictError);
    release();const status=await first;assert.equal(reads,1);assert.equal(status.providers.azure.state,'ok');
    const saved=(await store.latest('azure'))!;assert.equal(saved.scopeCollectedAt.a,oldAt);assert.deepEqual(saved.resources.map(r=>r.id),['db','old']);assert.deepEqual(saved.activity,prior().activity);
    configureCollector({aws:off,gcp:off,azure:{detect:async()=>'fake',collect:async options=>{assert.equal(options.withCost,true);assert.deepEqual(options.items,['cost']);return {...part(),cost:[],costCoverage:[{provider:'azure',state:'complete',failedScopes:[]}]};}}});
    await runCollection(store,undefined,{selection:{mode:'selected',items:[{provider:'azure',item:'cost'}]}});
    assert.deepEqual((await store.latest('azure'))!.resources,saved.resources);
    const scoped=await import('../server/auth.ts');assert.deepEqual(scoped.restrictSnapshot((await store.latest('azure'))!,['other']).itemCollection,[]);
  }finally{configureCollector();await rm(root,{recursive:true,force:true});}
});

test('collect HTTP endpoints validate JSON and permissions and return a conflict run ID for a different selection',async()=>{
  const {default:app}=await import('../server/app.ts');
  const {createHash}=await import('node:crypto');
  const root=await mkdtemp(path.join(tmpdir(),'atlas-selection-api-')),keys=['DATA_MODE','ATLAS_COLLECTOR','SNAPSHOT_DIR','ACCESS_TOKENS'] as const,old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  process.env.DATA_MODE='live';process.env.ATLAS_COLLECTOR='1';process.env.SNAPSHOT_DIR=root;
  process.env.ACCESS_TOKENS=JSON.stringify(['admin','scoped'].map(token=>({name:token,tokenSha256:createHash('sha256').update(token).digest('hex'),scopes:token==='admin'?['*']:['a']})));
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const off={detect:async()=>{throw new Error('must not select');},collect:async()=>part()};
  configureCollector({aws:off,gcp:off,azure:{detect:async()=>'fake',collect:async()=>{await held;return part();}}});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,headers={Authorization:'Bearer admin','X-Atlas-Request':'1','Content-Type':'application/json'};
  const selection={mode:'selected' as const,items:[{provider:'azure' as const,item:'compute' as const}]};let job:Promise<unknown>|undefined;
  try{
    assert.equal((await fetch(base+'/api/collect/items')).status,401);
    assert.equal((await fetch(base+'/api/collect/items',{headers:{Authorization:'Bearer scoped'}})).status,403);
    const catalog=await (await fetch(base+'/api/collect/items',{headers})).json();assert.equal(catalog.items.length,27);assert.deepEqual(catalog.items.find((i:any)=>i.provider==='azure'&&i.item==='compute').requires,['network']);
    assert.equal((await fetch(base+'/api/collect',{method:'POST',headers:{...headers,Authorization:'Bearer scoped'},body:JSON.stringify(selection)})).status,403);
    for(const body of ['{',JSON.stringify({mode:'selected',items:[]}),JSON.stringify({mode:'selected',items:[{provider:'unknown',item:'compute'}]})])assert.equal((await fetch(base+'/api/collect',{method:'POST',headers,body})).status,400);
    assert.equal((await fetch(base+'/api/collect',{method:'POST',headers,body:JSON.stringify({mode:'all',large:'x'.repeat(9000)})})).status,413);
    const started=await fetch(base+'/api/collect',{method:'POST',headers,body:JSON.stringify(selection)});assert.equal(started.status,202);const {runId}=await started.json();assert.ok(runId);
    job=runCollection(new FileSnapshotStore(root),undefined,{selection});
    const joined=await (await fetch(base+'/api/collect',{method:'POST',headers,body:JSON.stringify(selection)})).json();assert.equal(joined.runId,runId);
    const conflict=await fetch(base+'/api/collect',{method:'POST',headers,body:JSON.stringify({mode:'selected',items:[{provider:'aws',item:'cost'}]})});assert.equal(conflict.status,409);assert.equal((await conflict.json()).runId,runId);
  }finally{release();await job;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));configureCollector();for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}await rm(root,{recursive:true,force:true});}
});

test('IAM and activity completion scopes can cover organization policies independently from leaf resource scopes',()=>{
  const before=validateSnapshot({...prior(),resources:[],scopes:['project'],itemCollection:[],scopeLabels:{project:'Project'},iam:[{...prior().iam[0],provider:'gcp',scope:'organization',level:'org'}],activity:[{...prior().activity[0],provider:'gcp',scope:'organization'}]});
  const read={...part(),collectedScopes:['project'],iam:[],activity:[],iamCollectedScopes:['organization','project'],activityCollectedScopes:['organization','project']};
  const iam=mergeSelected(read,before,'gcp',['iam'],at);assert.deepEqual(iam.iam,[]);assert.deepEqual(iam.activity,before.activity);assert.equal(iam.itemCollection?.find(r=>r.scope==='organization'&&r.item==='iam')?.state,'complete');
  assert.equal(iam.itemCollection?.some(r=>r.scope==='organization'&&r.item==='compute'),false);
  const activity=mergeSelected(read,before,'gcp',['activity'],at);assert.deepEqual(activity.activity,[]);assert.deepEqual(activity.iam,before.iam);
  const failed=mergeSelected({...read,iamCollectedScopes:[],iamIncomplete:['organization']},before,'gcp',['iam'],at);assert.deepEqual(failed.iam,before.iam);assert.equal(failed.itemCollection?.find(r=>r.scope==='organization'&&r.item==='iam')?.state,'failed');
});
