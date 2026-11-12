import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeAws,normalizeAzure,normalizeGcp,finish,type Normalized} from '../server/normalize.ts';
import {collectAwsAccount,collectAwsInventory,collectAwsWith,collectGcpWith,collectGcpAuto,collectAwsActivity,gcpActivity,type AwsRuntime} from '../server/collectors.ts';
import {configureCollector,runCollection,needsCollection,emptyStatus} from '../server/runner.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {ResourceSchema,validateSnapshot} from '../shared/schema.ts';
import {computeTopology,defaultExpanded,setLayoutEngine} from '../src/layout.ts';
import ELK from 'elkjs/lib/elk.bundled.js';
const at='2026-11-12T00:00:00Z';
const part:Normalized={resources:[],links:[],warnings:[],scopeLabels:{},collectedScopes:['a']};

test('multi-interface VMs and multi-subnet services never select the first physical boundary',()=>{
  const aws=normalizeAws({Reservations:[{Instances:[{InstanceId:'vm',NetworkInterfaces:[{SubnetId:'s1',VpcId:'v1'},{SubnetId:'s2',VpcId:'v2'}]}]}],LoadBalancers:[{LoadBalancerName:'lb',VpcId:'v1',AvailabilityZones:[{SubnetId:'s1'},{SubnetId:'s2'}]}],DBInstances:[{DBInstanceIdentifier:'db',DBSubnetGroup:{VpcId:'v1',Subnets:[{SubnetIdentifier:'s1'},{SubnetIdentifier:'s2'}]}}]},'a','r');
  assert.equal(aws.resources.find(r=>r.kind==='compute')!.parent,undefined);
  assert.ok(aws.resources.filter(r=>r.kind==='database'||r.kind==='loadbalancer').every(r=>r.parent==='aws:a/r/v1'));
  assert.equal(aws.links.filter(l=>l.label==='NIC 서브넷 참조').length,2);
  const base='/subscriptions/a/resourcegroups/g/providers/microsoft.network/virtualnetworks/';
  const azure=normalizeAzure([{id:'/vm',name:'vm',type:'microsoft.compute/virtualmachines',subscriptionId:'a',properties:{networkProfile:{networkInterfaces:[{id:'/nic1'},{id:'/nic2'}]}}},...['1','2'].map(n=>({id:`/nic${n}`,type:'microsoft.network/networkinterfaces',properties:{ipConfigurations:[{properties:{subnet:{id:`${base}v${n}/subnets/s`}}}]}}))]);
  assert.equal(azure.resources.find(r=>r.kind==='compute')!.parent,undefined);assert.equal(azure.links.length,2);
  const gcp=normalizeGcp([{name:'//compute.googleapis.com/projects/a/zones/r/instances/vm',assetType:'compute.googleapis.com/Instance',resource:{data:{name:'vm',networkInterfaces:[{subnetwork:'projects/a/regions/r/subnetworks/s1',network:'projects/a/global/networks/v1'},{subnetwork:'projects/a/regions/r/subnetworks/s2',network:'projects/a/global/networks/v2'}]}}}]);
  assert.equal(gcp.resources[0].parent,undefined);assert.equal(gcp.links.filter(l=>l.label==='NIC 서브넷 참조').length,2);
});
test('reference layers are explicit and policy counts stay available while policy edges are hidden',async()=>{
  setLayoutEngine(new (ELK as any)());
  const resources=['a','b','policy'].map(id=>ResourceSchema.parse({id,nativeId:id,name:id,provider:'aws',scope:'scope',region:'r',kind:id==='policy'?'firewall':'network',type:'fake',source:'fake'}));
  const s=validateSnapshot({version:1,mode:'live',collectedAt:at,resources,links:[{id:'ref',source:'a',target:'b',kind:'reference',label:'ref',evidence:'source ref'},{id:'policy',source:'policy',target:'a',kind:'policy',label:'policy',evidence:'attachment'}],scopes:['scope'],warnings:[]});
  const filter={provider:'all',scopes:null,policy:false,flow:false,expanded:defaultExpanded(s,2)};
  const hidden=await computeTopology(s,{...filter,layers:new Set(['network'])});assert.equal(hidden.edges.length,0);assert.equal(hidden.nodes.find(n=>n.id==='a')!.policies,1);
  const shown=await computeTopology(s,{...filter,layers:new Set(['network','reference'])});assert.equal(shown.edges.length,1);assert.equal(shown.edges[0].kind,'reference');assert.equal(s.links.length,2);
});
test('cyclic parent references fail before hierarchical rendering or scope authorization',()=>{
  const s={version:1,mode:'live',collectedAt:at,resources:[{id:'a',nativeId:'a',name:'a',provider:'aws',scope:'s',kind:'network',region:'r',type:'fake',source:'fake',parent:'b'},{id:'b',nativeId:'b',name:'b',provider:'aws',scope:'s',kind:'network',region:'r',type:'fake',source:'fake',parent:'a'}],links:[],warnings:[],scopes:['s']};
  assert.throws(()=>validateSnapshot(s),/Cyclic resource/);
  assert.throws(()=>validateSnapshot({...s,resources:[],hierarchy:[{id:'a',parent:'a',provider:'aws',kind:'account',scope:'s',nativeId:'s',name:'s'}]}),/Cyclic hierarchy/);
});
test('storage-only inventory uses an upstream filter and cost-only runs avoid member service and hierarchy APIs',async()=>{
  const inputs:any[]=[];
  await collectAwsInventory(async(_s,_o,input)=>{inputs.push(input);return{Resources:[]};},['storage']);
  assert.match(inputs[0].Filters.FilterString,/^resourcetype:s3:bucket,/);
  const foreign=await collectAwsInventory(async(_s,_o,input)=>{inputs.push(input);return{Resources:[{OwningAccountId:'222222222222',ResourceType:'s3:bucket'}]};},['storage'],undefined,'111111111111');
  assert.match(inputs[1].Filters.FilterString,/accountid:111111111111/);assert.deepEqual(foreign.rows,[]);assert.match(foreign.warning!,/OwnershipMismatch/);
  const never=async()=>{throw new Error('unselected API called');};
  const runtime:AwsRuntime={identity:async()=>'a',hierarchy:never,assume:never,regions:never,resources:never,iam:never,inventory:never,activity:never,cost:async()=>[]};
  const result=await collectAwsWith(runtime,[],[],{items:['cost'],withCost:true,withIam:false,withActivity:false});assert.equal(result.costCoverage?.[0].state,'complete');
  const old=process.env.ATLAS_GCP_BILLING_TABLE;delete process.env.ATLAS_GCP_BILLING_TABLE;
  try{assert.equal((await collectGcpAuto(never,{items:['cost'],withCost:true})).costCoverage?.[0].state,'unconfigured');}finally{if(old!==undefined)process.env.ATLAS_GCP_BILLING_TABLE=old;}
});
test('pagination aborts before a subsequent SDK or asset call, preserving the abort reason',async()=>{
  for(const provider of ['aws','gcp']){
    const controller=new AbortController(),reason=new Error('synthetic cancellation');let calls=0;
    const work=provider==='aws'?collectAwsAccount(async()=>{calls++;controller.abort(reason);return{NextToken:'more'};},'a','r',undefined,['network'],controller.signal):collectGcpWith('projects/a',async()=>{calls++;controller.abort(reason);return{assets:[],nextPageToken:'more'};},{signal:controller.signal});
    await assert.rejects(work,e=>e===reason);assert.equal(calls,1);
  }
});
test('activity caps and repeated page tokens are visible rather than complete empty results',async()=>{
  let page=0;
  const aws=await collectAwsActivity(async()=>({Events:Array.from({length:50},(_,i)=>({EventId:`${page}-${i}`,EventTime:new Date(at),EventName:'Write'})),NextToken:`page-${++page}`}), 'a','r',new Date(at),{wait:async()=>{}});
  assert.equal(aws.length,500);assert.deepEqual(aws.truncatedScopes,['a']);
  await assert.rejects(gcpActivity(['projects/a'],async()=>({entries:[],nextPageToken:'same'})),/repeated pagination/);
});
test('an uncooperative credential probe cannot overlap or publish after timeout, and retry succeeds after settlement',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-probe-')),store=new FileSnapshotStore(root);let release!:()=>void,calls=0,collections=0;
  const held=new Promise<void>(resolve=>{release=resolve;}),off={detect:async()=>{throw new Error('not selected');},collect:async()=>part};
  configureCollector({azure:off,gcp:off,aws:{detect:async()=>{calls++;if(calls===1)await held;return'fake';},collect:async()=>{collections++;return structuredClone(part);}}});
  try{
    await runCollection(store,undefined,{providers:['aws'],detectTimeoutMs:5});
    const blocked=await runCollection(store,undefined,{providers:['aws']});assert.equal(calls,1);assert.match(blocked.providers.aws.message!,/이전 요청.*로그인 확인/);assert.equal(collections,0);
    release();await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await runCollection(store,undefined,{providers:['aws']})).providers.aws.state,'ok');assert.equal(calls,2);assert.equal(collections,1);
  }finally{release();configureCollector();await rm(root,{recursive:true,force:true});}
});
test('selected runs do not postpone the automatic full-collection cadence',()=>{
  const state={...emptyStatus(),mode:'selected' as const,finishedAt:at,fullFinishedAt:'2026-11-11T00:00:00Z',providers:{azure:{state:'ok' as const},aws:{state:'ok' as const},gcp:{state:'ok' as const}}};
  assert.equal(needsCollection(state,60,Date.parse(at)),true);assert.equal(needsCollection(state,0),false);
});

test('healthy AWS runs never materialize lazy checkpoints, whose captured membership stays fixed',async()=>{
  const ids=Array.from({length:8},(_,i)=>String(111111111111+i));let reads=0;
  const checkpoints:(()=>Normalized)[]=[];
  const runtime:AwsRuntime={identity:async()=>ids[0],hierarchy:async()=>[],assume:async()=>({}),regions:async()=>['r'],resources:async(_c,scope)=>({get resources(){reads++;return[ResourceSchema.parse({id:scope,nativeId:scope,name:scope,provider:'aws',scope,region:'r',type:'AWS::EC2::VPC',kind:'network',source:'fake'})];},links:[],scopeLabels:{},warnings:[]}),iam:async()=>({iam:[]}),inventory:async()=>({rows:[]}),activity:async()=>[],cost:async()=>[]};
  await collectAwsWith(runtime,['r'],ids.map(id=>({label:id,roleArn:`arn:aws:iam::${id}:role/Reader`})),{withCost:false,withActivity:false,checkpointLazy:materialize=>{checkpoints.push(materialize);}});
  assert.equal(checkpoints.length,8);assert.ok(reads<=8*4,`resource reads ${reads} should scale linearly before recovery`);
  const first=checkpoints[0]();assert.equal(first.collectedScopes?.length,1);assert.equal(first.resources.length,1);
  assert.equal(checkpoints.at(-1)!().resources.length,8);
});
