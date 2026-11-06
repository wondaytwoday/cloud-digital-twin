import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {bindPlan} from '../server/listen.ts';
import app from '../server/app.ts';

const tokens=JSON.stringify([{name:'ops',tokenSha256:createHash('sha256').update('t').digest('hex'),scopes:['*']}]);
test('loopback stays the default, and only a loopback listener may skip access tokens',()=>{
  assert.deepEqual(bindPlan({DATA_MODE:'live'}),{host:'127.0.0.1',loopbackOnly:true,trustProxy:undefined});
  assert.equal(bindPlan({DATA_MODE:'live',ATLAS_HOST:'::1'}).loopbackOnly,true);
  const shared=bindPlan({DATA_MODE:'live',ATLAS_HOST:'0.0.0.0'});
  assert.match(shared.error!,/ACCESS_TOKENS가 필요합니다/);
  assert.match(bindPlan({DATA_MODE:'live',ATLAS_HOST:'0.0.0.0',ACCESS_TOKENS:'[{"name":1}]'}).error!,/형식이 올바르지 않습니다/);
  assert.deepEqual(bindPlan({DATA_MODE:'live',ATLAS_HOST:'0.0.0.0',ACCESS_TOKENS:tokens}),{host:'0.0.0.0',loopbackOnly:false,trustProxy:undefined});
  assert.equal(bindPlan({ATLAS_HOST:'0.0.0.0'}).error,undefined,'sample data may be shared without tokens');
});
test('trusted proxies are named, never "all"',()=>{
  assert.equal(bindPlan({ATLAS_TRUST_PROXY:'1'}).trustProxy,1);
  assert.equal(bindPlan({ATLAS_TRUST_PROXY:'loopback, 10.0.0.5'}).trustProxy,'loopback, 10.0.0.5');
  for(const all of ['true','TRUE','*'])assert.match(bindPlan({ATLAS_TRUST_PROXY:all}).error!,/모든 프록시를 신뢰/,all);
});
test('the server refuses to start on a shared address in live mode without tokens',()=>{
  const env={...process.env,DATA_MODE:'live',ATLAS_HOST:'0.0.0.0',ACCESS_TOKENS:'',ATLAS_COLLECTOR:'',PORT:'0'};
  const run=spawnSync(process.execPath,['--import','tsx','server/index.ts'],{env,encoding:'utf8',timeout:30_000});
  assert.equal(run.status,1);assert.match(run.stderr,/ACCESS_TOKENS가 필요합니다/);
});
test('behind a named proxy the audit trail records the client, not the proxy',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),saved={...process.env};
  Object.assign(process.env,{DATA_MODE:'live',SNAPSHOT_DIR:root,ACCESS_TOKENS:JSON.stringify([{name:'ops',tokenSha256:createHash('sha256').update('t').digest('hex'),scopes:['*'],roles:['auditor']}])});delete process.env.ATLAS_LOOPBACK_ONLY;
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login=(ip:string)=>fetch(`${base}/api/session`,{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':ip},body:JSON.stringify({token:'wrong'})});
  const ips=async()=>(await (await fetch(`${base}/api/audit`,{headers:{Authorization:'Bearer t'}})).json()).events.filter((e:{action:string})=>e.action==='login_failed').map((e:{ip:string})=>e.ip);
  try{
    await login('203.0.113.7');assert.ok(!(await ips()).includes('203.0.113.7'),'an untrusted header is ignored');
    app.set('trust proxy','loopback');
    await login('203.0.113.8');assert.ok((await ips()).includes('203.0.113.8'));
  }finally{app.set('trust proxy',false);server.close();process.env=saved;}
});
