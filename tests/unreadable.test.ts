import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {mockSnapshot} from '../server/mock.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {configureCollector,runCollection,toSnapshot,type ProviderDriver} from '../server/runner.ts';
import app,{liveSnapshot} from '../server/app.ts';

const result=async(id:'web-tier'|'single-vm')=>{const s=await mockSnapshot(id);return{resources:s.resources.map(r=>({...r,metrics:undefined,iam:[]})),links:s.links.filter(l=>l.kind!=='simulation'),warnings:[],scopeLabels:s.scopeLabels,hierarchy:s.hierarchy};};
const estate=async()=>{const root=await mkdtemp(path.join(tmpdir(),'atlas-')),store=new FileSnapshotStore(root);await store.save('azure',toSnapshot(await result('web-tier')));await store.save('aws',toSnapshot(await result('single-vm')));return{root,store};};

test('one damaged snapshot costs that cloud only, and says how to recover',async()=>{
  const {root,store}=await estate();await writeFile(path.join(root,'aws.json'),'{"truncated":');
  const s=(await liveSnapshot(store))!;
  assert.ok(s.resources.length>0&&s.resources.every(r=>r.provider==='azure'),'Azure is still shown');
  const aws=s.connections.find(c=>c.provider==='aws')!;assert.equal(aws.status,'failed');assert.match(aws.message!,/npm run restore/);
});
test('a snapshot holding another cloud\'s resources is set aside the same way',async()=>{
  const {root,store}=await estate(),azure=await readFileJson(path.join(root,'azure.json'));
  await writeFile(path.join(root,'aws.json'),JSON.stringify(azure));
  assert.equal((await liveSnapshot(store))!.connections.find(c=>c.provider==='aws')!.status,'failed');
});
test('a damaged previous snapshot only costs the change list',async()=>{
  const {root,store}=await estate();await store.save('aws',toSnapshot(await result('single-vm')));
  const {readdir}=await import('node:fs/promises'),[file]=await readdir(path.join(root,'history','aws'));await writeFile(path.join(root,'history','aws',file),'x');
  assert.ok((await liveSnapshot(store))!.resources.some(r=>r.provider==='aws'));
});
test('collecting again repairs a damaged snapshot instead of failing on it',async()=>{
  const {root,store}=await estate();await writeFile(path.join(root,'aws.json'),'{"truncated":');
  const off:ProviderDriver={detect:async()=>{throw new Error('Could not load credentials');},collect:async()=>{throw new Error('unused');}};
  configureCollector({aws:{detect:async()=>'a',collect:()=>result('single-vm')},azure:off,gcp:off});
  try{assert.equal((await runCollection(store)).providers.aws.state,'ok');assert.ok(await store.latest('aws'));}finally{configureCollector();}
});
test('over HTTP the portal still answers, and readiness counts the damaged file',async()=>{
  const {root}=await estate();await writeFile(path.join(root,'aws.json'),'{"truncated":');
  const saved={...process.env};Object.assign(process.env,{DATA_MODE:'live',SNAPSHOT_DIR:root,ATLAS_LOOPBACK_ONLY:'1'});delete process.env.ACCESS_TOKENS;
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try{
    assert.equal((await fetch(`${base}/api/topology`)).status,200);
    assert.deepEqual((await (await fetch(`${base}/api/ready`)).json()).checks.data,{stale:0,missing:1,unreadable:1});
    await writeFile(path.join(root,'azure.json'),'x');
    assert.equal((await fetch(`${base}/api/topology`)).status,500,'nothing readable at all is an error, not "not collected yet"');
  }finally{server.close();process.env=saved;}
});
const readFileJson=async(file:string)=>JSON.parse(await (await import('node:fs/promises')).readFile(file,'utf8'));
