import {CheckCircle2,CircleAlert,KeyRound,RefreshCw} from 'lucide-react';
import {connectors} from '../shared/connectors';
import {ProviderMark} from './graph';
export type ProviderProgress={state:'idle'|'running'|'ok'|'partial'|'failed'|'unauthenticated';message?:string;identity?:string;resources?:number};
export type CollectState={enabled:boolean;running:boolean;finishedAt?:string;providers:Record<'azure'|'aws'|'gcp',ProviderProgress>};
const label:Record<ProviderProgress['state'],string>={idle:'대기 중',running:'수집 중',ok:'완료',partial:'일부 누락',failed:'실패',unauthenticated:'로그인 필요'};
const icon=(state:ProviderProgress['state'])=>state==='running'?<RefreshCw size={16} className="spin"/>:state==='ok'||state==='partial'?<CheckCircle2 size={16}/>:state==='unauthenticated'?<KeyRound size={16}/>:state==='failed'?<CircleAlert size={16}/>:null;
export function Onboarding({state,onCollect}:{state:CollectState|null;onCollect:()=>void}){
  const anyRunning=!!state?.running;
  return <div className="onboarding"><div className="onboarding-card"><h1>{anyRunning?'클라우드 구성을 읽는 중입니다':'클라우드에 로그인하세요'}</h1>
    <p>로그인된 클라우드는 자동으로 찾아 수집합니다. 서버 PC의 터미널에서 로그인한 뒤 다시 확인을 누르세요. 비밀번호와 키는 이 화면에 입력하지 않습니다.</p>
    {connectors.map(c=>{const run=state?.providers[c.provider];return <section className="onboarding-row" key={c.provider} aria-label={c.name}><header><ProviderMark provider={c.provider}/><strong>{c.name}</strong>{run&&icon(run.state)}<span role="status">{run?label[run.state]:'확인 중'}{run?.identity?` · ${run.identity}`:''}</span></header>{run?.state==='unauthenticated'&&<div className="code-box"><pre>{c.command}</pre></div>}{run?.state==='failed'&&run.message&&<p>{run.message}</p>}</section>})}
    <button className="button primary" onClick={onCollect} disabled={anyRunning}><RefreshCw size={14} className={anyRunning?'spin':''}/>{anyRunning?'수집 중':'다시 확인'}</button></div></div>;
}
