import {AlertOctagon,AlertTriangle,ChevronRight,Info,ShieldAlert} from 'lucide-react';
import type {Category,Finding,Severity} from '../../shared/findings';
const META:Record<Severity,{label:string;icon:typeof Info}>={critical:{label:'긴급',icon:AlertOctagon},high:{label:'높음',icon:ShieldAlert},medium:{label:'보통',icon:AlertTriangle},info:{label:'참고',icon:Info}};
export const CATEGORY:Record<Category,string>={infra:'인프라',network:'네트워크',iam:'IAM',cost:'비용'};
export function FindingList({items,onOpen,limit,showCategory=true}:{items:Finding[];onOpen:(f:Finding)=>void;limit?:number;showCategory?:boolean}){
  const shown=limit?items.slice(0,limit):items;
  if(!shown.length)return <p className="muted small empty-note">확인이 필요한 항목이 없습니다.</p>;
  return <ul className="finding-list">{shown.map(f=>{const {label,icon:Icon}=META[f.severity];return <li key={f.id}><button disabled={!f.target} onClick={()=>onOpen(f)}><span className={`sev sev-${f.severity}`}><Icon size={13}/>{label}</span><span className="finding-text"><strong>{f.title}</strong><small>{f.detail}</small></span>{showCategory&&<span className="finding-cat">{CATEGORY[f.category]}</span>}{f.target&&<ChevronRight size={14} className="finding-go"/>}</button></li>})}</ul>;
}
