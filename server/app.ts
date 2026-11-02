import express from 'express';
import {mockSnapshot} from './mock.js';
import {validateSnapshot,type Change,type Snapshot} from '../shared/schema.js';
import {isScenario} from '../shared/scenarios.js';
import {diffResources} from '../shared/diff.js';
import {FileSnapshotStore,type SnapshotStore} from './store.js';
import {applySites,readSites} from './onprem.js';
import {requireAccess,restrictSnapshot,sessionRoutes,type AccessEntry} from './auth.js';
const app=express();
if(process.env.DATA_MODE&&!['mock','live'].includes(process.env.DATA_MODE))throw new Error('DATA_MODE must be mock or live');
app.disable('x-powered-by');
app.use((_req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY'});next();});
app.use('/api/session',express.json({limit:'4kb'}));
app.get('/api/health',(_req,res)=>res.json({ok:true,mode:process.env.DATA_MODE??'mock'}));
sessionRoutes(app);
export async function liveSnapshot(store:SnapshotStore=new FileSnapshotStore()){
  const snapshots:Snapshot[]=[],warnings:string[]=[],changes:Change[]=[];let since:string|undefined;
  for(const p of ['azure','aws','gcp']){
    const s=await store.latest(p);
    if(!s){warnings.push(`${p}: 아직 수집한 스냅샷이 없습니다.`);continue;}
    if(s.mode!=='live'||s.resources.some(r=>r.provider!==p))throw new Error(`${p}: invalid provider snapshot`);
    snapshots.push(s);warnings.push(`${p}: 마지막 수집 ${s.collectedAt}`);
    const before=await store.previous(p);
    if(before){changes.push(...diffResources(before.resources,s.resources));if(!since||before.collectedAt<since)since=before.collectedAt;}
  }
  if(!snapshots.length)return null;
  const resources=snapshots.flatMap(s=>s.resources),links=snapshots.flatMap(s=>s.links),scopeLabels=Object.assign({},...snapshots.map(s=>s.scopeLabels)),allWarnings=[...warnings,...snapshots.flatMap(s=>s.warnings)];
  applySites(await readSites(),resources,links,allWarnings,scopeLabels);
  return validateSnapshot({version:1,mode:'live',collectedAt:snapshots.map(s=>s.collectedAt).sort()[0],resources,links,warnings:allWarnings,scopes:snapshots.flatMap(s=>s.scopes),scopeLabels,hierarchy:snapshots.flatMap(s=>s.hierarchy),changes:since?{since,items:changes}:undefined,connections:['azure','aws','gcp'].map(p=>{const s=snapshots.find(x=>x.resources.some(r=>r.provider===p));return{provider:p,status:s?'collected':'missing',api:'CLI 수집 스냅샷',scopes:s?.scopes.length??0,collectedAt:s?.collectedAt};})});
}
app.get('/api/topology',requireAccess,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
    if(process.env.DATA_MODE!=='live'){res.json(await mockSnapshot(isScenario(req.query.scenario)?req.query.scenario:'standard'));return;}
    const snapshot=await liveSnapshot();
    if(!snapshot){res.status(503).json({error:'실제 스냅샷이 없습니다. npm run collect로 먼저 수집하세요. 목데이터로 자동 대체하지 않습니다.'});return;}
    const access=res.locals.access as AccessEntry|undefined;
    res.json(access?restrictSnapshot(snapshot,access.scopes):snapshot);
  }catch(e){console.error('Snapshot load failed:',e instanceof Error?e.message:'unknown');res.status(500).json({error:'스냅샷 형식 또는 참조가 올바르지 않습니다. 서버 로그와 수집 결과를 확인하세요.'});}
});
app.use('/api',(_req,res)=>res.status(404).json({error:'API not found'}));
export default app;
