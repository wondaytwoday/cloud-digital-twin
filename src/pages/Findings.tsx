import {useState} from 'react';
import {AlertOctagon,AlertTriangle,ChevronRight,Info,Search,ShieldAlert} from 'lucide-react';
import type {Category,Finding,Severity} from '../../shared/findings';
import {Kpi} from '../charts';
const META:Record<Severity,{label:string;icon:typeof Info}>={critical:{label:'긴급',icon:AlertOctagon},high:{label:'높음',icon:ShieldAlert},medium:{label:'보통',icon:AlertTriangle},info:{label:'참고',icon:Info}};
export const CATEGORY:Record<Category,string>={infra:'인프라',network:'네트워크',iam:'IAM',cost:'비용'};
export function FindingList({items,onOpen,limit,showCategory=true}:{items:Finding[];onOpen:(f:Finding)=>void;limit?:number;showCategory?:boolean}){
  const shown=limit?items.slice(0,limit):items;
  if(!shown.length)return <p className="muted small empty-note">확인이 필요한 항목이 없습니다.</p>;
  return <ul className="finding-list">{shown.map(f=>{const {label,icon:Icon}=META[f.severity];return <li key={f.id}><button disabled={!f.target} onClick={()=>onOpen(f)}><span className={`sev sev-${f.severity}`}><Icon size={13}/>{label}</span><span className="finding-text"><strong>{f.title}</strong><small>{f.detail}</small></span>{showCategory&&<span className="finding-cat">{CATEGORY[f.category]}</span>}{f.target&&<ChevronRight size={14} className="finding-go"/>}</button></li>})}</ul>;
}
export function FindingsPage({list,mock,openFinding}:{list:Finding[];mock:boolean;openFinding:(f:Finding)=>void}){
  const [category,setCategory]=useState<Category|'all'>('all'),[severity,setSeverity]=useState<Severity|'all'>('all'),[query,setQuery]=useState(''),q=query.trim().toLowerCase();
  const inArea=list.filter(f=>category==='all'||f.category===category),shown=inArea.filter(f=>(severity==='all'||f.severity===severity)&&(!q||`${f.title} ${f.detail}`.toLowerCase().includes(q)));
  return <div className="page"><header className="page-head"><div><h1>조치 항목</h1><p>{mock?'예시 데이터입니다. ':''}운영자가 확인할 항목을 심각도순으로 모았습니다. 구성에서 찾은 후보이며 확정된 문제는 아닙니다.</p></div></header>
    <section className="kpi-row" aria-label="심각도별 항목 수">{(Object.keys(META) as Severity[]).map(s=>{const n=inArea.filter(f=>f.severity===s).length;return <Kpi key={s} label={META[s].label} value={String(n)} tone={n&&s==='critical'?'bad':n&&s==='high'?'warn':undefined} onClick={()=>setSeverity(s)}/>})}</section>
    <section className="panel"><header className="panel-head wrap"><h2>조치 목록 <span className="count">{shown.length}</span></h2><div className="table-tools"><label className="mini-search"><Search size={14}/><input aria-label="조치 항목 검색" placeholder="제목, 내용 찾기" value={query} onChange={e=>setQuery(e.target.value)}/></label><label className="inline-field">심각도<select value={severity} onChange={e=>setSeverity(e.target.value as typeof severity)}><option value="all">전체</option>{(Object.keys(META) as Severity[]).map(s=><option key={s} value={s}>{META[s].label}</option>)}</select></label><div className="segmented" role="group" aria-label="영역 필터">{(['all','network','iam','cost','infra'] as const).map(c=><button key={c} className={category===c?'active':''} aria-pressed={category===c} onClick={()=>setCategory(c)}>{c==='all'?'전체':CATEGORY[c]}</button>)}</div></div></header><FindingList items={shown} onOpen={openFinding}/></section></div>;
}
