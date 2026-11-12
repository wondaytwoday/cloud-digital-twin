import test from 'node:test';
import assert from 'node:assert/strict';
import type {Request} from 'express';
import {collectAwsWith,collectAwsIam,awsServiceCaller,type AwsRuntime} from '../server/collectors.ts';
import {RequestGate} from '../server/request-gate.ts';
import {setTimeout as pause} from 'node:timers/promises';
import {needsCollection} from '../server/runner.ts';
import {requestToken} from '../server/auth.ts';
import type {Stage} from '../shared/collect.ts';
import {collectionSettings} from '../server/settings.ts';
import {LoginAttempts} from '../server/login-attempts.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {searchResources,resourceSearchIndex} from '../shared/search.ts';
import {statusLabel} from '../shared/status.ts';
import {validateSnapshot} from '../shared/schema.ts';
import {health} from '../shared/topology.ts';
import {ViewCache} from '../shared/view-transport.ts';
import {viewTransport} from '../server/view-transport.ts';
import {restrictSnapshot} from '../server/auth.ts';
import {projectSnapshot} from '../shared/presentation.ts';

test('per-account SDK dispatchers share one gate and propagate cancellation',async()=>{
  const gate=new RequestGate(2),controller=new AbortController();let active=0,max=0,calls=0;
  class Command{constructor(public input:unknown){}}
  const client={send:async(_command:unknown,options:{abortSignal?:AbortSignal})=>{
    assert.equal(options.abortSignal,controller.signal);calls++;active++;max=Math.max(max,active);await pause(3);active--;return{};
  }};
  const callers=Array.from({length:3},()=>awsServiceCaller({ec2:client},{ec2:{DescribeVpcsCommand:Command}},{requests:gate,signal:controller.signal}));
  await Promise.all(callers.flatMap(call=>Array.from({length:3},()=>call('ec2','DescribeVpcs'))));
  assert.equal(calls,9);assert.equal(max,2);
  controller.abort();assert.throws(()=>callers[0]('ec2','DescribeVpcs'));assert.equal(calls,9);
});

test('IAM runs bounded workers and coalesces group policy pages without losing MFA or keys',async()=>{
  let active=0,max=0,groups=0;
  const result=await collectAwsIam(async(_service,op)=>{
    active++;max=Math.max(active,max);await pause(2);active--;
    if(op==='ListUsers')return{Users:Array.from({length:6},(_,i)=>({UserName:`u-${i}`}))};
    if(op==='ListAttachedUserPolicies')return{AttachedPolicies:[{PolicyName:'ReadOnlyAccess'}]};
    if(op==='ListGroupsForUser')return{Groups:[{GroupName:'shared'}]};
    if(op==='ListAttachedGroupPolicies'){groups++;return{AttachedPolicies:[{PolicyName:'GroupPolicy'}]};}
    if(op==='ListMFADevices')return{MFADevices:[{}]};
    if(op==='ListAccessKeys')return{AccessKeyMetadata:[{Status:'Active',CreateDate:'2020-01-01'}]};
    if(op==='ListRoles')return{Roles:[{RoleName:'reader',Path:'/'},{RoleName:'service',Path:'/aws-service-role/'}]};
    if(op==='ListAttachedRolePolicies')return{AttachedPolicies:[{PolicyName:'ReadOnlyAccess'}]};
    throw new Error(`Unexpected ${op}`);
  },'111111111111',{concurrency:3});
  assert.equal(result.warning,undefined);assert.equal(groups,1);assert.equal(max,3);
  assert.equal(result.iam.length,13);
  assert.ok(result.iam.filter(a=>a.principalType==='user').every(a=>a.mfa===true&&a.keyAgeDays!>0));
  const controller=new AbortController();controller.abort();
  await assert.rejects(collectAwsIam(async()=>{throw new Error('must not call');},'fake',{signal:controller.signal}));
  const broken=await collectAwsIam(async()=>({Users:[],IsTruncated:true,Marker:'same'}),'fake');
  assert.match(broken.warning!,/IAM을 읽지 못했습니다/);
});

test('view transport reuses validated cores but rejects missing versions and invalid metadata',()=>{
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-12T00:00:00Z',resources:[{id:'vpc',nativeId:'vpc',name:'vpc',provider:'aws',scope:'a',kind:'network',type:'fake',region:'r',source:'fake'}],links:[],warnings:[],scopes:['a']});
  const client=new ViewCache();
  const first=client.decode(viewTransport(projectSnapshot(snapshot,'map'),undefined));
  const next=viewTransport(projectSnapshot(snapshot,'network'),client.revision);
  assert.ok('metadata' in next);
  const second=client.decode(next);
  assert.equal(second.resources,first.resources);
  assert.equal(second.presentation?.part,'network');
  assert.throws(()=>new ViewCache().decode(next),/버전/);
  if('metadata' in next){
    assert.throws(()=>client.decode({...next,metadata:{...next.metadata,resources:[]}}));
    assert.throws(()=>client.decode({...next,metadata:{...next.metadata,hierarchy:[{id:'x',parent:'absent',name:'x',nativeId:'x',kind:'account',provider:'aws'}]}}),/Missing hierarchy parent/);
    assert.throws(()=>client.decode({...next,metadata:{...next.metadata,activity:[{id:'demo-event',provider:'aws',scope:'a',at:'2026-11-12T00:00:00Z',kind:'write',actor:'x',actorType:'user',operation:'x',label:'x',target:'x',targetName:'x',outcome:'ok',source:'fake'}]}}),/demo activity/);
  }
  const changed=validateSnapshot({...snapshot,resources:[{...snapshot.resources[0],name:'changed'}]});
  assert.ok('snapshot' in viewTransport(changed,client.revision));
  const other=restrictSnapshot(snapshot,['b']);
  const denied=viewTransport(other,client.revision);
  assert.ok('snapshot' in denied);
  assert.equal(client.decode(denied).resources.length,0);
  client.clear();assert.equal(client.revision,undefined);
});

test('search reuses normalized text, handles Korean normalization and bounds suggestions',()=>{
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-12T00:00:00Z',resources:Array.from({length:25},(_,i)=>({id:`vm-${i}`,nativeId:`vm-${i}`,name:`한글 WEB ${i}`,provider:'aws',scope:'a',kind:'compute',type:'fake',region:'r',source:'fake'})),links:[],warnings:[],scopes:['a'],scopeLabels:{a:'한국 서비스'}});
  assert.equal(resourceSearchIndex(snapshot),resourceSearchIndex(snapshot));
  assert.equal(searchResources(snapshot,'WEB').length,10);
  assert.equal(searchResources(snapshot,'한국',Infinity).length,25);
  assert.equal(searchResources(snapshot,'한글'.normalize('NFD'),1)[0].id,'vm-0');
  assert.equal(searchResources(snapshot,'   ').length,0);
  assert.equal(searchResources(snapshot,'한글',0).length,0);
});

test('status translations preserve provisioning meaning and do not label unknowns healthy',()=>{
  assert.equal(statusLabel('Succeeded'),'프로비저닝 성공');
  assert.equal(statusLabel('running'),'실행 중');
  assert.equal(statusLabel('future-state'),'future-state');
  assert.equal(statusLabel(''),'상태 미확인');
  assert.notEqual(health('future-state'),'ok');
});

test('duration settings preserve disabled cadence and reject invalid or overflowing timers',()=>{
  assert.deepEqual(collectionSettings({}),{minutes:60,timeoutMinutes:15,costHours:24});
  assert.equal(collectionSettings({ATLAS_COLLECT_MINUTES:'0'}).minutes,0);
  for(const raw of ['','NaN','Infinity','-1','1e99','0.00000000001']){
    const warnings:string[]=[];
    assert.deepEqual(collectionSettings({ATLAS_COLLECT_MINUTES:raw,ATLAS_COLLECT_TIMEOUT_MIN:raw,ATLAS_COST_HOURS:raw},s=>warnings.push(s)),{minutes:60,timeoutMinutes:15,costHours:24});
    assert.equal(warnings.length,3);
  }
  assert.equal(collectionSettings({ATLAS_COLLECT_TIMEOUT_MIN:'0'}).timeoutMinutes,15);
  assert.equal(collectionSettings({ATLAS_COLLECT_MINUTES:'0.5'}).minutes,0.5);
});

test('login limits expire, remain bounded, and cannot evict an active ban',()=>{
  const attempts=new LoginAttempts(2,100,2);
  assert.equal(attempts.allow('a',0),true);
  assert.equal(attempts.allow('a',1),true);
  assert.equal(attempts.allow('a',2),false);
  assert.equal(attempts.allow('b',3),true);
  assert.equal(attempts.allow('c',4),false);
  assert.equal(attempts.allow('a',5),false);
  assert.equal(attempts.allow('c',100),true);
  assert.equal(attempts.allow('a',101),false);
  assert.equal(attempts.allow('a',103),true);
});

test('importing environment helpers does not load files from the working directory',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-env-isolation-'));
  try{
    await writeFile(path.join(root,'.env'),'ATLAS_TEST_IMPORT_SENTINEL=unexpected\n');
    const loader=import.meta.resolve('tsx'),module=new URL('../server/env.ts',import.meta.url).href;
    const env={...process.env};delete env.ATLAS_TEST_IMPORT_SENTINEL;
    const child=spawnSync(process.execPath,['--import',loader,'--input-type=module','-e',`await import(${JSON.stringify(module)}); if(process.env.ATLAS_TEST_IMPORT_SENTINEL)process.exit(9);`],{cwd:root,env,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('disabled automatic collection stays disabled even with no prior snapshot',()=>{
  assert.equal(needsCollection(null,0),false);
  assert.equal(needsCollection(null,NaN),false);
});

test('malformed session cookies fail authentication without throwing',()=>{
  const request=(headers:Request['headers'])=>({headers} as Request);
  assert.equal(requestToken(request({cookie:'atlas_session=%E0%A4%A'})),undefined);
  assert.equal(requestToken(request({cookie:'atlas_session=hello%20world'})),'hello world');
  assert.equal(requestToken(request({authorization:'Bearer valid',cookie:'atlas_session=%'})),'valid');
});

test('AWS resource progress consistently counts finished accounts across regions and failures',async()=>{
  const ids=['111111111111','222222222222'];
  const runtime:AwsRuntime={
    identity:async()=>ids[0],hierarchy:async()=>[],assume:async role=>{
      if(role.label===ids[1])throw new Error('fake denied');return{};
    },regions:async()=>['r1','r2','r3'],
    resources:async()=>({resources:[],links:[],warnings:[],scopeLabels:{}}),
    iam:async()=>({iam:[]}),inventory:async()=>({rows:[]}),activity:async()=>[],cost:async()=>[],
  };
  const progress:Partial<Stage>[]=[];let current:Partial<Stage>={};
  await collectAwsWith(runtime,[],ids.map(id=>({label:id,roleArn:`arn:aws:iam::${id}:role/Reader`})),{
    withCost:false,withActivity:false,report:(id,patch)=>{
      if(id==='resources'){current={...current,...patch};progress.push(current);}
    },
  });
  assert.ok(progress.length>4);
  let previous=0;
  for(const p of progress){
    assert.equal(p.total,2);
    assert.ok(p.done!==undefined&&p.done>=previous&&p.done<=2,JSON.stringify(p));
    previous=p.done!;
  }
  assert.equal(progress.at(-1)!.done,2);
  assert.match(progress.at(-1)!.detail!,/실패 1/);
});

test('known backup types summarize and only proven latest active task revisions stay detailed',async()=>{
  const {classifyResource,collectionTier}=await import('../shared/classification.ts');
  const {compactInventory}=await import('../server/inventory.ts');
  const types=['ec2:snapshot','ec2:image','ecs:task-definition','memorydb:parametergroup','fsx:backup'];
  for(const type of types){const r={provider:'aws' as const,type,...classifyResource('aws',type)};assert.equal(collectionTier(r),2);assert.notEqual(r.kind,'service');}
  const task=(revision:string,status='ACTIVE')=>({id:revision,nativeId:`arn:aws:ecs:r:a:task-definition/app:${revision}`,name:revision,provider:'aws',scope:'a',region:'r',kind:'configuration',type:'ecs:task-definition',status,source:'fake'});
  const s=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-12T00:00:00Z',resources:[task('2'),task('9'),task('10'),task('11','INACTIVE'),task('12','구성 수집됨')],links:[{id:'ref',source:'2',target:'10',kind:'reference',label:'ref',evidence:'fake'}],warnings:[],scopes:['a']});
  const compact=compactInventory(s,null,'summary');
  assert.deepEqual(compact.resources.map(r=>r.id),['2','10','12']);
  assert.equal(compact.inventorySummary?.[0].count,2);
});
