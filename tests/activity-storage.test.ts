import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FileSnapshotStore} from '../server/store.ts';
import {storeSnapshotParts,pruneActivityParts} from '../server/activity-storage.ts';
import {validateSnapshot,type Activity} from '../shared/schema.ts';
const activity=(id:string,scope='a',day='2026-11-11'):Activity=>({id,provider:'aws',scope,at:`${day}T00:00:00Z`,actor:'fake',actorType:'service',operation:'Write',label:'write',kind:'write',target:'not-collected',targetName:'not-collected',outcome:'ok',source:'fake'});
const snapshot=(rows:Activity[],collectedAt='2026-11-12T00:00:00Z')=>validateSnapshot({version:1,mode:'live',collectedAt,resources:[],links:[],scopes:['a','b'],warnings:[],activity:rows});
async function withStore(work:(root:string,store:FileSnapshotStore)=>Promise<void>){const root=await mkdtemp(path.join(tmpdir(),'atlas-activity-'));try{await work(root,new FileSnapshotStore(root));}finally{await rm(root,{recursive:true,force:true});}}

test('activity partitions are reused across generations, and version 1 remains readable and exportable',async()=>withStore(async(root,store)=>{
  const original=snapshot([activity('a1'),activity('a2'),activity('b1','b'),activity('old','a','2026-11-10')]);
  await writeFile(path.join(root,'aws.json'),JSON.stringify(original));
  assert.deepEqual(await store.latest('aws'),original);
  await store.save('aws',{...original,collectedAt:'2026-11-12T01:00:00Z'});
  const first=JSON.parse(await readFile(path.join(root,'aws.json'),'utf8'));
  assert.equal(first.storageVersion,2);assert.equal(first.snapshot.activity.length,0);assert.equal(first.activity.length,3);
  assert.deepEqual(await store.previous('aws'),original);
  await store.save('aws',{...original,collectedAt:'2026-11-12T02:00:00Z'});
  const second=JSON.parse(await readFile(path.join(root,'aws.json'),'utf8'));
  assert.deepEqual(second.activity,first.activity);
  const exported=(await store.latest('aws'))!;assert.equal(exported.version,1);assert.equal(exported.activity.length,4);assert.equal('storageVersion' in exported,false);
  assert.equal((await store.previous('aws'))!.activity.length,4);
}));
test('unpublished chunks cannot change the current generation and invalid chunks cannot become missing snapshots',async()=>withStore(async(root,store)=>{
  await store.save('aws',snapshot([activity('good')]));
  const current=await readFile(path.join(root,'aws.json'),'utf8');
  const unpublished=await storeSnapshotParts(root,'aws',snapshot([activity('unpublished')]));
  assert.equal((await store.latest('aws'))!.activity[0].id,'good');
  const manifest=JSON.parse(current),file=path.join(root,manifest.activity[0].file);
  await writeFile(file,'[]');await assert.rejects(store.latest('aws'),/integrity/);
  await rm(file);await assert.rejects(store.latest('aws'),/chunk is missing/);
  assert.equal(await readFile(path.join(root,'aws.json'),'utf8'),current);
  assert.ok(unpublished.activity.length);
}));
test('concurrent store instances serialize publication and retain a complete previous generation',async()=>withStore(async(root,store)=>{
  const other=new FileSnapshotStore(root);
  await Promise.all([store.save('aws',snapshot([activity('one')],'2026-11-12T01:00:00Z')),other.save('aws',snapshot([activity('two')],'2026-11-12T02:00:00Z'))]);
  assert.equal((await store.latest('aws'))!.activity[0].id,'two');assert.equal((await store.previous('aws'))!.activity[0].id,'one');
}));
test('cleanup preserves referenced history and recent unpublished files, deleting only old orphan chunks',async()=>withStore(async(root,store)=>{
  await store.save('aws',snapshot([activity('one')],'2026-11-12T01:00:00Z'));
  await store.save('aws',snapshot([activity('two')],'2026-11-12T02:00:00Z'));
  const orphan=await storeSnapshotParts(root,'aws',snapshot([activity('orphan')]));
  const orphanFile=path.join(root,orphan.activity[0].file),old=new Date(Date.now()-2*86_400_000);
  await pruneActivityParts(root);assert.ok(await readFile(orphanFile));
  await utimes(orphanFile,old,old);await pruneActivityParts(root);
  await assert.rejects(readFile(orphanFile),{code:'ENOENT'});
  assert.equal((await store.latest('aws'))!.activity[0].id,'two');assert.equal((await store.previous('aws'))!.activity[0].id,'one');
  assert.ok((await readdir(path.join(root,'history','aws'))).length);
}));

test('identical provider event IDs in different scopes remain distinct through storage and pagination',async()=>withStore(async(root,store)=>{
  const value=snapshot([activity('same-id','a'),activity('same-id','b')]);await store.save('aws',value);
  const read=(await store.latest('aws'))!;assert.equal(read.activity.length,2);assert.deepEqual(new Set(read.activity.map(row=>row.scope)),new Set(['a','b']));
  const {activityPage}=await import('../server/pages.ts');const page=activityPage(read,new URLSearchParams());assert.equal(page.total,2);
}));
