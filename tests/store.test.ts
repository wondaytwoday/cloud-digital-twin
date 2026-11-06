import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mockSnapshot} from '../server/mock.ts';
import {FileSnapshotStore,type StoreFs} from '../server/store.ts';
import {toSnapshot} from '../server/runner.ts';

const result=async(id:'single-vm'|'web-tier')=>{const s=await mockSnapshot(id);return{resources:s.resources.map(r=>({...r,metrics:undefined,iam:[]})),links:s.links.filter(l=>l.kind!=='simulation'),warnings:[],scopeLabels:s.scopeLabels,hierarchy:s.hierarchy};};
const at=(iso:string)=>async(id:'single-vm'|'web-tier')=>({...toSnapshot(await result(id)),collectedAt:iso});
const real:StoreFs={writeFile:(f,d)=>writeFile(f,d),copyFile,rename,rm,mkdir,readdir,readFile};
// Fails one step of a save, the way a full disk or a killed process would.
const failing=(step:'write'|'copy'|'rename'):{fs:StoreFs;arm:()=>void}=>{let armed=false;const boom=()=>Object.assign(new Error('ENOSPC: no space left on device'),{code:'ENOSPC'});
  return{arm:()=>{armed=true;},fs:{...real,
    writeFile:async(f,d)=>{if(armed&&step==='write'&&f.endsWith('.tmp')&&!f.includes('status'))throw boom();return real.writeFile(f,d);},
    copyFile:async(a,b)=>{if(armed&&step==='copy')throw boom();return real.copyFile(a,b);},
    rename:async(a,b)=>{if(armed&&step==='rename'&&a.endsWith('.tmp')&&!a.includes('status'))throw boom();return real.rename(a,b);}}};};

for(const step of ['write','copy','rename'] as const)test(`a save that fails at the ${step} step leaves the last good snapshot and history as they were`,async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),{fs,arm}=failing(step),store=new FileSnapshotStore(root,fs);
  await store.save('aws',await at('2026-01-01T00:00:00.000Z')('single-vm'));await store.save('aws',await at('2026-01-02T00:00:00.000Z')('single-vm'));
  const history=await readdir(path.join(root,'history','aws'));
  arm();
  await assert.rejects(store.save('aws',await at('2026-01-03T00:00:00.000Z')('web-tier')),/ENOSPC/);
  assert.equal((await store.latest('aws'))?.collectedAt,'2026-01-02T00:00:00.000Z','readers still get the last good snapshot');
  assert.equal((await store.previous('aws'))?.collectedAt,'2026-01-01T00:00:00.000Z','the next diff still compares against the real previous run');
  assert.deepEqual(await readdir(path.join(root,'history','aws')),history);
  assert.deepEqual((await readdir(root)).filter(f=>f.endsWith('.tmp')),[],'no half-written file is left behind');
});
test('a snapshot that would not read back is refused before anything is touched',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),store=new FileSnapshotStore(root),good=await at('2026-01-01T00:00:00.000Z')('single-vm');
  await store.save('aws',good);
  await assert.rejects(store.save('aws',{...good,resources:[...good.resources,good.resources[0]]}),/Duplicate resource ID/);
  assert.equal((await store.latest('aws'))?.collectedAt,good.collectedAt);
});
test('an unreadable current snapshot is replaced rather than blocking every later save',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),store=new FileSnapshotStore(root);
  await mkdir(root,{recursive:true});await writeFile(path.join(root,'aws.json'),'{"truncated":');
  const next=await at('2026-01-02T00:00:00.000Z')('single-vm');
  await store.save('aws',next);assert.equal((await store.latest('aws'))?.collectedAt,next.collectedAt);
  assert.equal(await store.previous('aws'),null,'the damaged file is not kept as history, where it would break every diff');
});
