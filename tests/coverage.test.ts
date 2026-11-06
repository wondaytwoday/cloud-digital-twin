import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {collectAzureWith,collectGcpAuto} from '../server/collectors.ts';
import {combineGaps} from '../server/normalize.ts';
import {mockSnapshot} from '../server/mock.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {configureCollector,runCollection,type ProviderDriver} from '../server/runner.ts';
import {liveSnapshot} from '../server/app.ts';
import {restrictSnapshot} from '../server/auth.ts';

const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
// An Azure estate where everything answers except the parts a test turns off.
const azure=(fail:{iam?:boolean;activity?:boolean;costFor?:string[]})=>(async(url:unknown,init?:RequestInit)=>{
  const u=String(url),body=String(init?.body??'');
  if(u.includes('ResourceGraph'))return body.includes('authorizationresources')&&fail.iam?json({},403):json({data:[]});
  if(u.includes('eventtypes'))return fail.activity?json({},403):json({value:[]});
  if(u.includes('CostManagement'))return fail.costFor?.some(s=>u.includes(s))?json({},403):json({properties:{columns:[],rows:[]}});
  if(u.includes('/tenants')||u.includes('managementGroups'))return json({value:[]});
  return json({displayName:'S',tenantId:'t'});
}) as typeof fetch;

test('several reads of one kind: all failing is a failure, some is partial',()=>{
  assert.equal(combineGaps(['failed','failed']),'failed');assert.equal(combineGaps(['failed',undefined]),'partial');
  assert.equal(combineGaps([undefined,undefined]),undefined);assert.equal(combineGaps([]),undefined,'nothing tried is not a failure');
  assert.equal(combineGaps([undefined,'unconfigured']),'unconfigured');
});
test('Azure says which kinds of data it could not read, and how much of each',async()=>{
  const ok=await collectAzureWith([A,B],async()=>'t',azure({}));assert.equal(ok.gaps,undefined);
  const r=await collectAzureWith([A,B],async()=>'t',azure({iam:true,activity:true,costFor:[A]}));
  assert.deepEqual(r.gaps,{iam:'failed',activity:'failed',cost:'partial'});
  assert.equal((await collectAzureWith([A,B],async()=>'t',azure({costFor:[A,B]}))).gaps?.cost,'failed');
});
test('GCP totals IAM across projects and calls a missing billing table unconfigured, not failed',async()=>{
  const gcp=(iamFails:string[])=>async(url:string)=>{
    if(url.includes('organizations:search'))return {organizations:[]};
    if(url.includes('/v1/projects?'))return {projects:[{projectId:'p1'},{projectId:'p2'}]};
    if(url.includes('contentType=IAM_POLICY')&&iamFails.some(p=>url.includes(`projects/${p}/`)))throw new Error('403 denied');
    return {assets:[],entries:[]};
  };
  const saved=process.env.ATLAS_GCP_BILLING_TABLE;delete process.env.ATLAS_GCP_BILLING_TABLE;
  try{
    assert.deepEqual((await collectGcpAuto(gcp(['p2']) as any)).gaps,{iam:'partial',cost:'unconfigured'});
    assert.equal((await collectGcpAuto(gcp(['p1','p2']) as any)).gaps?.iam,'failed');
  }finally{if(saved!==undefined)process.env.ATLAS_GCP_BILLING_TABLE=saved;}
});

const fake=async(gaps?:object)=>{const s=await mockSnapshot('single-vm');return{resources:s.resources.map(r=>({...r,metrics:undefined,iam:[]})),links:s.links.filter(l=>l.kind!=='simulation'),warnings:[],scopeLabels:s.scopeLabels,hierarchy:s.hierarchy,cost:[],...(gaps?{gaps}:{})};};
const off:ProviderDriver={detect:async()=>{throw new Error('Could not load credentials');},collect:async()=>{throw new Error('unused');}};
test('each cloud carries what it read to every user, and cost skipped by schedule keeps its last state',async()=>{
  const store=new FileSnapshotStore(await mkdtemp(path.join(tmpdir(),'atlas-')));
  configureCollector({aws:{detect:async()=>'a',collect:async({withCost})=>fake(withCost?{iam:'failed',cost:'failed'}:{iam:'failed'})},azure:off,gcp:off});
  try{
    await runCollection(store);assert.deepEqual((await store.latest('aws'))!.coverage,{iam:'failed',activity:'ok',cost:'failed'});
    await runCollection(store);assert.equal((await store.latest('aws'))!.coverage!.cost,'failed','the cost on screen is still from the failed read');
    const merged=(await liveSnapshot(store))!,aws=merged.connections.find(c=>c.provider==='aws')!;
    assert.deepEqual(aws.datasets,{iam:'failed',activity:'ok',cost:'failed'});
    const scope=merged.scopes[0];assert.deepEqual(restrictSnapshot(merged,[scope]).connections[0].datasets,aws.datasets);
  }finally{configureCollector();}
});
