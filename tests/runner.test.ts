import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mockSnapshot} from '../server/mock.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {configureCollector,runCollection,settledInflight,type CollectorDrivers,type ProviderDriver} from '../server/runner.ts';
import {abortableFetch,awsSend,gcpRequester} from '../server/collectors.ts';
import type {Report} from '../shared/collect.ts';

const fake=async()=>{const s=await mockSnapshot('single-vm');return{resources:s.resources.map(r=>({...r,metrics:undefined,iam:[]})),links:s.links.filter(l=>l.kind!=='simulation'),warnings:[],scopeLabels:s.scopeLabels,hierarchy:s.hierarchy};};
const off:ProviderDriver={detect:async()=>{throw new Error('Could not load credentials');},collect:async()=>{throw new Error('must not run');}};
const store=async()=>new FileSnapshotStore(await mkdtemp(path.join(tmpdir(),'atlas-')));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test.afterEach(async()=>{await settledInflight();configureCollector();});

test('a collection that misses its deadline is told to stop, and the last good snapshot stays',async()=>{
  const s=await store();configureCollector({aws:{detect:async()=>'a',collect:fake},azure:off,gcp:off});await runCollection(s);
  const good=(await s.latest('aws'))!.collectedAt;let aborted:unknown;
  configureCollector({aws:{detect:async()=>'a',collect:({signal})=>new Promise((_,fail)=>signal!.addEventListener('abort',()=>{aborted=signal!.reason;fail(signal!.reason);}))},azure:off,gcp:off},{collectMs:30});
  const status=await runCollection(s);
  assert.equal(status.providers.aws.state,'failed');assert.equal(status.providers.aws.message,'수집 시간 초과');
  assert.match(String(aborted),/시간 초과/,'the work itself received the abort');
  assert.equal((await s.latest('aws'))!.collectedAt,good);
});
test('work that ignores the abort cannot rewrite the finished status, and the next run does not overlap it',async()=>{
  const s=await store();let calls=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const stubborn:ProviderDriver={detect:async()=>'a',collect:async({report})=>{calls++;await gate;report!('resources',{detail:'늦게 도착한 진행 상황'});return fake();}};
  configureCollector({aws:stubborn,azure:{detect:async()=>'z',collect:fake},gcp:off},{collectMs:30});
  const first=await runCollection(s);assert.equal(first.providers.aws.state,'failed');
  // The timed-out work is still going: a new run collects the other clouds but leaves this one alone.
  const second=await runCollection(s);
  assert.equal(calls,1,'no second collection of the same cloud while the first is alive');
  assert.match(second.providers.aws.message!,/이전 수집이 시간 초과 후 아직 끝나지 않아/);assert.equal(second.providers.azure.state,'ok');
  release();await settledInflight();await sleep(20);
  const disk=await s.readStatus();
  assert.equal(disk?.running,false);assert.ok(!disk?.providers.aws.stages?.some(x=>x.state==='running'),'late progress did not flip a settled stage back to running');
  assert.ok(!JSON.stringify(disk).includes('늦게 도착한'));
  // Once it has ended, the cloud is collected again.
  configureCollector({aws:{detect:async()=>'a',collect:fake},azure:off,gcp:off});
  assert.equal((await runCollection(s)).providers.aws.state,'ok');
});
test('a sign-in check that hangs is aborted at its own deadline',async()=>{
  const s=await store();let aborted=false;
  configureCollector({aws:{detect:signal=>new Promise((_,fail)=>signal!.addEventListener('abort',()=>{aborted=true;fail(signal!.reason);})),collect:off.collect},azure:off,gcp:off},{detectMs:20});
  const status=await runCollection(s);assert.equal(status.providers.aws.state,'unauthenticated');assert.ok(aborted);
});
test('after an abort, collectors make no further cloud calls',async()=>{
  const controller=new AbortController();let sent=0;
  const http=abortableFetch(controller.signal,(async(_u:unknown,init?:RequestInit)=>{sent++;assert.ok(init?.signal,'in-flight requests carry the signal');return new Response('{}');}) as typeof fetch);
  await http('https://management.azure.com/x',{signal:AbortSignal.timeout(30_000)});
  const aws={send:async(_c:unknown,o?:{abortSignal?:AbortSignal})=>{sent++;assert.ok(o?.abortSignal);return {};}},gcp={request:async(o:{signal?:AbortSignal})=>{sent++;assert.ok(o.signal);return{data:{}};}};
  await awsSend(aws,{},controller.signal);await gcpRequester(gcp,controller.signal)('https://cloudasset.googleapis.com/x');
  assert.equal(sent,3);
  controller.abort(new Error('수집 시간 초과'));
  await assert.rejects(http('https://management.azure.com/y'),/시간 초과/);
  await assert.rejects(awsSend(aws,{},controller.signal),/시간 초과/);
  await assert.rejects(gcpRequester(gcp,controller.signal)('https://cloudasset.googleapis.com/y'),/시간 초과/);
  assert.equal(sent,3,'nothing reached Azure, AWS or GCP after the abort');
});
test('a progress report from a finished cloud is ignored',async()=>{
  const s=await store();let late:Report|undefined;
  configureCollector({aws:{detect:async()=>'a',collect:async({report})=>{late=report;return fake();}},azure:off,gcp:off});
  const done=await runCollection(s);late!('resources',{detail:'끝난 뒤'});
  assert.ok(!done.providers.aws.stages!.some(x=>x.state==='running'));
});
export type {CollectorDrivers};

test('one collecting process per data folder: a second one waits its turn',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),a=new FileSnapshotStore(root),b=new FileSnapshotStore(root);
  const release=await a.lock();assert.ok(release);assert.equal(await b.lock(),null);
  await release!();const again=await b.lock();assert.ok(again,'free once released');await again!();
});
test('a lock left by a process that died is taken over',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),{writeFile}=await import('node:fs/promises'),{hostname}=await import('node:os');
  await writeFile(path.join(root,'collect.lock'),JSON.stringify({pid:2_147_483_000,host:hostname(),at:new Date().toISOString(),id:'dead'}));
  const release=await new FileSnapshotStore(root).lock();assert.ok(release);await release!();
});
test('while another process holds the folder, a run calls no cloud and changes nothing',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),s=new FileSnapshotStore(root),{writeFile}=await import('node:fs/promises'),{hostname}=await import('node:os');
  // The test runner's parent is alive and is not this process: it stands in for `npm run collect` in another terminal.
  await writeFile(path.join(root,'collect.lock'),JSON.stringify({pid:process.ppid,host:hostname(),at:new Date().toISOString(),id:'other'}));
  let calls=0;configureCollector({aws:{detect:async()=>{calls++;return 'a';},collect:fake},azure:off,gcp:off});
  const lines:string[]=[];await runCollection(s,l=>lines.push(l));
  assert.equal(calls,0);assert.equal(await s.latest('aws'),null);assert.match(lines[0],/다른 프로세스가/);
});
