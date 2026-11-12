import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {resourcePage,activityPage,PageError} from '../server/pages.ts';
import {snapshotError} from '../server/snapshot-error.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {validateSnapshot} from '../shared/schema.ts';
import app from '../server/app.ts';
const snapshot=(n=205)=>validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-12T00:00:00Z',resources:Array.from({length:n},(_,i)=>({id:`vm-${i}`,nativeId:`vm-${i}`,name:`VM ${i}`,provider:'aws',scope:i<103?'a':'b',region:'r',type:'AWS::EC2::Instance',kind:'compute',source:'fake',specs:{large:'x'.repeat(10000)}})),links:[],scopes:['a','b'],warnings:[],activity:Array.from({length:n},(_,i)=>({id:`event-${i}`,provider:'aws',scope:i<103?'a':'b',at:'2026-11-11T00:00:00Z',actor:`user-${i%3}`,actorType:'user',operation:i%2?'Write':'PutRolePolicy',label:'write',kind:'write',target:`vm-${i}`,targetName:`VM ${i}`,outcome:'ok',source:'fake'}))});

test('resource pages send at most 100 bounded summaries and visit every row without duplicates',()=>{
  const s=snapshot(),query=new URLSearchParams(),ids:string[]=[];let pages=0;
  do{const page=resourcePage(s,query);pages++;ids.push(...page.rows.map(r=>r.id));assert.equal(page.total,205);assert.ok(JSON.stringify(page).length<300_000);assert.ok(page.rows.every(r=>!('specs' in r)&&!('rules' in r)));if(!page.nextCursor)break;query.set('cursor',page.nextCursor);}while(true);
  assert.equal(pages,3);assert.equal(ids.length,205);assert.equal(new Set(ids).size,205);
});
test('cursors reject generation and filter changes, malformed input and invalid limits',()=>{
  const s=snapshot(),first=resourcePage(s,new URLSearchParams());
  assert.throws(()=>resourcePage(snapshot(206),new URLSearchParams({cursor:first.nextCursor!})),(e:unknown)=>e instanceof PageError&&e.status===409);
  assert.throws(()=>resourcePage(s,new URLSearchParams({cursor:first.nextCursor!,q:'VM 1'})),/조건/);
  assert.throws(()=>resourcePage(s,new URLSearchParams({cursor:'invalid'})),/커서/);
  for(const limit of ['0','101','NaN','1.5'])assert.throws(()=>resourcePage(s,new URLSearchParams({limit})),/크기/);
  assert.equal(resourcePage(s,new URLSearchParams({scoped:'1'})).total,0,'an empty selected scope is not all scopes');
});
test('activity filtering, summaries and pagination remain correct across tied timestamps and duplicate IDs',()=>{
  const s=snapshot();s.activity.push(s.activity[0]);
  const query=new URLSearchParams({scoped:'1',scope:'a',kind:'sensitive'}),first=activityPage(s,query);
  assert.equal(first.summary.total,103);assert.equal(first.total,52);assert.equal(first.rows.length,52);assert.equal(first.summary.sensitive,52);
  const all=activityPage(s,new URLSearchParams());assert.equal(all.total,205);assert.ok(all.nextCursor);
  const second=activityPage(s,new URLSearchParams({cursor:all.nextCursor!}));assert.equal(new Set([...all.rows,...second.rows].map(r=>r.id)).size,200);
});
test('page and detail endpoints authorize and restrict before slicing, and never expose other scopes through cursors',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-pages-')),store=new FileSnapshotStore(root),keys=['DATA_MODE','SNAPSHOT_DIR','ACCESS_TOKENS','ATLAS_LOOPBACK_ONLY'] as const;
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  await store.save('aws',snapshot());
  process.env.DATA_MODE='live';process.env.SNAPSHOT_DIR=root;delete process.env.ATLAS_LOOPBACK_ONLY;
  process.env.ACCESS_TOKENS=JSON.stringify(['a','b'].map(token=>({name:token,tokenSha256:createHash('sha256').update(token).digest('hex'),scopes:[token]})));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try{
    for(const route of ['/api/resources','/api/activity','/api/resource?id=vm-0'])assert.equal((await fetch(base+route)).status,401);
    const headers={Authorization:'Bearer a'},first=await (await fetch(base+'/api/resources',{headers})).json();
    assert.equal(first.total,103);assert.ok(first.rows.every((r:any)=>r.scope==='a'));assert.equal((await fetch(base+'/api/resource?id=vm-104',{headers})).status,404);
    const other=await fetch(base+`/api/resources?cursor=${first.nextCursor}`,{headers:{Authorization:'Bearer b'}});assert.equal(other.status,409);
    const events=await (await fetch(base+'/api/activity',{headers})).json();assert.equal(events.total,103);assert.ok(events.rows.every((r:any)=>r.scope==='a'));
    const topology=await (await fetch(base+'/api/topology?part=inventory',{headers})).json();assert.equal(topology.resources.length,0);assert.equal(topology.activity.length,0);assert.equal(topology.presentation.scopeStats.a.resources,103);
    const full=await (await fetch(base+'/api/topology?part=full',{headers})).json();assert.equal(full.activity.length,103);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}await rm(root,{recursive:true,force:true});}
});
test('snapshot error responses distinguish access, missing, invalid and internal failures without paths',()=>{
  assert.match(snapshotError(Object.assign(new Error('/private/example'),{code:'EACCES'})).error,/권한/);
  assert.equal(snapshotError(Object.assign(new Error('/private/example'),{code:'ENOENT'})).status,503);
  assert.match(snapshotError(new SyntaxError('/private/example')).error,/형식/);
  assert.match(snapshotError(new Error('/private/example')).error,/내부/);
  for(const error of [new Error('/private/example'),new SyntaxError('/private/example')])assert.doesNotMatch(JSON.stringify(snapshotError(error)),/private/);
});
