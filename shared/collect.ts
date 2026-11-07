export type ProviderId='azure'|'aws'|'gcp';
export type ProviderState='idle'|'running'|'ok'|'partial'|'failed'|'unauthenticated';
export type StageId='auth'|'scopes'|'resources'|'iam'|'activity'|'cost'|'save';
export type StageState='pending'|'running'|'done'|'skipped'|'failed';
export type Stage={id:StageId;label:string;state:StageState;detail?:string;done?:number;total?:number};
export type ProviderStatus={state:ProviderState;message?:string;at?:string;resources?:number;identity?:string;stages?:Stage[]};
// kubernetes is present only when clusters are configured (ATLAS_KUBERNETES); it is read after the clouds, through the Kubernetes API.
export type CollectionStatus={running:boolean;startedAt?:string;finishedAt?:string;pid?:number;providers:Record<ProviderId,ProviderStatus>;kubernetes?:ProviderStatus};
export type Report=(stage:StageId,patch?:Partial<Pick<Stage,'state'|'detail'|'done'|'total'>>)=>void;
export const noReport:Report=()=>{};
const SCOPE_STAGE:Record<ProviderId,string>={azure:'구독 찾기',aws:'조직·계정 찾기',gcp:'조직·프로젝트 찾기'};
export const newStages=(p:ProviderId):Stage[]=>([['auth','로그인 확인'],['scopes',SCOPE_STAGE[p]],['resources','자원·네트워크'],['iam','역할 할당'],['activity','변경 기록'],['cost','비용'],['save','저장']] as const).map(([id,label])=>({id,label,state:'pending'}));
const fraction=(s:Stage)=>s.state==='done'||s.state==='failed'?1:s.state==='running'&&s.total?Math.min(1,(s.done??0)/s.total):0;
// Skipped stages leave the count, so a cloud that never signed in reads as finished rather than stuck at one sixth.
export function providerProgress(stages:Stage[]=[]){const counted=stages.filter(s=>s.state!=='skipped');return counted.length?counted.reduce((n,s)=>n+fraction(s),0)/counted.length:0;}
export function overallProgress(status:Pick<CollectionStatus,'providers'>){const all=Object.values(status.providers).filter(p=>p.stages?.length);return all.length?all.reduce((n,p)=>n+providerProgress(p.stages),0)/all.length:0;}
