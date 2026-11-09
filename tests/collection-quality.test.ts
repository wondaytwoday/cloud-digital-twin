import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {fetchRetry,mapLimit,retryDelay} from '../server/async.ts';
import {azureCost,collectAwsAccount,collectAwsActivity,collectAwsCost,collectAwsWith,collectGcpCost,type AwsRuntime} from '../server/collectors.ts';
import {retainIncomplete} from '../server/reconcile.ts';
import {finish,normalizeAzure,normalizeGcp,type Normalized} from '../server/normalize.ts';
import {configureCollector,runCollection,toSnapshot} from '../server/runner.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {restrictSnapshot} from '../server/auth.ts';
import {classifyResource,classificationSummary,isAuxiliary} from '../shared/classification.ts';
import {costIssues,networkEmptyMessage} from '../shared/collectionView.ts';
import {ResourceSchema,validateSnapshot,type CostRow} from '../shared/schema.ts';

const now=new Date('2026-11-09T00:00:00Z'),noWait=async()=>{};
const json=(value:unknown,status=200,headers?:HeadersInit)=>new Response(JSON.stringify(value),{status,headers});
const costBody=(amount=10,nextLink?:string)=>({properties:{columns:['Cost','BillingMonth','ServiceName','Currency'].map(name=>({name})),rows:[[amount,'2026-10-01','Compute','USD']],nextLink}});
const resource=(scope='111111111111',name='vpc-a')=>ResourceSchema.parse({id:`aws:${scope}/r/${name}`,nativeId:`${scope}/r/${name}`,name,provider:'aws',scope,region:'r',kind:'network',type:'AWS::EC2::VPC',source:'fake DescribeVpcs'});
const part=(scope='111111111111'):Normalized=>({resources:[resource(scope)],links:[],warnings:[],scopeLabels:{[scope]:scope},collectedScopes:[scope]});
const cost=(scope='111111111111',amount=10):CostRow=>({provider:'aws',scope,service:'Compute',month:'2026-10',amount,currency:'USD'});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
const runtime=(overrides:Partial<AwsRuntime>={}):AwsRuntime=>({
  identity:async()=>'111111111111',hierarchy:async()=>[],assume:async()=>({}),regions:async()=>['r'],
  resources:async(_c,scope)=>part(scope),iam:async()=>({iam:[]}),inventory:async()=>({rows:[]}),activity:async()=>[],cost:async()=>[],...overrides,
});
const off={detect:async()=>{throw new Error('No test credentials');},collect:async()=>{throw new Error('must not collect');}};
async function withStore(work:(store:FileSnapshotStore)=>Promise<void>){
  const root=await mkdtemp(path.join(tmpdir(),'atlas-quality-'));
  try{await work(new FileSnapshotStore(root));}finally{configureCollector();await rm(root,{recursive:true,force:true});}
}

test('Azure costs retry throttling headers and read every page before accepting a scope',async()=>{
  const delays:number[]=[],calls:string[]=[];let attempts=0;
  const request=(async(url)=>{
    calls.push(String(url));
    if(attempts++===0)return json({},429,{'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after':'12','Retry-After':'3'});
    return String(url).includes('page=2')?json(costBody(20)):json(costBody(10,'https://management.azure.com/subscriptions/a/providers/Microsoft.CostManagement/query?page=2'));
  }) as typeof fetch;
  const result=await azureCost(['a'],async()=>'fake',request,now,undefined,{wait:async ms=>{delays.push(ms);}});
  assert.equal(calls.length,3);assert.deepEqual(delays,[12000]);assert.deepEqual(result.failed,[]);assert.deepEqual(result.rows.map(r=>r.amount),[10,20]);
  assert.equal(retryDelay(new Headers({'Retry-After':'Mon, 09 Nov 2026 00:00:10 GMT'}),0,now.getTime()),10000);
});
test('a failed page discards that scope only, with no permanent-error retries or bearer-token redirects',async()=>{
  const calls:string[]=[];
  const request=(async url=>{
    const u=String(url);calls.push(u);
    if(u.includes('/good/'))return json(costBody(9));
    if(u.includes('page=2'))return json({},403);
    return json(costBody(99,'https://management.azure.com/subscriptions/bad/providers/Microsoft.CostManagement/query?page=2'));
  }) as typeof fetch;
  const result=await azureCost(['bad','good'],async()=>'fake',request,now,undefined,{wait:noWait});
  assert.deepEqual(result.failed,['bad']);assert.deepEqual(result.rows.map(r=>[r.scope,r.amount]),[['good',9]]);assert.equal(calls.length,3);
  const unsafe=(async()=>json(costBody(10,'https://example.invalid/steal-token'))) as typeof fetch;
  const rejected=await azureCost(['a'],async()=>'fake',unsafe,now,undefined,{wait:noWait});
  assert.deepEqual(rejected.failed,['a']);assert.equal(rejected.rows.length,0);
});
test('HTTP retry budget stops after four requests and waits can be cancelled',async()=>{
  let calls=0;const controller=new AbortController();
  const request=(async()=>{calls++;return json({},503);}) as typeof fetch;
  assert.equal((await fetchRetry('https://example.invalid',{},request,{wait:noWait})).status,503);assert.equal(calls,4);
  calls=0;
  await assert.rejects(fetchRetry('https://example.invalid',{},request,{signal:controller.signal,wait:async()=>{controller.abort();}}));
  assert.equal(calls,1);
});
test('AWS cost throttling retries, while repeated pages fail instead of inflating totals',async()=>{
  let calls=0;
  const rows=await collectAwsCost(async()=>{if(calls++===0)throw Object.assign(new Error('slow down'),{name:'ThrottlingException'});return{ResultsByTime:[{TimePeriod:{Start:'2026-10-01'},Groups:[{Keys:['111111111111','Compute'],Metrics:{UnblendedCost:{Amount:'10',Unit:'USD'}}}]}]};},now,{wait:noWait});
  assert.deepEqual(rows,[cost()]);assert.equal(calls,2);
  await assert.rejects(collectAwsCost(async()=>({NextPageToken:'again'}),now,{wait:noWait}),/repeated/);
});
test('CloudTrail spaces pages within an account and region, and rejects repeated tokens',async()=>{
  const delays:number[]=[];let calls=0;
  await collectAwsActivity(async()=>({...(calls++===0?{NextToken:'n'}:{})}),'111111111111','r',now,{wait:async ms=>{delays.push(ms);}});
  assert.equal(calls,2);assert.deepEqual(delays,[500]);
  await assert.rejects(collectAwsActivity(async()=>({NextToken:'same'}),'111111111111','r',now,{wait:noWait}),/repeated/);
});
test('BigQuery costs wait for the job, retain its location, and consume every page',async()=>{
  const calls:string[]=[];let n=0;
  const row=(amount:number)=>({f:['202610','p','Compute','USD',String(amount)].map(v=>({v}))});
  const rows=await collectGcpCost(async url=>{calls.push(url);return n++===0?{jobComplete:false,jobReference:{jobId:'j',projectId:'billing',location:'asia-northeast3'}}:n===2?{jobComplete:true,rows:[row(10)],pageToken:'next'}:{jobComplete:true,rows:[row(20)]};},'billing.dataset.export',now,{wait:noWait});
  assert.deepEqual(rows.map(r=>r.amount),[10,20]);assert.equal(calls.length,3);assert.match(calls[1],/location=asia-northeast3/);assert.match(calls[2],/pageToken=next/);
  await assert.rejects(collectGcpCost(async()=>({jobComplete:true,pageToken:'n'}),'billing.dataset.export',now,{wait:noWait}),/jobReference/);
});

test('cost failures keep the last good values and timestamp, retry next run, and complete empty reads clear them',async()=>withStore(async store=>{
  const old='2026-11-09T00:00:00.000Z';await store.save('aws',toSnapshot({...part(),cost:[cost(),cost('222222222222',30)]},old));
  const flags:boolean[]=[],scope='222222222222';let attempt=0;
  configureCollector({azure:off,gcp:off,aws:{detect:async()=>'fake',collect:async options=>{
    flags.push(!!options.withCost);attempt++;
    return{...part(),cost:attempt===1?[cost(undefined,12)]:[],costCoverage:[{provider:'aws',state:attempt===1?'partial':'complete',failedScopes:attempt===1?[scope]:[]}]};
  }}});
  // A failed coverage state forces an immediate refresh even if the old cache is recent.
  const previous=(await store.latest('aws'))!;previous.costCoverage=[{provider:'aws',state:'failed',failedScopes:[scope]}];await store.save('aws',previous);
  const first=await runCollection(store);let saved=(await store.latest('aws'))!;
  assert.equal(first.providers.aws.state,'partial');assert.equal(saved.costAt,old);assert.deepEqual(saved.cost.map(r=>r.amount),[12,30]);
  await runCollection(store);saved=(await store.latest('aws'))!;
  assert.deepEqual(flags,[true,true]);assert.deepEqual(saved.cost,[]);assert.notEqual(saved.costAt,old);assert.equal(saved.costCoverage[0].state,'complete');
  await runCollection(store);assert.deepEqual(flags,[true,true,false]);
}));

test('AWS account and CloudTrail concurrency is bounded and checkpoints retain unfinished scopes',async()=>{
  const before=process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY;process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY='2';
  let active=0,max=0,regionsActive=0,regionsMax=0;const checkpoints:Normalized[]=[];
  try{
    const result=await collectAwsWith(runtime({
      assume:async role=>{active++;max=Math.max(max,active);return role;},
      resources:async(_c,id)=>{await pause(5);return part(id);},
      inventory:async()=>{active--;return{rows:[]};},
      activity:async()=>{regionsActive++;regionsMax=Math.max(regionsMax,regionsActive);await pause(5);regionsActive--;return[];},
    }),['r','r2'],['111111111111','222222222222','333333333333'].map(id=>({label:id,roleArn:`arn:aws:iam::${id}:role/Reader`})),{withCost:false,checkpoint:r=>checkpoints.push(r)});
    assert.equal(max,2);assert.ok(regionsMax>1);assert.ok(regionsMax<=6);assert.equal(result.collectedScopes?.length,3);
    assert.deepEqual(checkpoints.map(c=>c.collectedScopes?.length),[1,2,3]);assert.equal(checkpoints[0].incomplete?.length,2);assert.deepEqual(result.incomplete,[]);
  }finally{if(before===undefined)delete process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY;else process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY=before;}
});
test('AWS account concurrency one is serial and account failures preserve successful accounts',async()=>{
  const before=process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY;process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY='1';let active=0,max=0;
  try{
    const result=await collectAwsWith(runtime({assume:async role=>{if(role.label==='bad')throw new Error('denied');active++;max=Math.max(max,active);return{};},inventory:async()=>{active--;return{rows:[]};}}),['r'],[{label:'good',roleArn:'arn:aws:iam::111111111111:role/Reader'},{label:'bad',roleArn:'arn:aws:iam::222222222222:role/Reader'}],{withCost:false,withActivity:false});
    assert.equal(max,1);assert.equal(result.resources.length,1);assert.deepEqual(result.incomplete,['222222222222']);
  }finally{if(before===undefined)delete process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY;else process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY=before;}
});
test('a timeout saves completed accounts, retains missing old items, and blocks overlap until the old job settles',async()=>withStore(async store=>{
  const a='111111111111',b='222222222222',gate=deferred(),done=deferred();let calls=0;
  await store.save('aws',toSnapshot({...finish([part(a),part(b)]),cost:[cost()]},now.toISOString()));
  const roles=[a,b].map(id=>({label:id,roleArn:`arn:aws:iam::${id}:role/Reader`}));
  configureCollector({azure:off,gcp:off,aws:{detect:async()=>'fake',collect:async options=>{
    calls++;try{return await collectAwsWith(runtime({resources:async(_c,id)=>{if(id===b)await gate.promise;return part(id);}}),['r'],roles,{...options,withActivity:false});}finally{done.resolve();}
  }}});
  const first=await runCollection(store,undefined,{timeoutMs:40}),saved=(await store.latest('aws'))!;
  assert.equal(first.providers.aws.state,'partial');assert.ok(saved.incomplete.includes(b));assert.equal(saved.resources.length,2);assert.match(saved.resources.find(r=>r.scope===b)!.specs['수집 상태'],/이전 값 유지/);
  assert.equal((await runCollection(store)).providers.aws.state,'failed');assert.equal(calls,1);
  gate.resolve();await done.promise;await pause(0);
  assert.equal((await runCollection(store)).providers.aws.state,'ok');assert.equal(calls,2);
}));
test('cancellation waits for active workers before settling and never starts queued work',async()=>{
  const controller=new AbortController(),gate=deferred();const started:number[]=[];let settled=false;
  const work=mapLimit([1,2,3],2,async n=>{started.push(n);if(n===1){await gate.promise;return n;}controller.abort();throw new Error('cancel');},controller.signal).finally(()=>{settled=true;});
  await pause(0);assert.equal(settled,false);gate.resolve();await assert.rejects(work);assert.deepEqual(started,[1,2]);
});
test('the provider-specific runner uses the same cost failure rules without contacting other providers',async()=>withStore(async store=>{
  let calls=0;
  configureCollector({azure:off,gcp:off,aws:{detect:async()=>'fake',collect:async()=>{throw new Error('override must be used');}}});
  const collect=async()=>{calls++;return{...part(),costCoverage:[{provider:'aws' as const,state:'failed' as const,failedScopes:['111111111111']}]};};
  const options={providers:['aws' as const],collectors:{aws:collect}};
  const first=await runCollection(store,undefined,options);assert.equal(first.providers.aws.state,'partial');assert.equal(first.providers.azure.state,'idle');
  assert.equal((await store.latest('aws'))?.costAt,undefined);await runCollection(store,undefined,options);assert.equal(calls,2);
}));
test('a partial peer placeholder does not replace a previously collected resource',()=>{
  const a='111111111111',b='222222222222',peer=resource(b),link={id:'peer',source:resource(a).id,target:peer.id,kind:'peering' as const,label:'Peering',evidence:'fake reference'};
  const previous=toSnapshot(finish([part(a),part(b),{resources:[],links:[link],warnings:[],scopeLabels:{}}]));
  const partial=finish([{...part(a),links:[link],incomplete:[b]}]);assert.equal(partial.resources.find(r=>r.id===peer.id)?.kind,'external');
  const merged=retainIncomplete(partial,previous),retained=merged.resources.find(r=>r.id===peer.id)!;
  assert.equal(retained.kind,'network');assert.match(retained.specs['수집 상태'],/이전 값 유지/);assert.equal(toSnapshot(merged).links.length,1);
});
test('AWS evidence distinguishes denied, unavailable and network failure',async()=>{
  for(const [name,message,reason,partial] of [['AccessDeniedException','denied','denied',true],['UnsupportedOperation','not available in this region','unavailable',false],['Error','getaddrinfo ENOTFOUND eks.fake','failed',true]] as const){
    const result=await collectAwsAccount(async(service,op)=>{if(service==='eks')throw Object.assign(new Error(message),{name});return op==='DescribeVpcs'?{Vpcs:[{VpcId:'vpc-a'}]}:{};},'111111111111','r');
    assert.equal(result.collectionGaps?.find(g=>g.operation==='ListClusters')?.reason,reason);assert.equal(!!result.incomplete?.length,partial);
  }
});
test('type classification is shared, unknowns stay unknown, and auxiliary settings remain collected',()=>{
  assert.equal(classifyResource('aws','s3:bucket').kind,'storage');assert.equal(classifyResource('azure','Microsoft.KeyVault/vaults').kind,'security');assert.equal(classifyResource('gcp','Monitoring.googleapis.com/AlertPolicy').kind,'monitoring');assert.equal(classifyResource('aws','future:unknown').kind,'service');
  const azure=normalizeAzure([{id:'/subscriptions/a/resourceGroups/g/providers/Microsoft.Compute/virtualMachines/v/extensions/e',name:'e',type:'Microsoft.Compute/virtualMachines/extensions',subscriptionId:'a',properties:{}}]);
  assert.equal(azure.resources[0].kind,'configuration');assert.equal(isAuxiliary(azure.resources[0]),true);
  const gcp=normalizeGcp([{name:'//serviceusage.googleapis.com/projects/p/services/example',assetType:'serviceusage.googleapis.com/Service',resource:{data:{}}}]);assert.equal(gcp.resources[0].kind,'configuration');assert.equal(isAuxiliary(gcp.resources[0]),true);
  assert.deepEqual(classificationSummary([{...resource(),kind:'service',type:'future'}]),[{type:'aws:future',count:1}]);
});
test('old snapshots default new metadata and restricted responses keep failed scope IDs private',()=>{
  const original=toSnapshot({...part(),costCoverage:[{provider:'aws',state:'partial',failedScopes:['secret']}],collectionGaps:[{provider:'aws',scope:'secret',operation:'DescribeVpcs',reason:'denied',code:'AccessDenied'}]});
  original.resources[0].specs['미수집 상위 참조']='secret';
  const {costCoverage:_,collectionGaps:__,...old}=original;assert.deepEqual(validateSnapshot(old).costCoverage,[]);
  const restricted=restrictSnapshot(original,['111111111111']);assert.deepEqual(restricted.collectionGaps,[]);assert.ok(!JSON.stringify(restricted).includes('secret'));
  assert.equal(costIssues(original,{provider:'aws',scopes:new Set(['111111111111']),inherits:()=>false}).length,0);
});
test('empty topology messages never infer permission denial from an unknown reference',()=>{
  const unknown=finish([{...part(),links:[{id:'peering',source:resource().id,target:'aws:222222222222/r/vpc-other',kind:'peering',label:'Peering',evidence:'fake reference'}]}]);
  const external=unknown.resources.find(r=>r.kind==='external')!;assert.equal(external.reference?.reason,'uncollected');assert.doesNotMatch(external.status,/권한/);
  const s=toSnapshot({...part(),resources:[],collectionGaps:[{provider:'aws',scope:'111111111111',operation:'DescribeVpcs',reason:'denied',code:'AccessDenied'}]});
  const focus={provider:'aws',scopes:new Set(['111111111111']),inherits:()=>false};assert.match(networkEmptyMessage(s,focus),/권한/);
  s.collectionGaps=[];assert.match(networkEmptyMessage(s,focus),/완료된 수집/);s.scopes=[];assert.match(networkEmptyMessage(s,focus),/아직 수집하지/);
});
test('invalid snapshot writes leave the last good file in place',async()=>withStore(async store=>{
  const snapshot=toSnapshot(part());await store.save('aws',snapshot);
  await assert.rejects(store.save('aws',{...snapshot,resources:[...snapshot.resources,...snapshot.resources]}),/Duplicate/);
  assert.deepEqual(await store.latest('aws'),JSON.parse(JSON.stringify(snapshot)));
}));
