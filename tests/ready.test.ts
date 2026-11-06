import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import app from '../server/app.ts';
import {resetAuditMemory} from '../server/audit.ts';

const tokens=JSON.stringify([{name:'auditor',tokenSha256:createHash('sha256').update('a').digest('hex'),scopes:['*'],roles:['auditor']}]);
const withServer=async(env:Record<string,string|undefined>,run:(base:string)=>Promise<void>)=>{
  const saved={...process.env};Object.assign(process.env,env);for(const k in env)if(env[k]===undefined)delete process.env[k];
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));
  try{await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);}finally{server.close();process.env=saved;}
};
// A data folder that cannot be written: its parent is a regular file.
const broken=async()=>{const dir=await mkdtemp(path.join(tmpdir(),'atlas-')),file=path.join(dir,'not-a-dir');await writeFile(file,'');return path.join(file,'data');};
const failLogin=(base:string)=>fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'wrong'})});
test.beforeEach(()=>resetAuditMemory());

test('readiness passes when snapshots and the audit trail can both be written',async()=>{
  await withServer({DATA_MODE:'live',SNAPSHOT_DIR:await mkdtemp(path.join(tmpdir(),'atlas-')),ACCESS_TOKENS:tokens},async base=>{
    const r=await fetch(`${base}/api/ready`);assert.equal(r.status,200);
    const body=await r.json();assert.equal(body.ready,true);assert.deepEqual(body.checks.data,{stale:0,missing:3,unreadable:0},'nothing collected yet is reported, not failed');
  });
});
test('a folder that cannot be written fails readiness, without revealing where it is',async()=>{
  const dir=await broken();
  await withServer({DATA_MODE:'live',SNAPSHOT_DIR:dir,ACCESS_TOKENS:tokens},async base=>{
    const r=await fetch(`${base}/api/ready`),text=await r.text();assert.equal(r.status,503);
    const body=JSON.parse(text);assert.equal(body.checks.storage.ok,false);assert.equal(body.checks.audit.ok,false);assert.equal(body.checks.storage.detail,'ENOTDIR');
    assert.ok(!text.includes(dir)&&!text.includes(tmpdir()),'no path in an unauthenticated response');
  });
});
test('lost audit writes are counted, shown to auditors, and clear once writing works again',async()=>{
  const good=await mkdtemp(path.join(tmpdir(),'atlas-'));
  await withServer({DATA_MODE:'live',SNAPSHOT_DIR:await broken(),ACCESS_TOKENS:tokens},async base=>{
    await failLogin(base);await failLogin(base);
    process.env.SNAPSHOT_DIR=good;
    // The disk is fine again, but the trail has a gap until something is written.
    const gap=await (await fetch(`${base}/api/ready`)).json();assert.equal(gap.ready,false);assert.match(gap.checks.audit.detail,/최근 기록 실패 2회 \(ENOTDIR\)/);
    const log=await (await fetch(`${base}/api/audit`,{headers:{Authorization:'Bearer a'}})).json();
    assert.equal(log.writes.failures,2);assert.ok(log.writes.lastFailureAt);
    await failLogin(base);
    const after=await fetch(`${base}/api/ready`);assert.equal(after.status,200,'a successful write clears the alarm');
    assert.equal((await (await fetch(`${base}/api/audit`,{headers:{Authorization:'Bearer a'}})).json()).writes.failures,2,'the count stays, so the gap is not forgotten');
  });
});
test('sample-data mode is always ready',async()=>{
  await withServer({DATA_MODE:undefined},async base=>{const r=await fetch(`${base}/api/ready`);assert.equal(r.status,200);assert.equal((await r.json()).mode,'mock');});
});
