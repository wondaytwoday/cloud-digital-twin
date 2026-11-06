import {abortableFetch,awsSend,collectAws,collectAzure,collectGcpAuto,discoverAzureSubscriptions,gcpRequester,type CollectOptions} from './collectors.js';
import type {Normalized} from './normalize.js';
import {FileSnapshotStore,processAlive,type SnapshotStore} from './store.js';
import {existsSync} from 'node:fs';
import {validateSnapshot,type Coverage,type Dataset} from '../shared/schema.js';
import {newStages,type CollectionStatus,type ProviderId,type ProviderState,type ProviderStatus,type Report,type Stage} from '../shared/collect.js';
export type {CollectionStatus,ProviderId,ProviderState,ProviderStatus};
export type ProviderDriver={detect:(signal?:AbortSignal)=>Promise<string>;scope?:(signal?:AbortSignal)=>Promise<string>;collect:(options:CollectOptions&{report?:Report;signal?:AbortSignal})=>Promise<Normalized>};
export type CollectorDrivers=Record<ProviderId,ProviderDriver>;
export const PROVIDERS:ProviderId[]=['azure','aws','gcp'];
// Cost APIs bill per request or per byte scanned, so they run far less often than inventory.
const COST_HOURS=()=>Number(process.env.ATLAS_COST_HOURS??24);
export type CollectorLimits={detectMs:number;collectMs:number};
const DEFAULT_LIMITS:CollectorLimits={detectMs:30_000,collectMs:15*60_000};
let limits=DEFAULT_LIMITS;
export const emptyStatus=():CollectionStatus=>({running:false,providers:{azure:{state:'idle'},aws:{state:'idle'},gcp:{state:'idle'}}});
// A timeout that only stops waiting leaves the cloud calls running, overlapping the next run. This one also tells the work to stop,
// and hands the work itself to track, so a run can tell whether what it gave up on has really ended.
const withDeadline=<T>(work:(signal:AbortSignal)=>Promise<T>,ms:number,what:string,track:(running:Promise<unknown>)=>void=()=>{})=>{
  const controller=new AbortController(),running=work(controller.signal);track(running);let timer:NodeJS.Timeout;
  return Promise.race([running,new Promise<never>((_,fail)=>{timer=setTimeout(()=>{const e=new Error(`${what} 시간 초과`);controller.abort(e);fail(e);},ms);})]).finally(()=>clearTimeout(timer));
};
// Work per cloud that has not settled yet, including work a run gave up on at its deadline.
const inflight=new Map<ProviderId,Promise<void>>();
const trackFor=(p:ProviderId)=>(running:Promise<unknown>)=>{const settled:Promise<void>=running.then(()=>{},()=>{}).finally(()=>{if(inflight.get(p)===settled)inflight.delete(p);});inflight.set(p,settled);};
export const settledInflight=()=>Promise.all([...inflight.values()]);
// SDK errors can run to pages and quote request details; the portal only needs the first line.
const shortMessage=(e:unknown)=>(e instanceof Error?e.message:String(e)).split('\n')[0].slice(0,200);
const AUTH_ERROR=/expired|credential|not logged|az login|sso login|invalid_grant|unauthorized_client|InvalidClientTokenId|could not load|grant is invalid|SignatureDoesNotMatch|AADSTS/i;
const AZURE_SP=['AZURE_TENANT_ID','AZURE_CLIENT_ID','AZURE_CLIENT_SECRET'];
// A chained credential's first line says nothing useful, so the whole message is searched and the answer says what to change.
export function explainAuth(p:ProviderId,e:unknown,env:NodeJS.ProcessEnv=process.env):string{
  const raw=e instanceof Error?e.message:String(e),first=shortMessage(e);
  if(p==='azure'){
    const missing=AZURE_SP.filter(k=>!env[k]);
    if(missing.length&&missing.length<AZURE_SP.length)return `${missing.join(', ')} 값이 비어 있습니다. 서비스 주체는 세 값이 모두 필요합니다.`;
    const code=raw.match(/AADSTS\d+/)?.[0];
    if(code==='AADSTS7000215'||code==='AADSTS7000222')return `클라이언트 비밀이 틀렸거나 만료됐습니다 (${code}). AZURE_CLIENT_SECRET에 비밀 ID가 아닌 비밀 값을 넣었는지 확인하세요.`;
    if(code==='AADSTS700016')return `이 테넌트에서 앱을 찾지 못했습니다 (${code}). AZURE_CLIENT_ID와 AZURE_TENANT_ID를 확인하세요.`;
    if(code==='AADSTS90002')return `테넌트를 찾지 못했습니다 (${code}). AZURE_TENANT_ID를 확인하세요.`;
    if(code)return `Azure가 로그인을 거부했습니다 (${code}). 서비스 주체 값을 확인하세요.`;
    if(!missing.length)return `서비스 주체로 로그인하지 못했습니다. ${first}`;
    return '자격 증명을 찾지 못했습니다. AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET을 설정하거나 az login을 실행하세요.';
  }
  if(p==='aws'){
    if(!!env.AWS_ACCESS_KEY_ID!==!!env.AWS_SECRET_ACCESS_KEY)return 'AWS_ACCESS_KEY_ID와 AWS_SECRET_ACCESS_KEY는 함께 설정해야 합니다.';
    if(/grant is invalid|sso.*expired|token.*expired|refresh.*(failed|expired)|ExpiredToken/i.test(raw))return '로그인 세션이 만료됐습니다. aws login 또는 aws sso login을 다시 실행하세요.';
    if(/InvalidClientTokenId/.test(raw))return '액세스 키가 올바르지 않습니다. AWS_ACCESS_KEY_ID를 확인하세요.';
    if(/SignatureDoesNotMatch/.test(raw))return '비밀 액세스 키가 올바르지 않습니다. AWS_SECRET_ACCESS_KEY를 확인하세요.';
    if(/could not (load|find).*(credentials|profile)|credentials? .*not found/i.test(raw))return `자격 증명을 찾지 못했습니다${env.AWS_PROFILE?` (프로필 ${env.AWS_PROFILE})`:''}. 액세스 키를 설정하거나 aws login을 실행하세요.`;
    return first;
  }
  const file=env.GOOGLE_APPLICATION_CREDENTIALS;
  if(file&&!existsSync(file))return `GOOGLE_APPLICATION_CREDENTIALS의 파일을 찾지 못했습니다 (${file}).`;
  if(/invalid_grant/.test(raw))return '로그인이 만료됐거나 키가 폐기됐습니다. gcloud auth application-default login을 다시 실행하거나 새 키를 받으세요.';
  if(/could not load the default credentials/i.test(raw))return '자격 증명을 찾지 못했습니다. GOOGLE_APPLICATION_CREDENTIALS를 설정하거나 gcloud auth application-default login을 실행하세요.';
  return first;
}
// Failures past sign-in that have one known fix.
const explainFailure=(message:string)=>/quota project|local Application Default Credentials/i.test(message)?'사용자 로그인으로 GCP API를 쓰려면 쿼터 프로젝트가 필요합니다. gcloud auth application-default set-quota-project <프로젝트>를 실행하세요.':/SERVICE_DISABLED|has not been used|is disabled/i.test(message)?`필요한 API가 꺼져 있습니다. ${message}`:message;

const realDrivers:CollectorDrivers={
  azure:{
    detect:async signal=>{const {DefaultAzureCredential}=await import('@azure/identity');await new DefaultAzureCredential().getToken('https://management.azure.com/.default',{abortSignal:signal});return 'Azure 자격 증명';},
    // Sign-in alone proves nothing about roles, so the check also lists what the identity can see.
    scope:async signal=>{const {DefaultAzureCredential}=await import('@azure/identity'),credential=new DefaultAzureCredential();return `구독 ${(await discoverAzureSubscriptions(async()=>(await credential.getToken('https://management.azure.com/.default',{abortSignal:signal})).token,abortableFetch(signal))).length}개`;},
    collect:options=>collectAzure([],options),
  },
  aws:{
    detect:async signal=>{const sts=await import('@aws-sdk/client-sts'),client=new sts.STSClient({region:process.env.AWS_REGION??process.env.AWS_DEFAULT_REGION??'us-east-1',maxAttempts:2});try{const {Account}=await awsSend(client,new sts.GetCallerIdentityCommand({}),signal);return `계정 ${Account}`;}finally{client.destroy();}},
    collect:options=>collectAws([],[],options),
  },
  gcp:{
    detect:async()=>{const {GoogleAuth}=await import('google-auth-library'),auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}),client=await auth.getClient();await client.getAccessToken();return 'Application Default Credentials';},
    collect:async options=>{const {GoogleAuth}=await import('google-auth-library'),client=await new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}).getClient();return collectGcpAuto(gcpRequester(client,options.signal),options);},
  },
};
let drivers=realDrivers;
export const configureCollector=(next:CollectorDrivers=realDrivers,nextLimits:Partial<CollectorLimits>={})=>{drivers=next;limits={...DEFAULT_LIMITS,...nextLimits};};
export const collectorEnabled=()=>process.env.DATA_MODE==='live'&&process.env.ATLAS_COLLECTOR==='1';
// What was read and what was not, per kind of data. Cost skipped by its own schedule keeps the state of the run that last read it.
export const coverageOf=(result:Normalized,keptCost?:Coverage):Partial<Record<Dataset,Coverage>>=>{const g=result.gaps??{},cost=g.cost??keptCost??(result.cost?'ok':undefined);return{iam:g.iam??'ok',activity:g.activity??'ok',...(cost?{cost}:{})};};
export const toSnapshot=(result:Normalized,costAt?:string,keptCost?:Coverage)=>validateSnapshot({version:1,mode:'live',collectedAt:new Date().toISOString(),cost:result.cost,iam:result.iam,activity:result.activity,costAt,coverage:coverageOf(result,keptCost),resources:result.resources,links:result.links,warnings:result.warnings,scopeLabels:result.scopeLabels,hierarchy:result.hierarchy,incomplete:result.incomplete,scopes:[...new Set(result.resources.filter(r=>r.scope!=='external').map(r=>r.scope))]});
let current:Promise<CollectionStatus>|undefined,live:CollectionStatus|undefined;
export const liveStatus=()=>current?live:undefined;
// A process killed mid-run leaves its last status behind. Without this check the portal would show it running forever.
export async function readCollectionStatus(store:SnapshotStore=new FileSnapshotStore()):Promise<CollectionStatus>{
  const saved=liveStatus()??await store.readStatus();if(!saved)return emptyStatus();
  if(!saved.running||saved===live||processAlive(saved.pid))return saved;
  const providers={...saved.providers};
  for(const p of PROVIDERS)if(providers[p]?.state==='running')providers[p]={...providers[p],state:'failed',message:'수집이 끝나기 전에 서버가 종료됐습니다. 다시 수집하세요.',stages:settleStages(providers[p].stages,'failed')};
  return{...saved,running:false,providers};
}
// Rerun at start whenever a cloud has no good result: someone who just set credentials and restarted should not wait for the next hour.
export const needsCollection=(status:CollectionStatus|null,minutes:number,now=Date.now())=>!status?.finishedAt||!minutes||now-Date.parse(status.finishedAt)>minutes*60_000||PROVIDERS.some(p=>!['ok','partial'].includes(status.providers[p]?.state));
const settleStages=(stages:Stage[]=[],outcome:'done'|'failed')=>stages.map(s=>s.state==='running'?{...s,state:outcome}:s.state==='pending'?{...s,state:outcome==='done'?'done' as const:'skipped' as const}:s);
export async function checkCredentials(){return Promise.all(PROVIDERS.map(async p=>{
  let login:string;
  try{login=await withDeadline(drivers[p].detect,limits.detectMs,'로그인 확인');}catch(e){return{provider:p,ok:false,detail:explainAuth(p,e)};}
  const scope=drivers[p].scope;if(!scope)return{provider:p,ok:true,detail:login};
  try{return{provider:p,ok:true,detail:`${login} · ${await withDeadline(scope,limits.detectMs,'범위 확인')}`};}catch(e){return{provider:p,ok:false,detail:`로그인됨 (${login}). ${(e instanceof Error?e.message:String(e)).split('\n')[0]}`};}
}));}
// One run at a time. Providers run independently, so one cloud's failure neither blocks the others nor replaces its last good snapshot.
export function runCollection(store:SnapshotStore=new FileSnapshotStore(),log:(line:string)=>void=()=>{}):Promise<CollectionStatus>{
  if(current)return current;
  current=(async()=>{
    const release=await store.lock?.();
    // Another process is collecting into the same folder; its own status file already says so.
    if(release===null){log('다른 프로세스가 이 데이터 폴더에서 수집 중이라 시작하지 않습니다.');return readCollectionStatus(store);}
    try{return await collect(store,log);}finally{await release?.();}
  })().finally(()=>{current=undefined;});
  return current;
}
async function collect(store:SnapshotStore,log:(line:string)=>void):Promise<CollectionStatus>{
  const status:CollectionStatus={...((await store.readStatus())??emptyStatus()),running:true,startedAt:new Date().toISOString(),pid:process.pid};live=status;
  for(const p of PROVIDERS)status.providers[p]={...status.providers[p],state:'running',message:undefined,stages:newStages(p)};
  // Writes run one at a time: a slow progress write landing after the final one would leave the run looking unfinished.
  let lastWrite=0,writing:Promise<unknown>=Promise.resolve();
  const persist=(force=false)=>{if(!force&&Date.now()-lastWrite<2000)return writing;lastWrite=Date.now();writing=writing.then(()=>store.writeStatus(status)).catch(()=>{/* progress is best effort; the final write is awaited */});return writing;};
  await store.writeStatus(status);
  await Promise.all(PROVIDERS.map(async p=>{
    const at=()=>new Date().toISOString(),driver=drivers[p],track=trackFor(p);
    // Once this cloud's outcome is recorded, late progress from work that missed its deadline is ignored: it would flip settled stages back to running and rewrite the status file.
    let open=true;const settle=(next:ProviderStatus)=>{open=false;status.providers[p]=next;};
    if(inflight.has(p)){settle({...status.providers[p],state:'failed',at:at(),message:'이전 수집이 시간 초과 후 아직 끝나지 않아 이번에는 건너뜁니다. 기존 스냅샷을 유지합니다.',stages:settleStages(status.providers[p].stages,'failed')});log(`${p}: 이전 작업이 남아 있어 건너뜁니다.`);await persist(true);return;}
    const report:Report=(id,patch={})=>{if(!open)return;const stage=status.providers[p].stages?.find(s=>s.id===id);if(!stage||(stage.state==='done'&&!patch.state))return;const before=stage.state;Object.assign(stage,{state:'running',...patch});if(stage.state!==before){log(`${p}: ${stage.label} ${stage.state==='running'?'시작':stage.state==='done'?'완료':stage.state==='skipped'?'건너뜀':'실패'}${stage.detail?` (${stage.detail})`:''}`);persist(true);}else persist();};
    try{
      report('auth');
      const identity=await withDeadline(driver.detect,limits.detectMs,'로그인 확인',track);
      status.providers[p]={...status.providers[p],state:'running',identity};
      report('auth',{state:'done',detail:identity});
    }catch(e){const message=explainAuth(p,e);report('auth',{state:'failed'});settle({state:'unauthenticated',message,at:at(),stages:settleStages(status.providers[p].stages,'failed')});log(`${p}: 로그인되지 않아 건너뜁니다. ${message}`);await persist(true);return;}
    try{
      const previous=await store.latest(p),costAge=previous?.costAt?Date.now()-Date.parse(previous.costAt):Infinity,withCost=costAge>COST_HOURS()*3_600_000;
      if(!withCost)report('cost',{state:'skipped',detail:`${COST_HOURS()}시간에 한 번만 조회합니다`});
      const result=await withDeadline(signal=>driver.collect({withCost,report,signal}),limits.collectMs,'수집',track);
      if(!withCost)result.cost=previous?.cost;
      const costAt=withCost?at():previous?.costAt;
      if(!result.resources.length&&result.incomplete?.length)throw new Error(result.warnings[0]??'읽을 수 있는 자원이 없습니다.');
      report('save');await store.save(p,toSnapshot(result,costAt,withCost?undefined:previous?.coverage?.cost));report('save',{state:'done',detail:`자원 ${result.resources.length}개`});
      const missing=result.incomplete?.length??0;
      settle({...status.providers[p],state:missing?'partial':'ok',at:at(),resources:result.resources.length,message:missing?`범위 ${missing}개에서 일부 항목을 읽지 못했습니다.`:undefined,stages:settleStages(status.providers[p].stages,'done')});
      log(`${p}: 자원 ${result.resources.length}개 저장${missing?` (일부 누락 ${missing})`:''}`);
    }catch(e){
      const raw=shortMessage(e),auth=AUTH_ERROR.test(e instanceof Error?e.message:raw),message=auth?explainAuth(p,e):explainFailure(raw);
      settle({...status.providers[p],state:auth?'unauthenticated':'failed',at:at(),message,stages:settleStages(status.providers[p].stages,'failed')});log(`${p}: 실패, 기존 스냅샷을 유지합니다. ${message}`);
    }
    await persist(true);
  }));
  status.running=false;status.finishedAt=new Date().toISOString();await writing;await store.writeStatus(status);
  return status;
}
