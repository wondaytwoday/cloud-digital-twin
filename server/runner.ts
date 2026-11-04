import {collectAws,collectAzure,collectGcpAuto,type CollectOptions} from './collectors.js';
import type {Normalized} from './normalize.js';
import {FileSnapshotStore,type SnapshotStore} from './store.js';
import {validateSnapshot} from '../shared/schema.js';
export type ProviderId='azure'|'aws'|'gcp';
export type ProviderState='idle'|'running'|'ok'|'partial'|'failed'|'unauthenticated';
export type ProviderStatus={state:ProviderState;message?:string;at?:string;resources?:number;identity?:string};
export type CollectionStatus={running:boolean;finishedAt?:string;providers:Record<ProviderId,ProviderStatus>};
export type ProviderDriver={detect:()=>Promise<string>;collect:(options:CollectOptions)=>Promise<Normalized>};
export type CollectorDrivers=Record<ProviderId,ProviderDriver>;
export const PROVIDERS:ProviderId[]=['azure','aws','gcp'];
// Cost APIs bill per request or per byte scanned, so they run far less often than inventory.
const COST_HOURS=()=>Number(process.env.ATLAS_COST_HOURS??24);
const DETECT_TIMEOUT=30_000,COLLECT_TIMEOUT=15*60_000;
export const emptyStatus=():CollectionStatus=>({running:false,providers:{azure:{state:'idle'},aws:{state:'idle'},gcp:{state:'idle'}}});
const withTimeout=<T>(work:Promise<T>,ms:number,what:string)=>{let timer:NodeJS.Timeout;return Promise.race([work,new Promise<never>((_,fail)=>{timer=setTimeout(()=>fail(new Error(`${what} 시간 초과`)),ms);})]).finally(()=>clearTimeout(timer));};
// SDK errors can run to pages and quote request details; the portal only needs the first line.
const shortMessage=(e:unknown)=>(e instanceof Error?e.message:String(e)).split('\n')[0].slice(0,200);
const AUTH_ERROR=/expired|credential|not logged|az login|sso login|invalid_grant|unauthorized_client|InvalidClientTokenId|could not load/i;
const realDrivers:CollectorDrivers={
  azure:{
    detect:async()=>{const {DefaultAzureCredential}=await import('@azure/identity');await new DefaultAzureCredential().getToken('https://management.azure.com/.default');return 'Azure 자격 증명';},
    collect:options=>collectAzure([],options),
  },
  aws:{
    detect:async()=>{const sts=await import('@aws-sdk/client-sts'),client=new sts.STSClient({region:process.env.AWS_REGION??process.env.AWS_DEFAULT_REGION??'us-east-1',maxAttempts:2});try{const {Account}=await client.send(new sts.GetCallerIdentityCommand({}));return `계정 ${Account}`;}finally{client.destroy();}},
    collect:options=>collectAws([],[],options),
  },
  gcp:{
    detect:async()=>{const {GoogleAuth}=await import('google-auth-library'),auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}),client=await auth.getClient();await client.getAccessToken();return 'Application Default Credentials';},
    collect:async options=>{const {GoogleAuth}=await import('google-auth-library'),client=await new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}).getClient();return collectGcpAuto(async(url,init)=>{const response=await client.request({url,timeout:60_000,retryConfig:{retry:3},...(init?{method:init.method as 'POST',data:init.data}:{})});return response.data;},options);},
  },
};
let drivers=realDrivers;
export const configureCollector=(next:CollectorDrivers)=>{drivers=next;};
export const collectorEnabled=()=>process.env.DATA_MODE==='live'&&process.env.ATLAS_COLLECTOR==='1';
export const toSnapshot=(result:Normalized,costAt?:string)=>validateSnapshot({version:1,mode:'live',collectedAt:new Date().toISOString(),cost:result.cost,iam:result.iam,costAt,resources:result.resources,links:result.links,warnings:result.warnings,scopeLabels:result.scopeLabels,hierarchy:result.hierarchy,incomplete:result.incomplete,scopes:[...new Set(result.resources.filter(r=>r.scope!=='external').map(r=>r.scope))]});
let current:Promise<CollectionStatus>|undefined,live:CollectionStatus|undefined;
export const liveStatus=()=>live;
// One run at a time. Providers run independently, so one cloud's failure neither blocks the others nor replaces its last good snapshot.
export function runCollection(store:SnapshotStore=new FileSnapshotStore(),log:(line:string)=>void=()=>{}):Promise<CollectionStatus>{
  if(current)return current;
  current=(async()=>{
    const status:CollectionStatus={...((await store.readStatus())??emptyStatus()),running:true};live=status;
    for(const p of PROVIDERS)status.providers[p]={...status.providers[p],state:'running',message:undefined};
    await store.writeStatus(status);
    await Promise.all(PROVIDERS.map(async p=>{
      const at=()=>new Date().toISOString(),driver=drivers[p];
      try{
        const identity=await withTimeout(driver.detect(),DETECT_TIMEOUT,'로그인 확인');
        status.providers[p]={...status.providers[p],state:'running',identity};
      }catch(e){status.providers[p]={state:'unauthenticated',message:shortMessage(e),at:at()};log(`${p}: 로그인되어 있지 않아 건너뜁니다.`);await store.writeStatus(status);return;}
      try{
        const previous=await store.latest(p),costAge=previous?.costAt?Date.now()-Date.parse(previous.costAt):Infinity,withCost=costAge>COST_HOURS()*3_600_000;
        const result=await withTimeout(driver.collect({withCost}),COLLECT_TIMEOUT,'수집');
        if(!withCost)result.cost=previous?.cost;
        const costAt=withCost?at():previous?.costAt;
        if(!result.resources.length&&result.incomplete?.length)throw new Error(result.warnings[0]??'읽을 수 있는 자원이 없습니다.');
        await store.save(p,toSnapshot(result,costAt));
        const missing=result.incomplete?.length??0;
        status.providers[p]={...status.providers[p],state:missing?'partial':'ok',at:at(),resources:result.resources.length,message:missing?`범위 ${missing}개에서 일부 항목을 읽지 못했습니다.`:undefined};
        log(`${p}: 자원 ${result.resources.length}개 저장${missing?` (일부 누락 ${missing})`:''}`);
      }catch(e){
        const message=shortMessage(e);
        status.providers[p]={...status.providers[p],state:AUTH_ERROR.test(message)?'unauthenticated':'failed',at:at(),message};log(`${p}: 실패, 기존 스냅샷을 유지합니다. ${message}`);
      }
      await store.writeStatus(status);
    }));
    status.running=false;status.finishedAt=new Date().toISOString();await store.writeStatus(status);
    return status;
  })().finally(()=>{current=undefined;});
  return current;
}
