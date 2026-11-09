import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {collectAwsWith,collectAzureWith,type AwsRuntime} from '../server/collectors.ts';
import {finish,type Normalized} from '../server/normalize.ts';
import {retainIncomplete} from '../server/reconcile.ts';
import {configureCollector,runCollection,toSnapshot} from '../server/runner.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {IamAssignmentSchema,ResourceSchema} from '../shared/schema.ts';

const scope='111111111111';
const resource=(id:string,kind:'network'|'subnet'='network',parent?:string)=>ResourceSchema.parse({
  id:`aws:${scope}/r/${id}`,nativeId:`${scope}/r/${id}`,name:id,provider:'aws',scope,region:'r',kind,type:`AWS::EC2::${kind==='network'?'VPC':'Subnet'}`,source:'fake Describe APIs',parent,
});
const vpc=resource('vpc-a'),subnet=resource('subnet-a','subnet',vpc.id);
const part=(resources=[vpc]):Normalized=>({resources,links:[],warnings:[],scopeLabels:{[scope]:scope},collectedScopes:[scope]});
const iam=IamAssignmentSchema.parse({id:'assignment',provider:'aws',principal:'reader',principalType:'role',role:'ReadOnly',scope,level:'scope',privileged:false,source:'fake IAM'});

test('an IAM read failure preserves old assignments even after the account inventory completes, until a successful empty read',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-iam-retain-'));
  const store=new FileSnapshotStore(root);let fail=true;
  const runtime:AwsRuntime={
    identity:async()=>scope,hierarchy:async()=>[],assume:async()=>({}),regions:async()=>['r'],resources:async()=>part(),
    iam:async()=>({iam:[],...(fail?{warning:'fake IAM access denied'}:{})}),inventory:async()=>({rows:[]}),activity:async()=>[],cost:async()=>[],
  };
  const off={detect:async()=>{throw new Error('not selected');},collect:async()=>{throw new Error('not selected');}};
  try{
    await store.save('aws',toSnapshot({...part(),iam:[iam]}));
    configureCollector({azure:off,gcp:off,aws:{detect:async()=>'fake',collect:options=>collectAwsWith(runtime,['r'],[],{...options,withActivity:false})}});
    for(let attempt=0;attempt<2;attempt++){
      const status=await runCollection(store,undefined,{providers:['aws']});
      const saved=(await store.latest('aws'))!;
      assert.equal(status.providers.aws.state,'partial');
      assert.deepEqual(saved.scopes,[scope]);
      assert.equal(saved.iam.length,1);
      assert.match(saved.iam[0].source,/이전 수집/);
      assert.equal(saved.iam[0].source.match(/이전 수집/g)?.length,1);
    }
    fail=false;
    assert.equal((await runCollection(store,undefined,{providers:['aws']})).providers.aws.state,'ok');
    assert.deepEqual((await store.latest('aws'))!.iam,[]);
  }finally{configureCollector();await rm(root,{recursive:true,force:true});}
});

test('a fresh subnet keeps its reported parent when the failed VPC read is restored from the last snapshot',()=>{
  const previous=toSnapshot(part([vpc,subnet]));
  const fresh=finish([{...part([subnet]),incomplete:[scope]}]);
  assert.equal(fresh.resources[0].parent,undefined);
  assert.equal(fresh.resources[0].specs['미수집 상위 참조'],vpc.id);
  const merged=retainIncomplete(fresh,previous),saved=toSnapshot(merged);
  const restored=saved.resources.find(r=>r.id===subnet.id)!;
  assert.equal(restored.parent,vpc.id);
  assert.equal(restored.specs['미수집 상위 참조'],undefined);
  assert.match(saved.resources.find(r=>r.id===vpc.id)!.specs['수집 상태'],/이전 값 유지/);
  assert.equal(fresh.resources[0].parent,undefined);
  assert.equal(previous.resources.find(r=>r.id===vpc.id)!.specs['수집 상태'],undefined);
});

test('a partial activity refresh prefers a newly read event over a cached copy with the same ID',()=>{
  const event={id:'event',provider:'aws' as const,at:'2026-11-09T00:00:00.000Z',actor:'reader',actorType:'user' as const,operation:'UpdateVpc',label:'old label',kind:'write' as const,target:vpc.id,targetName:'vpc-a',scope,outcome:'ok' as const,source:'fake CloudTrail'};
  const previous=toSnapshot({...part(),activity:[event]});
  const merged=retainIncomplete({...part(),incomplete:[scope],activity:[{...event,label:'fresh label'}]},previous);
  assert.equal(merged.activity?.length,1);
  assert.equal(merged.activity?.[0].label,'fresh label');
});

test('an empty collected GCP project is recognized through its hierarchy instead of an assumed AWS provider',()=>{
  const target='gcp://compute.googleapis.com/projects/empty/global/networks/peer';
  const result=finish([{resources:[vpc],links:[{id:'peer',source:vpc.id,target,kind:'peering',label:'Peer',evidence:'fake configuration'}],warnings:[],scopeLabels:{},collectedScopes:['empty'],hierarchy:[{id:'gcp:scope:empty',name:'empty',provider:'gcp',kind:'project',nativeId:'empty',scope:'empty'}]}]);
  assert.equal(result.resources.find(r=>r.id===target)!.reference?.reason,'unknown');
});

test('an unresolved AWS reference is denied only by evidence from its own region',()=>{
  const target=`aws:${scope}/other-region/vpc-peer`;
  const input:Normalized={...part(),links:[{id:'peer',source:vpc.id,target,kind:'peering',label:'Peer',evidence:'fake configuration'}],collectionGaps:[{provider:'aws',scope,region:'r',operation:'DescribeVpcs',reason:'denied',code:'AccessDenied'}]};
  assert.equal(finish([input]).resources.find(r=>r.id===target)!.reference?.reason,'unknown');
  input.collectionGaps![0].region='other-region';
  assert.equal(finish([input]).resources.find(r=>r.id===target)!.reference?.reason,'denied');
});

test('an empty Azure subscription remains collected, and an IAM failure keeps its old assignments',async()=>{
  const subscription='00000000-0000-4000-8000-000000000001';let failIam=true;
  const request=(async(url,init)=>{
    const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
    if(String(url).includes('ResourceGraph')){
      if(failIam&&JSON.parse(String(init?.body)).query.includes('authorizationresources'))return json({},403);
      return json({data:[]});
    }
    if(String(url).includes('/subscriptions/'))return json({displayName:'Empty subscription'});
    return json({value:[]});
  }) as typeof fetch;
  const failed=await collectAzureWith([subscription],async()=>'fake',request,{withCost:false,withActivity:false});
  assert.deepEqual(failed.collectedScopes,[subscription]);
  assert.deepEqual(failed.iamIncomplete,[subscription]);
  const previous=toSnapshot({...failed,iam:[{...iam,id:'azure-assignment',provider:'azure',scope:subscription}]});
  const saved=toSnapshot(retainIncomplete(failed,previous));
  assert.deepEqual(saved.scopes,[subscription]);
  assert.equal(saved.hierarchy.find(n=>n.scope===subscription)?.name,'Empty subscription');
  assert.equal(saved.iam.length,1);
  failIam=false;
  const complete=await collectAzureWith([subscription],async()=>'fake',request,{withCost:false,withActivity:false});
  assert.deepEqual(toSnapshot(retainIncomplete(complete,saved)).iam,[]);
});
