import {compactInventory} from './inventory.js';
import {RequestGate} from './request-gate.js';
import {proxyConfigured} from './request-error.js';
import {positiveSetting,mapLimit} from './async.js';
import {retainIncomplete} from './reconcile.js';
import {costCoverageMessage} from '../shared/collectionView.js';
import {classificationSummary} from '../shared/classification.js';
import {collectAws,collectAzure,collectGcpAuto,discoverAzureSubscriptions,type CollectOptions} from './collectors.js';
import type {Normalized} from './normalize.js';
import {FileSnapshotStore,type SnapshotStore} from './store.js';
import {existsSync} from 'node:fs';
import {validateSnapshot} from '../shared/schema.js';
import {newStages,type CollectionStatus,type ProviderId,type ProviderState,type ProviderStatus,type Report,type Stage} from '../shared/collect.js';
export type {CollectionStatus,ProviderId,ProviderState,ProviderStatus};
export type ProviderDriver={detect:()=>Promise<string>;scope?:()=>Promise<string>;collect:(options:CollectOptions&{report?:Report})=>Promise<Normalized>};
export type CollectorDrivers=Record<ProviderId,ProviderDriver>;
export const PROVIDERS:ProviderId[]=['azure','aws','gcp'];
// Cost APIs bill per request or per byte scanned, so they run far less often than inventory.
const COST_HOURS=()=>Number(process.env.ATLAS_COST_HOURS??24);
const DETECT_TIMEOUT=30_000;
const collectionTimeout=()=>positiveSetting(process.env.ATLAS_COLLECT_TIMEOUT_MIN,15,180)*60_000;
const activeCollectors=new Map<ProviderId,Promise<Normalized>>();
export const emptyStatus=():CollectionStatus=>({running:false,providers:{azure:{state:'idle'},aws:{state:'idle'},gcp:{state:'idle'}}});
const withTimeout=<T>(work:Promise<T>,ms:number,what:string)=>{let timer:NodeJS.Timeout;return Promise.race([work,new Promise<never>((_,fail)=>{timer=setTimeout(()=>fail(new Error(`${what} 시간 초과`)),ms);})]).finally(()=>clearTimeout(timer));};
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
    detect:async()=>{const {DefaultAzureCredential}=await import('@azure/identity');await new DefaultAzureCredential().getToken('https://management.azure.com/.default');return 'Azure 자격 증명';},
    // Sign-in alone proves nothing about roles, so the check also lists what the identity can see.
    scope:async()=>{const {DefaultAzureCredential}=await import('@azure/identity'),credential=new DefaultAzureCredential();return `구독 ${(await discoverAzureSubscriptions(async()=>(await credential.getToken('https://management.azure.com/.default')).token)).length}개`;},
    collect:options=>collectAzure([],options),
  },
  aws:{
    detect:async()=>{const sts=await import('@aws-sdk/client-sts'),client=new sts.STSClient({region:process.env.AWS_REGION??process.env.AWS_DEFAULT_REGION??'us-east-1',maxAttempts:2});try{const {Account}=await client.send(new sts.GetCallerIdentityCommand({}));return `계정 ${Account}`;}finally{client.destroy();}},
    collect:options=>collectAws([],[],options),
  },
  gcp:{
    detect:async()=>{const {GoogleAuth}=await import('google-auth-library'),auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}),client=await auth.getClient();await client.getAccessToken();return 'Application Default Credentials';},
    collect:async options=>{const {GoogleAuth}=await import('google-auth-library'),client=await new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}).getClient();return collectGcpAuto(async(url,init)=>{const work=()=>client.request({url,timeout:60_000,signal:options.signal,retryConfig:{retry:url.startsWith('https://bigquery.googleapis.com/')?0:3},...(init?{method:init.method as 'POST',data:init.data}:{})});const response=await (options.requests?options.requests.run(work,options.signal):work());return response.data;},options);},
  },
};
let drivers=realDrivers;
export const configureCollector=(next:CollectorDrivers=realDrivers)=>{drivers=next;};
export const collectorEnabled=()=>process.env.DATA_MODE==='live'&&process.env.ATLAS_COLLECTOR==='1';
export const toSnapshot=(result:Normalized,costAt?:string,scopeCollectedAt:Record<string,string>={})=>validateSnapshot({version:1,scopeCollectedAt,inventoryMode:result.inventoryMode,inventorySummary:result.inventorySummary,mode:'live',collectedAt:new Date().toISOString(),cost:result.cost,costCoverage:result.costCoverage,collectionGaps:result.collectionGaps,iam:result.iam,activity:result.activity,costAt,resources:result.resources,links:result.links,warnings:result.warnings,scopeLabels:result.scopeLabels,hierarchy:result.hierarchy,incomplete:result.incomplete,scopes:[...new Set([...result.collectedScopes??[],...result.resources.filter(r=>r.scope!=='external').map(r=>r.scope)])]});
let current:Promise<CollectionStatus>|undefined,live:CollectionStatus|undefined;
export const liveStatus=()=>current?live:undefined;
const alive=(pid?:number)=>{if(!pid)return false;try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}};
// A process killed mid-run leaves its last status behind. Without this check the portal would show it running forever.
export async function readCollectionStatus(store:SnapshotStore=new FileSnapshotStore()):Promise<CollectionStatus>{
  const saved=liveStatus()??await store.readStatus();if(!saved)return emptyStatus();
  if(!saved.running||saved===live||alive(saved.pid))return saved;
  const providers={...saved.providers};
  for(const p of PROVIDERS)if(providers[p]?.state==='running')providers[p]={...providers[p],state:'failed',message:'수집이 끝나기 전에 서버가 종료됐습니다. 다시 수집하세요.',stages:settleStages(providers[p].stages,'failed')};
  return{...saved,running:false,providers};
}
// Rerun at start whenever a cloud has no good result: someone who just set credentials and restarted should not wait for the next hour.
export const needsCollection=(status:CollectionStatus|null,minutes:number,now=Date.now())=>!status?.finishedAt||!minutes||now-Date.parse(status.finishedAt)>minutes*60_000||PROVIDERS.some(p=>!['ok','partial'].includes(status.providers[p]?.state));
const settleStages=(stages:Stage[]=[],outcome:'done'|'failed')=>stages.map(s=>s.state==='running'?{...s,state:outcome}:s.state==='pending'?{...s,state:outcome==='done'?'done' as const:'skipped' as const}:s);
export async function checkCredentials(){return Promise.all(PROVIDERS.map(async p=>{
  let login:string;
  try{login=await withTimeout(drivers[p].detect(),DETECT_TIMEOUT,'로그인 확인');}catch(e){return{provider:p,ok:false,detail:explainAuth(p,e)};}
  const scope=drivers[p].scope;if(!scope)return{provider:p,ok:true,detail:login};
  try{return{provider:p,ok:true,detail:`${login} · ${await withTimeout(scope(),DETECT_TIMEOUT,'범위 확인')}`};}catch(e){return{provider:p,ok:false,detail:`로그인됨 (${login}). ${(e instanceof Error?e.message:String(e)).split('\n')[0]}`};}
}));}
// One run at a time. Providers run independently, so one cloud's failure neither blocks the others nor replaces its last good snapshot.
export function runCollection(store:SnapshotStore=new FileSnapshotStore(),log:(line:string)=>void=()=>{},options:{timeoutMs?:number;providers?:ProviderId[];collectors?:Partial<Record<ProviderId,ProviderDriver['collect']>>}={}):Promise<CollectionStatus>{
  if(current)return current;
  current=(async()=>{
    const status:CollectionStatus={...((await store.readStatus())??emptyStatus()),running:true,startedAt:new Date().toISOString(),pid:process.pid};live=status;
    const selected=options.providers??PROVIDERS;
    const requests=new RequestGate(Math.max(1,Math.floor(positiveSetting(process.env.ATLAS_REQUEST_CONCURRENCY,proxyConfigured()?4:8,32))));
    const providerLimit=Math.max(1,Math.floor(positiveSetting(process.env.ATLAS_PROVIDER_CONCURRENCY,proxyConfigured()?1:2,3)));
    for(const p of selected)status.providers[p]={...status.providers[p],state:'running',message:undefined,slowStages:[],stages:newStages(p)};
    // Writes run one at a time: a slow progress write landing after the final one would leave the run looking unfinished.
    let lastWrite=0,writing:Promise<unknown>=Promise.resolve();
    const persist=(force=false)=>{if(!force&&Date.now()-lastWrite<2000)return writing;lastWrite=Date.now();writing=writing.then(()=>store.writeStatus(status)).catch(()=>{/* progress is best effort; the final write is awaited */});return writing;};
    await store.writeStatus(status);
    await mapLimit(selected,providerLimit,async p=>{
      const at=()=>new Date().toISOString(),driver=drivers[p];
      const report:Report=(id,patch={})=>{
        const stage=status.providers[p].stages?.find(s=>s.id===id);
        if(!stage||(stage.state==='done'&&!patch.state))return;
        if(patch.elapsedMs!==undefined){
          const slow=status.providers[p].slowStages??[];
          status.providers[p].slowStages=[...slow,{id,detail:patch.detail??stage.label,elapsedMs:patch.elapsedMs}]
            .sort((a,b)=>b.elapsedMs-a.elapsedMs).slice(0,5);
          log(`${p}: ${patch.detail??stage.label} ${patch.elapsedMs}ms`);
        }
        const before=stage.state;
        Object.assign(stage,{state:'running',...patch});
        if(stage.state!==before){
          log(`${p}: ${stage.label} ${stage.state==='running'?'시작':stage.state==='done'?'완료':stage.state==='skipped'?'건너뜀':'실패'}${stage.detail?` (${stage.detail})`:''}`);
          persist(true);
        }else persist();
      };
      if(activeCollectors.has(p)){status.providers[p]={...status.providers[p],state:'failed',message:'이전 수집 요청의 취소를 기다리고 있습니다. 요청이 끝난 뒤 다시 수집하세요.',stages:settleStages(status.providers[p].stages,'failed')};await persist(true);return;}
      try{
        report('auth');
        const identity=await withTimeout(driver.detect(),DETECT_TIMEOUT,'로그인 확인');
        status.providers[p]={...status.providers[p],state:'running',identity};
      report('auth',{state:'done',detail:identity});
      }catch(e){const message=explainAuth(p,e);report('auth',{state:'failed'});status.providers[p]={state:'unauthenticated',message,at:at(),stages:settleStages(status.providers[p].stages,'failed')};log(`${p}: 로그인되지 않아 건너뜁니다. ${message}`);await persist(true);return;}
      let latestCheckpoint:Normalized|undefined;
      try{
        const previous=await store.latest(p),costAge=previous?.costAt?Date.now()-Date.parse(previous.costAt):Infinity;
        // Older versions marked an empty GCP export complete. Do not let that
        // cached result suppress the first read after this fix for 24 hours.
        const emptyGcp=p==='gcp'&&process.env.ATLAS_GCP_ALLOW_EMPTY_COST!=='1'&&!previous?.cost.some(c=>c.provider==='gcp');
        const withCost=emptyGcp||!previous?.costCoverage.some(c=>c.provider===p)||!Number.isFinite(costAge)||costAge>COST_HOURS()*3_600_000||!!previous?.costCoverage.some(c=>c.state!=='complete');
        if(!withCost)report('cost',{state:'skipped',detail:`${COST_HOURS()}시간에 한 번만 조회합니다`});
        const scopeCollectedAt:Record<string,string>={...Object.fromEntries((previous?.scopes??[]).filter(s=>!previous?.incomplete.includes(s)).map(s=>[s,previous!.collectedAt])),...previous?.scopeCollectedAt};
        const controller=new AbortController();let checkpoint:Normalized|undefined,timedOut=false;
        const job=Promise.resolve().then(()=>(options.collectors?.[p]??driver.collect)({withCost,signal:controller.signal,scopeCollectedAt,requests,
          report:(id,patch)=>{if(!controller.signal.aborted)report(id,patch);},
          checkpoint:value=>{if(!controller.signal.aborted){checkpoint=structuredClone(value);latestCheckpoint=checkpoint;}},
        }));
        activeCollectors.set(p,job);
        void job.then(()=>{if(activeCollectors.get(p)===job)activeCollectors.delete(p);},()=>{if(activeCollectors.get(p)===job)activeCollectors.delete(p);});
        let result:Normalized,timer:NodeJS.Timeout|undefined;
        try{
          result=await Promise.race([job,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort(new Error('수집 시간 초과'));reject(new Error('수집 시간 초과'));},options.timeoutMs??collectionTimeout());})]);
        }catch(e){
          if(!timedOut||!checkpoint||!checkpoint.collectedScopes?.length)throw e;
          result=checkpoint;
          result.warnings.push('AWS: 수집 시간 초과. 완료된 계정 결과를 저장하고 미완료 범위의 이전 결과를 유지합니다.');
          report('resources',{state:'failed',detail:'수집 시간 초과 · 완료 계정 보존'});
        }finally{if(timer)clearTimeout(timer);}
        if(!result.resources.length&&result.incomplete?.length&&!result.collectedScopes?.length)throw new Error(result.warnings[0]??'읽을 수 있는 자원이 없습니다.');
        const coverage=result.costCoverage?.find(c=>c.provider===p);
        let costAt=previous?.costAt;
        if(!withCost){result.cost=previous?.cost;result.costCoverage=previous?.costCoverage;}
        else{
          // Drivers without coverage metadata are supported, but absence of rows is not proof of a successful read.
          const effective=coverage??{provider:p,state:timedOut?'failed' as const:result.cost!==undefined?'complete' as const:'unconfigured' as const,failedScopes:p==='aws'?[]:result.incomplete??[],...(timedOut?{reason:'skipped-timeout' as const,...(p==='aws'?{unit:'organization' as const}:{})}:{})};
          result.costCoverage=[effective];
          if(effective.state==='complete')costAt=at();
          else if(effective.state==='partial'){
            const failed=new Set(effective.failedScopes);
            result.cost=[...result.cost??[],...previous?.cost.filter(c=>failed.has(c.scope))??[]];
          }else result.cost=previous?.cost??result.cost;
        }
        for(const scope of result.collectedScopes??[])scopeCollectedAt[scope]=at();
        const progress=result.accountProgress;
        result=compactInventory(retainIncomplete(result,previous),previous);
        // Drop timestamps for scopes no longer in the discovered/saved collection.
        const kept=new Set([...result.collectedScopes??[],...result.incomplete??[]]);
        for(const scope of Object.keys(scopeCollectedAt))if(!kept.has(scope))delete scopeCollectedAt[scope];
        report('save');await store.save(p,toSnapshot(result,costAt,scopeCollectedAt));report('save',{state:'done',detail:`자원 ${result.resources.length}개`});
        const missing=result.incomplete?.length??0,costProblem=result.costCoverage?.find(c=>c.provider===p&&['failed','partial','pending'].includes(c.state));
        const message=[missing?`범위 ${missing}개에서 일부 항목을 읽지 못했습니다.`:'',costProblem?`비용 일부 누락 · ${costCoverageMessage(costProblem)} 이전 비용이 있으면 유지합니다.`:'',timedOut?`수집 시간 초과 · 완료 ${progress?.completed??0} / 전체 ${progress?.total??0}계정. 다음 수집에서 미수집·오래된 계정부터 이어서 진행합니다. ATLAS_COLLECT_TIMEOUT_MIN으로 제한 시간을 조정할 수 있습니다.`:''].filter(Boolean).join(' ');
        status.providers[p]={...status.providers[p],state:missing||costProblem||timedOut?'partial':'ok',at:at(),resources:result.resources.length,message:message||undefined,stages:settleStages(status.providers[p].stages,'done')};
        log(`${p}: 자원 ${result.resources.length}개 저장${message?` · ${message}`:''}`);
        const unknown=classificationSummary(result.resources);if(unknown.length)log(`${p}: 미분류 타입 상위 ${unknown.map(x=>`${x.type} ${x.count}개`).join(', ')}`);
      }catch(e){
        const raw=shortMessage(e),auth=AUTH_ERROR.test(e instanceof Error?e.message:raw),baseMessage=auth?explainAuth(p,e):explainFailure(raw);
        const pendingCost=latestCheckpoint?.costCoverage?.find(c=>c.state!=='complete');
        const message=/수집 시간 초과/.test(raw)&&pendingCost?`${baseMessage}. ${costCoverageMessage(pendingCost)}`:baseMessage;
        if(/수집 시간 초과/.test(raw)&&pendingCost)report('cost',{state:'failed',detail:costCoverageMessage(pendingCost)});
        status.providers[p]={...status.providers[p],state:auth?'unauthenticated':'failed',at:at(),message,stages:settleStages(status.providers[p].stages,'failed')};log(`${p}: 실패, 기존 스냅샷을 유지합니다. ${message}`);
      }
      await persist(true);
    });
    status.running=false;status.finishedAt=new Date().toISOString();await writing;await store.writeStatus(status);
    return status;
  })().finally(()=>{current=undefined;});
  return current;
}
