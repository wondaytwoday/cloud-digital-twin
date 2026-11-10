import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {collectAwsWith,type AwsRuntime} from '../server/collectors.ts';
import {configureCollector,runCollection,toSnapshot} from '../server/runner.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {ResourceSchema,type CostCoverage} from '../shared/schema.ts';
import {costCoverageMessage,costIssues} from '../shared/collectionView.ts';
import {classifyResource,isAuxiliary} from '../shared/classification.ts';
import {restrictSnapshot} from '../server/auth.ts';

const ids=['111111111111','222222222222','333333333333'];
const roles=ids.map(id=>({label:id,roleArn:`arn:aws:iam::${id}:role/Reader`}));
const part=(scope=ids[0])=>({resources:[ResourceSchema.parse({id:`aws:${scope}/r/vpc`,nativeId:`${scope}/r/vpc`,name:'fake',provider:'aws',scope,region:'r',kind:'network',type:'AWS::EC2::VPC',source:'fake'})],links:[],warnings:[],scopeLabels:{},collectedScopes:[scope]});
const runtime=(overrides:Partial<AwsRuntime>={}):AwsRuntime=>({identity:async()=>ids[0],hierarchy:async()=>[],assume:async()=>({}),regions:async()=>['r'],resources:async(_c,id)=>part(id),iam:async()=>({iam:[]}),inventory:async()=>({rows:[]}),activity:async()=>[],cost:async()=>[],...overrides});
const off={detect:async()=>{throw new Error('no fake login');},collect:async()=>part()};
const focus={provider:'aws',scopes:null,inherits:()=>false};
async function withStore(work:(store:FileSnapshotStore)=>Promise<void>){
  const root=await mkdtemp(path.join(tmpdir(),'atlas-issue4-'));
  try{await work(new FileSnapshotStore(root));}finally{configureCollector();await rm(root,{recursive:true,force:true});}
}
const untilAborted=(signal:AbortSignal)=>new Promise<never>((_resolve,reject)=>{
  if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
});

test('AWS puts unseen scopes before stale scopes without mutating caller role order',async()=>{
  const order:string[]=[];
  await collectAwsWith(runtime({assume:async role=>{order.push(role.label!);return{};}}),['r'],roles,{withCost:false,withActivity:false,scopeCollectedAt:{[ids[0]]:'2026-11-10T00:00:00Z',[ids[2]]:'2026-11-09T00:00:00Z'}});
  assert.deepEqual(order,[ids[1],ids[2],ids[0]]);assert.deepEqual(roles.map(r=>r.label),ids);
});
test('repeated bounded runs rotate across all accounts, persist age and keep slow-stage diagnostics',async()=>withStore(async store=>{
  const before=process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY;process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY='1';
  const refreshed:string[]=[],events:string[]=[];let costCalls=0,lastJob:Promise<unknown>|undefined;
  try{
    configureCollector({azure:off,gcp:off,aws:{detect:async()=>'fake',collect:options=>{
      let reads=0;
      lastJob=collectAwsWith(runtime({resources:async(_c,id)=>{events.push('inventory');if(reads++)return untilAborted(options.signal!);refreshed.push(id);return part(id);},cost:async()=>{events.push('cost');costCalls++;return[];}}),['r'],roles,{...options,withActivity:false});
      return lastJob as ReturnType<typeof collectAwsWith>;
    }}});
    for(let i=0;i<3;i++){
      const state=await runCollection(store,undefined,{providers:['aws'],timeoutMs:80});
      await lastJob?.catch(()=>{});
      assert.equal(state.providers.aws.state,'partial');
      assert.match(state.providers.aws.message!,/완료 1 \/ 전체 3계정/);
      assert.match(state.providers.aws.message!,/다음 수집에서/);
      assert.ok(state.providers.aws.slowStages!.length>0);
    }
    assert.deepEqual(refreshed,ids);assert.equal(costCalls,1);assert.equal(events[0],'cost');
    const saved=(await store.latest('aws'))!;assert.deepEqual(Object.keys(saved.scopeCollectedAt).sort(),ids);
    assert.equal(saved.resources.length,3);assert.equal(saved.costCoverage[0].state,'complete');
    const scoped=restrictSnapshot(saved,[ids[0]]);assert.deepEqual(Object.keys(scoped.scopeCollectedAt),[ids[0]]);
  }finally{if(before===undefined)delete process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY;else process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY=before;}
}));
test('AWS single organization query reports denied/throttled/network/timeout without inflated account counts',async()=>{
  for(const [error,reason] of [
    [{name:'AccessDeniedException'},'denied'],[{name:'ThrottlingException'},'throttled'],
    [{code:'ENOTFOUND'},'network'],[{name:'TimeoutError'},'timeout'],[new Error('unknown'),'unknown'],
  ] as const){
    const result=await collectAwsWith(runtime({cost:async()=>{throw error;}}),['r'],roles,{withActivity:false});
    const coverage=result.costCoverage![0];assert.equal(coverage.reason,reason);assert.deepEqual(coverage.failedScopes,[]);assert.equal(coverage.unit,'organization');
    assert.match(costCoverageMessage(coverage),/조직 단위 비용 조회 1건/);
    assert.equal(costIssues(toSnapshot(result),focus)[0].reason,reason);
  }
});
test('timeout before any account finishes preserves the good snapshot and exposes incomplete billing in status',async()=>withStore(async store=>{
  const original=toSnapshot({...part(),costCoverage:[{provider:'aws',state:'failed',failedScopes:[],reason:'denied'}]});await store.save('aws',original);
  let lastJob:Promise<unknown>|undefined,costCalls=0;
  configureCollector({azure:off,gcp:off,aws:{detect:async()=>'fake',collect:options=>{
    lastJob=collectAwsWith(runtime({cost:async()=>{costCalls++;return untilAborted(options.signal!);}}),['r'],roles,options);
    return lastJob as ReturnType<typeof collectAwsWith>;
  }}});
  for(let i=0;i<2;i++){
    const status=await runCollection(store,undefined,{providers:['aws'],timeoutMs:30});await lastJob?.catch(()=>{});
    assert.equal(status.providers.aws.state,'failed');assert.match(status.providers.aws.message!,/조직 단위 비용 조회 1건 미완료/);
    assert.match(status.providers.aws.stages!.find(s=>s.id==='cost')!.detail!,/전체 수집 시간 초과/);
    assert.deepEqual(await store.latest('aws'),JSON.parse(JSON.stringify(original)));
  }
  assert.equal(costCalls,2);
}));
test('legacy cost cache, including cached empty rows, refreshes once then returns to its normal cadence',async()=>withStore(async store=>{
  for(const rows of [[],[{provider:'aws' as const,scope:ids[0],service:'fake',month:'2026-11',amount:10,currency:'USD'}]]){
    await store.save('aws',toSnapshot({...part(),cost:rows},new Date().toISOString()));
    const old=(await store.latest('aws'))!;assert.equal(costIssues(old,focus)[0].reason,'unverified');
    const flags:boolean[]=[];
    configureCollector({azure:off,gcp:off,aws:{detect:async()=>'fake',collect:async options=>{flags.push(!!options.withCost);return{...part(),cost:[],costCoverage:[{provider:'aws',state:'complete',failedScopes:[]} as CostCoverage]};}}});
    await runCollection(store,undefined,{providers:['aws']});await runCollection(store,undefined,{providers:['aws']});
    assert.deepEqual(flags,[true,false]);assert.deepEqual((await store.latest('aws'))!.cost,[]);
    assert.equal(costIssues((await store.latest('aws'))!,focus).length,0);
  }
}));
test('issue-listed child records are hidden while endpoints stay visible and unknown types remain unknown',()=>{
  for(const [provider,type,kind] of [
    ['aws','ec2:security-group-rule','security'],['aws','ssm:association','configuration'],['aws','rds:pg','configuration'],['aws','events:rule','application'],['aws','elasticache:user','security'],
    ['azure','Microsoft.Insights/dataCollectionRuleAssociations','monitoring'],['gcp','iam.googleapis.com/ServiceAccountKey','security'],['gcp','compute.googleapis.com/InstanceSettings','configuration'],
  ] as const){const c=classifyResource(provider,type);assert.equal(c.kind,kind);assert.ok(isAuxiliary({provider,type,...c}));}
  assert.deepEqual(classifyResource('aws','ec2:vpc-endpoint'),{kind:'endpoint'});
  assert.deepEqual(classifyResource('aws','future:unrecognized'),{kind:'service'});
});
