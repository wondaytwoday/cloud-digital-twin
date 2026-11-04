import {useMemo,useState} from 'react';
import {Info,KeyRound,Search,Shield,User,Users,X,Bot,Globe2} from 'lucide-react';
import type {IamAssignment,Snapshot} from '../../shared/schema';
import type {Finding} from '../../shared/findings';
import {iamInScope,type Focus} from '../../shared/hierarchy';
import {ProviderMark} from '../graph';
import {Kpi} from '../charts';
import {FindingList} from './Findings';
const TYPES:Record<IamAssignment['principalType'],{label:string;icon:typeof User}>={user:{label:'사용자',icon:User},group:{label:'그룹',icon:Users},serviceAccount:{label:'서비스 계정',icon:Bot},role:{label:'역할',icon:Shield},public:{label:'공개',icon:Globe2},unknown:{label:'미확인',icon:Shield}};
const LEVELS:Record<IamAssignment['level'],string>={org:'조직',group:'그룹',scope:'범위',resource:'자원'};
type Principal={key:string;provider:string;name:string;type:IamAssignment['principalType'];items:IamAssignment[];privileged:boolean;external:boolean;noMfa:boolean;oldKey:number|null};
export function IamPage({snapshot,focus,list,openFinding}:{snapshot:Snapshot;focus:Focus;list:Finding[];openFinding:(f:Finding)=>void}){
  const [type,setType]=useState('all'),[query,setQuery]=useState(''),[only,setOnly]=useState<'all'|'privileged'|'external'>('all'),[open,setOpen]=useState<string|null>(null);
  const label=(s:string)=>snapshot.scopeLabels[s]??s;
  const principals=useMemo(()=>{const m=new Map<string,Principal>();for(const a of snapshot.iam.filter(x=>iamInScope(focus,x))){const key=`${a.provider}|${a.principalType}|${a.principal}`,p=m.get(key)??{key,provider:a.provider,name:a.principal,type:a.principalType,items:[],privileged:false,external:false,noMfa:false,oldKey:null};p.items.push(a);p.privileged||=a.privileged;p.external||=a.external;p.noMfa||=a.privileged&&a.mfa===false;if(a.keyAgeDays!==undefined)p.oldKey=Math.max(p.oldKey??0,a.keyAgeDays);m.set(key,p);}return [...m.values()].sort((a,b)=>Number(b.external)-Number(a.external)||Number(b.noMfa)-Number(a.noMfa)||Number(b.privileged)-Number(a.privileged)||b.items.length-a.items.length);},[snapshot,focus]);
  const q=query.trim().toLowerCase();
  const shown=principals.filter(p=>(type==='all'||p.type===type)&&(only==='all'||(only==='privileged'?p.privileged:p.external))&&(!q||`${p.name} ${p.items.map(i=>i.role).join(' ')}`.toLowerCase().includes(q)));
  const iamFindings=list.filter(f=>f.category==='iam'),selected=principals.find(p=>p.key===open);
  return <div className={`page ${selected?'with-drawer':''}`}><header className="page-head"><div><h1>IAM</h1><p>{snapshot.mode==='mock'?'예시 데이터입니다. ':''}역할 할당을 CSP별로 모아 봅니다.{focus.scopes?' 상위 조직과 관리 그룹에서 내려오는 할당도 포함합니다.':''}</p></div></header>
    <section className="kpi-row" aria-label="IAM 지표">
      <Kpi label="주체" value={String(principals.length)} hint={`할당 ${principals.reduce((n,p)=>n+p.items.length,0)}건`}/>
      <Kpi label="특권 주체" value={String(principals.filter(p=>p.privileged).length)} hint="Owner, 관리자 등" onClick={()=>setOnly('privileged')}/>
      <Kpi label="외부 주체" value={String(principals.filter(p=>p.external).length)} hint="외부 계정, 도메인" tone={principals.some(p=>p.external)?'bad':undefined} onClick={()=>setOnly('external')}/>
      <Kpi label="MFA 없는 특권 사용자" value={String(principals.filter(p=>p.noMfa).length)} hint="AWS IAM 사용자 기준" tone={principals.some(p=>p.noMfa)?'bad':undefined}/>
      <Kpi label="90일 넘은 키" value={String(principals.filter(p=>(p.oldKey??0)>90).length)} hint="활성 액세스 키" tone={principals.some(p=>(p.oldKey??0)>90)?'warn':undefined}/>
    </section>
    <div className="dash-grid">
      <section className="panel span-2"><header className="panel-head wrap"><h2>주체 <span className="count">{shown.length}</span></h2><div className="table-tools"><label className="mini-search"><Search size={14}/><input aria-label="주체와 역할 검색" placeholder="주체, 역할 찾기" value={query} onChange={e=>setQuery(e.target.value)}/></label><label className="inline-field">유형<select value={type} onChange={e=>setType(e.target.value)}><option value="all">전체</option>{Object.entries(TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></label><label className="inline-field">조건<select value={only} onChange={e=>setOnly(e.target.value as typeof only)}><option value="all">전체</option><option value="privileged">특권만</option><option value="external">외부만</option></select></label></div></header>
        <div className="table-wrap"><table className="data-table clickable"><thead><tr><th>주체</th><th>클라우드</th><th>유형</th><th className="num">할당</th><th>표시</th></tr></thead><tbody>{shown.slice(0,100).map(p=>{const Icon=TYPES[p.type].icon;return <tr key={p.key} className={open===p.key?'is-selected':''}><td><button onClick={()=>setOpen(p.key)}><Icon size={14}/>{p.name}</button></td><td><ProviderMark provider={p.provider}/></td><td>{TYPES[p.type].label}</td><td className="num">{p.items.length}</td><td className="flags">{p.external&&<span className="badge red">외부</span>}{p.privileged&&<span className="badge amber">특권</span>}{p.noMfa&&<span className="badge red">MFA 없음</span>}{(p.oldKey??0)>90&&<span className="badge amber"><KeyRound size={10}/>{p.oldKey}일</span>}</td></tr>})}</tbody></table>{!shown.length&&<p className="muted small empty-note">조건에 맞는 주체가 없습니다.</p>}{shown.length>100&&<p className="more-note">처음 100개만 표시합니다. 검색으로 좁혀 보세요.</p>}</div></section>
      <section className="panel"><header className="panel-head"><h2>확인 필요 <span className="count">{iamFindings.length}</span></h2></header><FindingList items={iamFindings} onOpen={f=>{const a=snapshot.iam.find(x=>f.id.endsWith(x.id));if(a)setOpen(`${a.provider}|${a.principalType}|${a.principal}`);else openFinding(f);}} limit={12} showCategory={false}/></section>
      <p className="source-note span-3"><Info size={13}/>역할 할당 목록이며 실효 권한이 아닙니다. 상속, 조건, 거부 정책, SCP, PIM 활성 상태는 평가하지 않습니다.</p>
    </div>
    {selected&&<aside className="drawer" aria-label={`${selected.name} 할당`}><div className="inspector-head"><span>주체 상세</span><button className="icon-button" onClick={()=>setOpen(null)} aria-label="주체 상세 닫기"><X size={16}/></button></div><div className="inspector-body"><h2 className="drawer-title">{selected.name}</h2><p className="muted small">{TYPES[selected.type].label}{selected.oldKey!==null?` · 활성 키 ${selected.oldKey}일`:''}{selected.items[0].mfa!==undefined?` · MFA ${selected.items[0].mfa?'있음':'없음'}`:''}</p><h3>역할 할당 <span className="count">{selected.items.length}</span></h3>{selected.items.map(a=><div className={`rule-card ${a.external||a.privileged?'is-open':''}`} key={a.id}><div className="rule-top"><b>{a.role}</b>{a.privileged&&<span className="badge amber">특권</span>}</div><dl><dt>범위</dt><dd>{label(a.scope)} ({LEVELS[a.level]})</dd><dt>근거</dt><dd>{a.source}</dd></dl></div>)}</div></aside>}
  </div>;
}
