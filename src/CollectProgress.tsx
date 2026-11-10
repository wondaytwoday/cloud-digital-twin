import {useEffect,useState} from 'react';
import {Check,Circle,CircleAlert,KeyRound,Minus,RefreshCw} from 'lucide-react';
import {overallProgress,providerProgress,type CollectionStatus,type ProviderId,type ProviderState,type Stage,type StageState} from '../shared/collect';
import {connectors} from '../shared/connectors';
import {ProviderMark} from './graph';
export type CollectState=CollectionStatus&{enabled:boolean};
const STATE_LABEL:Record<ProviderState,string>={idle:'대기 중',running:'수집 중',ok:'완료',partial:'일부 누락',failed:'실패',unauthenticated:'로그인 필요'};
const STAGE_LABEL:Record<StageState,string>={pending:'대기',running:'진행 중',done:'완료',skipped:'건너뜀',failed:'실패'};
const stateIcon=(state:ProviderState)=>state==='running'?<RefreshCw size={15} className="spin"/>:state==='ok'||state==='partial'?<Check size={15}/>:state==='unauthenticated'?<KeyRound size={15}/>:state==='failed'?<CircleAlert size={15}/>:null;
const stageIcon=(state:StageState)=>state==='running'?<RefreshCw size={13} className="spin"/>:state==='done'?<Check size={13}/>:state==='failed'?<CircleAlert size={13}/>:state==='skipped'?<Minus size={13}/>:<Circle size={13}/>;
const elapsedText=(ms:number)=>{const s=Math.max(0,Math.floor(ms/1000));return s<60?`${s}초`:`${Math.floor(s/60)}분 ${s%60}초`;};
export const percent=(state:Pick<CollectionStatus,'providers'>)=>Math.round(overallProgress(state)*100);
export function ProgressBar({value,label,active}:{value:number;label:string;active:boolean}){
  return <div className={`progress ${active?'is-active':''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><i style={{width:`${value}%`}}/></div>;
}
function StageRow({stage}:{stage:Stage}){
  return <li className={`collect-stage is-${stage.state}`}>{stageIcon(stage.state)}<span className="stage-name">{stage.label}<span className="sr-only"> {STAGE_LABEL[stage.state]}</span></span><span className="stage-detail" title={stage.detail}>{stage.detail}{stage.elapsedMs!==undefined?` · ${elapsedText(stage.elapsedMs)}`:''}{stage.state==='running'&&stage.total?` (${Math.min(stage.done??0,stage.total)}/${stage.total})`:''}</span></li>;
}
// What is being read right now, per cloud, so a long run never looks like a hang.
export function CollectProgress({state,onGuide}:{state:CollectState;onGuide?:()=>void}){
  const [now,setNow]=useState(Date.now()),value=percent(state);
  useEffect(()=>{if(!state.running)return;const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[state.running]);
  return <div className="collect-progress">
    {state.running?<div className="collect-overall"><div className="collect-overall-head"><strong>전체 {value}%</strong>{state.startedAt&&<span>경과 {elapsedText(now-Date.parse(state.startedAt))}</span>}</div><ProgressBar value={value} label="전체 수집 진행률" active/></div>:state.finishedAt&&<p className="collect-last">마지막 수집 {new Date(state.finishedAt).toLocaleString('ko-KR')}</p>}
    {connectors.map(c=>{const run=state.providers[c.provider as ProviderId],show=run?.stages?.length&&run.state!=='unauthenticated'&&(state.running||run.state==='failed'||run.state==='partial');return <section className="collect-provider" key={c.provider} aria-label={c.name}>
      <header><ProviderMark provider={c.provider}/><strong>{c.name}</strong><span className={`collect-state s-${run?.state??'idle'}`} role="status">{stateIcon(run?.state??'idle')}{STATE_LABEL[run?.state??'idle']}{run?.state==='ok'||run?.state==='partial'?` · 자원 ${run.resources??0}개`:''}</span></header>
      {run?.identity&&run.state!=='unauthenticated'&&<p className="collect-identity">{run.identity}</p>}
      {run?.state==='running'&&<ProgressBar value={Math.round(providerProgress(run.stages)*100)} label={`${c.name} 수집 진행률`} active/>}
      {show?<ol className="stage-list">{run.stages!.map(s=><StageRow key={s.id} stage={s}/>)}</ol>:null}
      {run?.message&&<p className={`collect-message ${run.state==='failed'||run.state==='unauthenticated'?'is-problem':''}`}>{run.message}</p>}
      {!!run?.slowStages?.length&&!state.running&&<details><summary>느린 수집 구간 상위 {run.slowStages.length}개</summary><ul>{run.slowStages.map((s,i)=><li key={`${s.id}:${i}`}>{s.detail} · {elapsedText(s.elapsedMs)}</li>)}</ul></details>}
      {run?.state==='unauthenticated'&&<div className="code-box"><pre>{c.command}</pre></div>}
    </section>})}
    {onGuide&&<button className="link-button small" onClick={onGuide}>자격 증명 설정 방법 보기</button>}
  </div>;
}
