import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {mockSnapshot} from '../server/mock.ts';
import {restrictSnapshot} from '../server/auth.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {toSnapshot} from '../server/runner.ts';
import app from '../server/app.ts';
import type {Snapshot} from '../shared/schema.ts';

const withServer=async(env:Record<string,string|undefined>,run:(base:string)=>Promise<void>)=>{
  const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);for(const k in env)if(env[k]===undefined)delete process.env[k];
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));
  try{await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);}finally{server.close();for(const k in saved){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
// Everything that names another scope: its ID, its label, and the IDs and names of what lives in it.
const foreignMarks=(s:Snapshot,mine:string)=>{
  const other=s.resources.filter(r=>r.scope!==mine&&r.provider!=='onprem'&&r.scope!=='external');
  return [...new Set([...s.scopes.filter(x=>x!==mine),...Object.entries(s.scopeLabels).filter(([k])=>k!==mine).map(([,v])=>v),...other.map(r=>r.id)])];
};
const platformProd=async()=>{const s=await mockSnapshot('standard');return{s,sub:s.hierarchy.find(n=>n.name==='Platform Prod')!.scope!};};

test('a restricted user never sees another scope listed as incomplete',async()=>{
  const {s,sub}=await platformProd(),other=s.scopes.find(x=>x!==sub)!;
  const r=restrictSnapshot({...s,incomplete:[other,sub]},[sub]);
  assert.deepEqual(r.incomplete,[sub],'their own gap stays, so they still know their view is partial');
});
test('a restricted response carries nothing that names another scope',async()=>{
  const {s,sub}=await platformProd(),other=s.scopes.find(x=>x!==sub)!;
  const leaky={...s,incomplete:[other],warnings:[`Azure 구독 ${other}: 접근 확인 실패`],connections:s.connections.map(c=>({...c,status:'partial' as const,message:`범위 ${other}에서 일부 항목을 읽지 못했습니다.`}))};
  const json=JSON.stringify(restrictSnapshot(leaky,[sub]));
  for(const mark of foreignMarks(s,sub))assert.ok(!json.includes(mark),`leaked ${mark}`);
});
test('connections keep only what holds for the user\'s own scopes',async()=>{
  const {s,sub}=await platformProd(),other=s.scopes.find(x=>x!==sub)!;
  const at='2026-11-01T00:00:00.000Z',partial={...s,connections:s.connections.map(c=>({...c,status:'partial' as const,collectedAt:at,message:'secret'}))};
  const clean=restrictSnapshot({...partial,incomplete:[other]},[sub]).connections;
  assert.deepEqual(clean,[{provider:'azure',status:'collected',api:'Azure Resource Graph',scopes:1,collectedAt:at}],'another scope\'s gap does not mark this user partial, and only their own scope is counted');
  assert.equal(restrictSnapshot({...partial,incomplete:[sub]},[sub]).connections[0].status,'partial');
});
test('restricting a snapshot does not edit the one other requests read',async()=>{
  const {s,sub}=await platformProd(),before=structuredClone(s);
  restrictSnapshot(s,[sub]);
  assert.deepEqual(s,before);
});

// Splits a mock estate into per-provider live snapshots, the shape the collector stores.
const saveLive=async(root:string,incomplete:Record<string,string[]>={})=>{
  const s=await mockSnapshot('standard'),store=new FileSnapshotStore(root);
  for(const p of ['azure','aws','gcp'] as const){
    const resources=s.resources.filter(r=>r.provider===p).map(r=>({...r,metrics:undefined,iam:[]})),ids=new Set(resources.map(r=>r.id));
    await store.save(p,toSnapshot({resources,links:s.links.filter(l=>l.kind!=='simulation'&&ids.has(l.source)&&ids.has(l.target)),warnings:[`${p} warning`],scopeLabels:Object.fromEntries(Object.entries(s.scopeLabels).filter(([k])=>resources.some(r=>r.scope===k))),hierarchy:s.hierarchy.filter(n=>n.provider===p),incomplete:incomplete[p]??[]}));
  }
  return s;
};
test('over HTTP, a restricted token gets only its own scope, gaps included',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-')),{s,sub}=await platformProd(),other=s.scopes.find(x=>x!==sub&&s.resources.some(r=>r.scope===x&&r.provider==='azure'))!;
  await saveLive(root,{azure:[other]});
  const tokens=[{name:'team',tokenSha256:sha('team-token'),scopes:[sub]}];
  await withServer({DATA_MODE:'live',SNAPSHOT_DIR:root,ACCESS_TOKENS:JSON.stringify(tokens),ATLAS_LOOPBACK_ONLY:undefined},async base=>{
    const r=await fetch(`${base}/api/topology`,{headers:{Authorization:'Bearer team-token'}});assert.equal(r.status,200);
    const body=await r.json(),json=JSON.stringify(body);
    assert.ok(body.resources.length>0&&body.resources.every((x:{scope:string})=>x.scope===sub));
    assert.deepEqual(body.incomplete,[]);assert.deepEqual(body.warnings,[]);
    for(const mark of foreignMarks(s,sub))assert.ok(!json.includes(mark),`leaked ${mark}`);
  });
});
