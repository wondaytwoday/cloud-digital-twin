import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mockSnapshot} from '../server/mock.ts';
import {age,isStale,resourceCounts,staleAfterHours} from '../shared/freshness.ts';
import {buildScopeIndex} from '../shared/hierarchy.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {emptyStatus,toSnapshot} from '../server/runner.ts';
import {liveSnapshot} from '../server/app.ts';
import {restrictSnapshot} from '../server/auth.ts';

test('the dashboard and the scope panels count the same estate, and the gap is exactly subnets and policies',async()=>{
  const s=await mockSnapshot('standard'),c=resourceCounts(s.resources);
  // The 75 and 107 a reviewer saw side by side are these two numbers.
  assert.equal(c.primary,75);assert.equal(c.all,107);assert.equal(c.all-c.primary,c.subnets+c.policies);
  assert.equal(c.all,s.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external').length,'scope panel total');
  assert.equal(c.primary,s.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external'&&r.kind!=='subnet'&&r.kind!=='firewall').length,'dashboard KPI');
});
test('stale means several missed runs, set by the operator or derived from the schedule',()=>{
  assert.equal(staleAfterHours({}),3);assert.equal(staleAfterHours({ATLAS_COLLECT_MINUTES:'240'}),12);
  assert.equal(staleAfterHours({ATLAS_COLLECT_MINUTES:'0'}),24,'no timer: a day');assert.equal(staleAfterHours({ATLAS_STALE_HOURS:'6',ATLAS_COLLECT_MINUTES:'0'}),6);
  const now=Date.parse('2026-11-07T12:00:00Z');
  assert.equal(isStale('2026-11-07T08:00:00Z',3,now),true);assert.equal(isStale('2026-11-07T10:00:00Z',3,now),false);assert.equal(isStale(undefined,3,now),false);
  assert.equal(age('2026-11-07T11:30:00Z',now),'30분 전');assert.equal(age('2026-11-06T12:00:00Z',now),'24시간 전');assert.equal(age('2026-11-01T12:00:00Z',now),'6일 전');
});
test('a partly read scope is marked up the tree, so a group total never reads as whole',async()=>{
  const s=await mockSnapshot('enterprise'),leaf=s.hierarchy.find(n=>n.scope&&n.parent)!,index=buildScopeIndex(s.hierarchy,s.resources,[leaf.scope!]);
  assert.equal(index.stats.get(leaf.id)!.incomplete,1);assert.equal(index.stats.get(leaf.parent!)!.incomplete,1);
  const root=index.pathTo(leaf.id)[0];assert.equal(index.stats.get(root.id)!.incomplete,1);
  const sibling=s.hierarchy.find(n=>n.scope&&n.id!==leaf.id&&n.provider!==leaf.provider)!;assert.equal(index.stats.get(sibling.id)!.incomplete,0);
  assert.equal(index.stats.get(root.id)!.resources,buildScopeIndex(s.hierarchy,s.resources).stats.get(root.id)!.resources,'counts are unchanged; only the mark is added');
});
const fake=async()=>{const s=await mockSnapshot('single-vm');return{resources:s.resources.map(r=>({...r,metrics:undefined,iam:[]})),links:s.links.filter(l=>l.kind!=='simulation'),warnings:[],scopeLabels:s.scopeLabels,hierarchy:s.hierarchy};};
test('a cloud whose last run failed keeps its old data on screen, flagged as stale once past the window',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),store=new FileSnapshotStore(root),old=new Date(Date.now()-5*3_600_000).toISOString();
  await store.save('aws',{...toSnapshot(await fake()),collectedAt:old});
  const status=emptyStatus();status.providers.aws={state:'failed',message:'throttled',at:new Date().toISOString()};await store.writeStatus(status);
  const saved=process.env.ATLAS_STALE_HOURS;process.env.ATLAS_STALE_HOURS='3';
  try{
    const aws=(await liveSnapshot(store))!.connections.find(c=>c.provider==='aws')!;
    assert.equal(aws.status,'failed');assert.equal(aws.collectedAt,old);assert.equal(aws.stale,true);
    process.env.ATLAS_STALE_HOURS='12';assert.equal((await liveSnapshot(store))!.connections.find(c=>c.provider==='aws')!.stale,false);
  }finally{if(saved===undefined)delete process.env.ATLAS_STALE_HOURS;else process.env.ATLAS_STALE_HOURS=saved;}
});
test('a restricted user is told their data is stale too',async()=>{
  const s=await mockSnapshot('standard'),sub=s.hierarchy.find(n=>n.name==='Platform Prod')!.scope!;
  const r=restrictSnapshot({...s,connections:s.connections.map(c=>({...c,status:'collected' as const,stale:true,collectedAt:'2026-11-01T00:00:00.000Z'}))},[sub]);
  assert.equal(r.connections[0].stale,true);
});
