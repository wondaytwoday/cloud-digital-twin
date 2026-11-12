import {resourcePage,activityPage,PageError} from './pages.js';
import {snapshotError} from './snapshot-error.js';
import {SelectionSchema,selectedItems,collectionItems,collectionLabels} from '../shared/collection-items.js';
import express from 'express';
import {mockSnapshot} from './mock.js';
import {validateSnapshot,type Change,type Snapshot} from '../shared/schema.js';
import {DEFAULT_SCENARIO,isScenario} from '../shared/scenarios.js';
import {parseFx} from '../shared/cost.js';
import {actorOf,audit,readAudit} from './audit.js';
import {demoAudit} from './fixtures/audit.js';
import {diffResources} from '../shared/diff.js';
import {FileSnapshotStore,type SnapshotStore} from './store.js';
import {applySites,readSites} from './onprem.js';
import {requireAccess,requireAdmin,restrictSnapshot,sessionRoutes,type AccessEntry} from './auth.js';
import {collectorEnabled,readCollectionStatus,runCollection,CollectionConflictError,activeRunId,type ProviderState} from './runner.js';
import {compactInventory} from './inventory.js';
import {sendPrivateJson} from './http-json.js';
import {snapshotCache} from './snapshot-cache.js';
import {projectSnapshot} from '../shared/presentation.js';
import {viewTransport} from './view-transport.js';
const apiStores=new Map<string,FileSnapshotStore>();
const apiStore=()=>{const root=process.env.SNAPSHOT_DIR??'data';let store=apiStores.get(root);if(!store){store=new FileSnapshotStore(root);apiStores.set(root,store);if(apiStores.size>8)apiStores.delete(apiStores.keys().next().value!);}return store;};
const cachedLiveSnapshot=snapshotCache(liveSnapshot);
const representations=new WeakMap<Snapshot,Map<string,Snapshot>>();
function representation(snapshot:Snapshot,access:AccessEntry|undefined,part:string,fx:ReturnType<typeof parseFx>){
  let values=representations.get(snapshot);if(!values){values=new Map();representations.set(snapshot,values);}
  const key=JSON.stringify([access?.scopes??['*'],part,fx]);let value=values.get(key);
  if(!value){value={...projectSnapshot(access?restrictSnapshot(snapshot,access.scopes):snapshot,part),fx};values.set(key,value);if(values.size>32)values.delete(values.keys().next().value!);}
  return value;
}
const mockCache=new Map<string,{at:number;value:Promise<Snapshot>}>();
const app=express();
if(process.env.DATA_MODE&&!['mock','live'].includes(process.env.DATA_MODE))throw new Error('DATA_MODE must be mock or live');
app.disable('x-powered-by');
if(process.env.ATLAS_TRUST_PROXY)app.set('trust proxy',process.env.ATLAS_TRUST_PROXY.split(',').map(value=>value.trim()).filter(Boolean));
app.use((_req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY'});next();});
app.use('/api/session',express.json({limit:'4kb'}));
app.use('/api/audit',express.json({limit:'4kb'}));
app.use('/api/collect',express.json({limit:'8kb'}));
app.get('/api/health',(_req,res)=>res.json({ok:true,mode:process.env.DATA_MODE??'mock',collector:collectorEnabled(),serverless:!!process.env.VERCEL}));
sessionRoutes(app);
export async function liveSnapshot(store:SnapshotStore=new FileSnapshotStore()){
  const snapshots:Snapshot[]=[],byProvider=new Map<string,Snapshot>(),warnings:string[]=[],changes:Change[]=[],status=await store.readStatus();let since:string|undefined;
  for(const p of ['azure','aws','gcp']){
    const s=await store.latest(p);
    if(!s){warnings.push(`${p}: 아직 수집한 스냅샷이 없습니다.`);continue;}
    if(s.mode!=='live'||s.resources.some(r=>r.provider!==p))throw new Error(`${p}: invalid provider snapshot`);
    snapshots.push(s);byProvider.set(p,s);warnings.push(`${p}: 마지막 수집 ${s.collectedAt}`);
    const before=await store.previous(p);
    // A scope that could not be fully read says nothing about what changed in it, so its gaps are not reported as deletions or additions.
    if(before){
      const after=new Set(s.incomplete),earlier=new Set(before.incomplete);
      const old=s.inventoryMode==='summary'?compactInventory({...before,scopeLabels:before.scopeLabels},null,'summary').resources:before.resources;
      const foldedRuleIds=new Set(s.resources.flatMap(r=>r.rules.flatMap(rule=>rule.id?[rule.id]:[])));
      const oldById=new Map(before.resources.map(r=>[r.id,r]));
      changes.push(...diffResources(old,s.resources).filter(c=>{
        const prior=oldById.get(c.id);
        const folded=prior?.type==='ec2:security-group-rule'&&foldedRuleIds.has(prior.nativeId.split('/').pop()!);
        return !(c.kind==='removed'&&(after.has(c.scope)||folded))&&!(c.kind==='added'&&earlier.has(c.scope));
      }));
      if(!since||before.collectedAt<since)since=before.collectedAt;
    }
  }
  if(!snapshots.length)return null;
  const resources=snapshots.flatMap(s=>s.resources),links=snapshots.flatMap(s=>s.links),scopeLabels=Object.assign({},...snapshots.map(s=>s.scopeLabels)),allWarnings=[...warnings,...snapshots.flatMap(s=>s.warnings)];
  applySites(await readSites(),resources,links,allWarnings,scopeLabels);
  return validateSnapshot({version:1,itemCollection:snapshots.flatMap(s=>s.itemCollection),mode:'live',collectedAt:snapshots.map(s=>s.collectedAt).sort()[0],resources,links,inventoryMode:snapshots.some(s=>s.inventoryMode==='summary')?'summary':undefined,inventorySummary:snapshots.flatMap(s=>s.inventorySummary),warnings:allWarnings,scopes:snapshots.flatMap(s=>s.scopes),scopeLabels,hierarchy:snapshots.flatMap(s=>s.hierarchy),scopeCollectedAt:Object.assign({},...snapshots.map(s=>s.scopeCollectedAt)),cost:snapshots.flatMap(s=>s.cost),costCoverage:snapshots.flatMap(s=>s.costCoverage),collectionGaps:snapshots.flatMap(s=>s.collectionGaps),activity:snapshots.flatMap(s=>s.activity),costAt:snapshots.map(s=>s.costAt).filter(Boolean).sort()[0],iam:snapshots.flatMap(s=>s.iam),incomplete:snapshots.flatMap(s=>s.incomplete),changes:since?{since,items:changes}:undefined,connections:(['azure','aws','gcp'] as const).map(p=>{
    const s=byProvider.get(p),run=status?.providers[p],state:Record<ProviderState,string>={idle:s?'collected':'missing',running:'running',ok:'collected',partial:'partial',failed:'failed',unauthenticated:'unauthenticated'};
    return{provider:p,status:run?state[run.state]:s?'collected':'missing',api:'수집 스냅샷',scopes:s?.scopes.length??0,collectedAt:s?.collectedAt,message:run?.message};
  })});
}
app.get('/api/topology',requireAccess,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
    // Rates are the operator's setting, applied when read, so changing .env takes effect without a new collection.
    const fx=parseFx(process.env);
    if(process.env.DATA_MODE!=='live'){
      const scenario=isScenario(req.query.scenario)?req.query.scenario:DEFAULT_SCENARIO;
      let cached=mockCache.get(scenario);
      if(!cached||Date.now()-cached.at>30_000){cached={at:Date.now(),value:mockSnapshot(scenario)};mockCache.set(scenario,cached);}
      const value=representation(await cached.value,undefined,'full',fx);
      await sendPrivateJson(req,res,req.query.transport==='1'?viewTransport(value,typeof req.query.base==='string'?req.query.base:undefined):value);return;
    }
    const snapshot=await cachedLiveSnapshot(apiStore());
    if(!snapshot){res.status(503).json({error:process.env.VERCEL?'Vercel 배포는 수집을 실행하거나 결과를 저장할 수 없어 보여줄 스냅샷이 없습니다. 클라우드에 접근되는 PC나 서버에서 npm run live를 실행하세요.':'실제 스냅샷이 없습니다. npm run collect로 먼저 수집하세요. 목데이터로 자동 대체하지 않습니다.',onboarding:collectorEnabled()});return;}
    const access=res.locals.access as AccessEntry|undefined;
    audit(req,{actor:actorOf(req,access?.name),action:'view',target:'portal',detail:'인벤토리 조회'});
    const value=representation(snapshot,access,String(req.query.part??'full'),fx);
    await sendPrivateJson(req,res,req.query.transport==='1'?viewTransport(value,typeof req.query.base==='string'?req.query.base:undefined):value);
  }catch(e){console.error('Snapshot load failed:',e instanceof Error?e.name:'unknown');const failure=snapshotError(e);res.status(failure.status).json({error:failure.error});}
});
async function pageSnapshot(req:express.Request,res:express.Response){
  let snapshot:Snapshot|null;
  if(process.env.DATA_MODE==='live')snapshot=await cachedLiveSnapshot(apiStore());
  else{
    const scenario=isScenario(req.query.scenario)?req.query.scenario:DEFAULT_SCENARIO;
    let cached=mockCache.get(scenario);
    if(!cached||Date.now()-cached.at>30_000){cached={at:Date.now(),value:mockSnapshot(scenario)};mockCache.set(scenario,cached);}
    snapshot=await cached.value;
  }
  if(!snapshot)throw new PageError(503,'아직 수집한 스냅샷이 없습니다.');
  return representation(snapshot,res.locals.access as AccessEntry|undefined,'full',parseFx(process.env));
}
for(const [route,read] of [['resources',resourcePage],['activity',activityPage]] as const){
  app.get(`/api/${route}`,requireAccess,async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{
      const snapshot=await pageSnapshot(req,res),query=new URL(req.originalUrl,'http://localhost').searchParams;
      await sendPrivateJson(req,res,read(snapshot,query));
    }catch(e){const failure=e instanceof PageError?{status:e.status,error:e.message}:snapshotError(e);res.status(failure.status).json({error:failure.error});}
  });
}
app.get('/api/resource',requireAccess,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
    const snapshot=await pageSnapshot(req,res),id=req.query.id;
    const resource=typeof id==='string'?snapshot.resources.find(r=>r.id===id):undefined;
    if(!resource){res.status(404).json({error:'이 범위에서 자원을 찾을 수 없습니다.'});return;}
    res.json({version:1,resource});
  }catch(e){const failure=snapshotError(e);res.status(failure.status).json({error:failure.error});}
});
app.get('/api/collect/status',requireAccess,requireAdmin,async(_req,res)=>{
  res.set('Cache-Control','no-store');
  try{res.json({enabled:collectorEnabled(),...await readCollectionStatus()});}
  catch{res.status(500).json({error:'수집 상태를 읽지 못했습니다.'});}
});
app.get('/api/collect/items',requireAccess,requireAdmin,async(_req,res)=>{
  res.set('Cache-Control','no-store');
  const snapshot=process.env.DATA_MODE==='live'?await cachedLiveSnapshot(apiStore()):null;
  res.json({items:['azure','aws','gcp'].flatMap(provider=>collectionItems.map(item=>({provider,item,label:collectionLabels[item],requires:selectedItems({mode:'selected',items:[{provider:provider as 'azure'|'aws'|'gcp',item}]},provider as 'azure'|'aws'|'gcp').filter(i=>i!==item)}))),records:snapshot?.itemCollection??[]});
});
// The custom header makes a cross-site form or fetch impossible without a CORS grant this server never gives.
app.post('/api/collect',requireAccess,requireAdmin,(req,res)=>{
  if(!collectorEnabled()){res.status(409).json({error:'이 배포에서는 수집을 실행할 수 없습니다. npm run live로 실행한 서버에서만 수집합니다.'});return;}
  if(req.get('X-Atlas-Request')!=='1'){res.status(403).json({error:'잘못된 요청입니다.'});return;}
  const parsed=SelectionSchema.safeParse(req.body??{mode:'all'});
  if(!parsed.success){res.status(400).json({error:'수집 모드와 제공자·항목을 확인하세요. 선택 수집에는 하나 이상의 항목이 필요합니다.'});return;}
  try{
    const job=runCollection(undefined,undefined,{selection:parsed.data});
    audit(req,{actor:actorOf(req,(res.locals.access as AccessEntry|undefined)?.name),action:'collect',detail:parsed.data.mode==='all'?'전체 수집':parsed.data.items.map(i=>`${i.provider}:${i.item}`).join(', ')});
    job.catch(e=>console.error('Collection failed:',e instanceof Error?e.message:'unknown'));
    res.status(202).json({started:true,runId:activeRunId()});
  }catch(e){if(e instanceof CollectionConflictError){res.status(409).json({error:e.message,runId:e.runId});return;}throw e;}

});
// The browser reports what was opened; the server decides who did it from the session, never from the body.
const CLIENT_ACTIONS=new Set(['view','open','export']);
app.post('/api/audit/event',requireAccess,(req,res)=>{
  const {action,target,detail}=req.body??{};
  if(!CLIENT_ACTIONS.has(action)||typeof target!=='string'||target.length>300||(detail!==undefined&&(typeof detail!=='string'||detail.length>200))){res.status(400).json({error:'잘못된 기록 요청입니다.'});return;}
  audit(req,{actor:actorOf(req,(res.locals.access as AccessEntry|undefined)?.name),action,target,...(detail?{detail}:{})});
  res.status(204).end();
});
// Everyone's activity is visible here, so only full-scope users may read it.
app.get('/api/audit',requireAccess,requireAdmin,async(req,res)=>{
  res.set('Cache-Control','no-store');
  const days=Math.min(90,Math.max(1,Number(req.query.days)||30)),live=process.env.DATA_MODE==='live',own=await readAudit(days);
  res.json({mode:live?'live':'mock',days,events:live?own:[...own,...demoAudit(new Date())].sort((a,b)=>b.at.localeCompare(a.at))});
});
app.use('/api',(_req,res)=>res.status(404).json({error:'API not found'}));
app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const type=(error as {type?:string})?.type;
  if(type==='entity.too.large'){res.status(413).json({error:'요청 본문이 너무 큽니다.'});return;}
  if(type==='entity.parse.failed'){res.status(400).json({error:'올바른 JSON 요청 본문이 필요합니다.'});return;}
  const failure=snapshotError(error);res.status(failure.status).json({error:failure.error});
});
export default app;
