import {RefreshCw} from 'lucide-react';
import {CollectProgress,type CollectState} from './CollectProgress';
export type {CollectState};
export function Onboarding({state,onCollect,onGuide}:{state:CollectState|null;onCollect:()=>void;onGuide:()=>void}){
  const anyRunning=!!state?.running;
  return <div className="onboarding"><div className="onboarding-card"><h1>{anyRunning?'클라우드 구성을 읽는 중입니다':'클라우드 자격 증명을 설정하세요'}</h1>
    <p>{anyRunning?'단계별 진행 상황을 아래에 표시합니다. 끝나면 화면이 자동으로 바뀝니다.':'프로젝트의 .env 파일이나 터미널 로그인으로 자격 증명을 설정한 뒤 다시 확인을 누르세요. 비밀번호와 키는 이 화면에 입력하지 않습니다.'}</p>
    {state?<CollectProgress state={state} onGuide={onGuide}/>:<p className="muted small" role="status">수집 상태를 확인하는 중입니다.</p>}
    <button className="button primary onboarding-action" onClick={onCollect} disabled={anyRunning}><RefreshCw size={14} className={anyRunning?'spin':''}/>{anyRunning?'수집 중':'다시 확인'}</button></div></div>;
}
