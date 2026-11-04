import {useState} from 'react';
import {ArrowUpRight,Minus,PenLine,Plus} from 'lucide-react';
import type {Change,Snapshot} from '../../shared/schema';
import {inScope,type Focus} from '../../shared/hierarchy';
import {ProviderMark} from '../graph';
import {Kpi} from '../charts';
const KINDS:Record<Change['kind'],{label:string;icon:typeof Plus}>={added:{label:'추가',icon:Plus},changed:{label:'변경',icon:PenLine},removed:{label:'삭제',icon:Minus}};
const when=(iso:string)=>new Date(iso).toLocaleString('ko-KR');
export function ChangesPage({snapshot,focus,openResource}:{snapshot:Snapshot;focus:Focus;openResource:(id:string)=>void}){
  const [kind,setKind]=useState<Change['kind']|'all'>('all');
  const items=(snapshot.changes?.items??[]).filter(c=>inScope(focus,c.provider,c.scope)),shown=items.filter(c=>kind==='all'||c.kind===kind),known=new Set(snapshot.resources.map(r=>r.id));
  const count=(k:Change['kind'])=>items.filter(c=>c.kind===k).length,label=(s:string)=>snapshot.scopeLabels[s]??s;
  // Only the latest pair of collections reaches the client, so the page says what it compares instead of implying a full history.
  return <div className="page"><header className="page-head"><div><h1>변경 이력</h1><p>{snapshot.mode==='mock'?'예시 데이터입니다. ':''}{snapshot.changes?`${when(snapshot.changes.since)} 수집과 ${when(snapshot.collectedAt)} 수집을 비교합니다. 그 이전 회차는 아직 볼 수 없습니다.`:'비교할 이전 수집이 없습니다. 다음 수집부터 표시합니다.'}</p></div></header>
    <section className="kpi-row" aria-label="변경 지표">{(Object.keys(KINDS) as Change['kind'][]).map(k=><Kpi key={k} label={KINDS[k].label} value={String(count(k))} onClick={()=>setKind(k)}/>)}</section>
    <section className="panel"><header className="panel-head wrap"><h2>변경 내역 <span className="count">{shown.length}</span></h2><div className="segmented" role="group" aria-label="변경 유형 필터">{(['all','added','changed','removed'] as const).map(k=><button key={k} className={kind===k?'active':''} aria-pressed={kind===k} onClick={()=>setKind(k)}>{k==='all'?'전체':KINDS[k].label}</button>)}</div></header>
      {shown.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>유형</th><th>자원</th><th>클라우드</th><th>범위</th><th>내용</th></tr></thead><tbody>{shown.map(c=>{const Icon=KINDS[c.kind].icon;return <tr key={c.id+c.kind}><td><span className={`change-kind change-${c.kind}`}><Icon size={13}/>{KINDS[c.kind].label}</span></td><td>{known.has(c.id)?<button className="table-link" onClick={()=>openResource(c.id)}>{c.name}<ArrowUpRight size={12}/></button>:c.name}</td><td><ProviderMark provider={c.provider}/></td><td>{label(c.scope)}</td><td>{c.detail}</td></tr>})}</tbody></table></div>:<p className="muted small empty-note">이 조건에 해당하는 변경이 없습니다.</p>}</section></div>;
}
