import {useState,useEffect} from 'react';
import {ArrowUpRight,Copy,Check,ShieldCheck,Activity,Info,Link2,X,Route,Unplug,AlertTriangle,CircleOff,CircleHelp,ArrowDown} from 'lucide-react';
import type {Resource,Snapshot} from '../shared/schema';
import {health} from '../shared/topology';
import {kindNames,ProviderMark,ResourceIcon} from './graph';
import {providerNames,scopeNouns,type Bundle} from './layout';
type Common={snapshot:Snapshot;onSelect:(id:string)=>void;onClose:()=>void};
const scopeName=(s:Snapshot,id:string)=>s.scopeLabels[id]??id;
const statusClass:Record<string,string>={ok:'',stopped:'neutral',warn:'red',unknown:'amber',neutral:'neutral'};
export function EdgeDetail({bundle,snapshot,onSelect,onClose}:Common&{bundle:Bundle}){
  const find=(id:string)=>snapshot.resources.find(r=>r.id===id);
  return <aside className="inspector"><div className="inspector-head"><span>연결 상세</span><button className="icon-button" onClick={onClose} aria-label="상세 닫기"><X size={16}/></button></div>
    <div className="hero"><div className="large-icon"><Link2 size={20}/></div><h2>{bundle.label}</h2><p className="muted small">접힌 자원 사이의 관계는 한 선으로 묶입니다. 관계 {bundle.links.length}개가 이 선에 포함됩니다.</p></div>
    <div className="inspector-body">{bundle.links.map(link=>{const from=find(link.source),to=find(link.target);return <div className="rule-card" key={link.id}>
      <div className="rule-top"><span className={`badge ${link.kind==='simulation'?'amber':''}`}>{link.kind==='simulation'?'시뮬레이션':link.kind==='policy'?'정책 적용':link.kind==='peering'?'피어링':'구성 관계'}</span><b>{link.label}</b></div>
      <button className="hop-link" onClick={()=>onSelect(link.source)}>{from?.name}<ArrowUpRight size={12}/></button><ArrowDown size={12} className="hop-arrow"/><button className="hop-link" onClick={()=>onSelect(link.target)}>{to?.name}<ArrowUpRight size={12}/></button>
      {link.ports&&<p className="small muted">{link.protocol} / {link.ports}{link.rate?` · 예제 ${link.rate}`:''}</p>}
      <p className="small evidence">근거: {link.evidence}</p></div>})}
      <div className="notice"><Info size={15}/><p>구성 관계는 통신 성공을 보장하지 않습니다. 실제 통신은 경로 분석과 로그로 확인해야 합니다.</p></div></div></aside>;
}
export function ResourceDetail({resource:r,snapshot,onSelect,onClose,onTrace,onImpact,canImpact,scopePath,onOpenScope}:Common&{resource:Resource;onTrace:(id:string)=>void;onImpact:(id:string)=>void;canImpact:boolean;scopePath:{id:string;name:string}[];onOpenScope:(id:string)=>void}){
  const [tab,setTab]=useState('overview'),[copied,setCopied]=useState(false);useEffect(()=>{setTab('overview');setCopied(false)},[r.id]);
  const related=snapshot.links.filter(e=>e.source===r.id||e.target===r.id);
  const ancestry=new Set([r.id]);for(let p=r.parent;p;p=snapshot.resources.find(x=>x.id===p)?.parent)ancestry.add(p);
  const appliedPolicies=snapshot.links.filter(e=>e.kind==='policy'&&ancestry.has(e.target)).map(e=>snapshot.resources.find(x=>x.id===e.source)!);
  const policies=[...new Map(appliedPolicies.map(p=>[p.id,p])).values()];
  const copy=async()=>{try{await navigator.clipboard.writeText(r.nativeId);setCopied(true)}catch{setCopied(false)}};
  return <aside className="inspector"><div className="inspector-head"><span>리소스 상세</span><button className="icon-button" onClick={onClose} aria-label="상세 닫기"><X size={16}/></button></div>
    <div className="hero"><div className="large-icon plain"><ResourceIcon resource={r} size={38}/></div><div className="caption">{providerNames[r.provider]} · {kindNames[r.kind]}</div><h2>{r.name}</h2><div className="hero-badges"><span className={`badge ${statusClass[health(r.status)]}`}>{r.status}</span><span className="badge neutral">{r.region}</span></div>
      {!!scopePath.length&&<nav className="scope-path" aria-label="소유 범위">{scopePath.map((n,i)=><span key={n.id}>{i>0&&<i>/</i>}<button onClick={()=>onOpenScope(n.id)}>{n.name}</button></span>)}</nav>}
      {r.kind!=='firewall'&&r.kind!=='external'&&r.provider!=='onprem'&&<div className="hero-actions"><button className="button" onClick={()=>onTrace(r.id)}><Route size={14}/>경로 추적</button>{canImpact&&<button className="button" onClick={()=>onImpact(r.id)}><Unplug size={14}/>단절 영향</button>}</div>}</div>
    <div className="tabs" role="tablist" aria-label="리소스 상세">{[['overview','개요'],['network',`네트워크${policies.length+r.rules.length?` ${policies.length+(r.rules.length?1:0)}`:''}`],['access','접근 권한']].map(([k,l])=><button key={k} role="tab" aria-selected={tab===k} onClick={()=>setTab(k)}>{l}</button>)}</div>
    <div className="inspector-body" role="tabpanel">
    {tab==='overview'&&<><h3>구성</h3><dl className="properties">{Object.entries(r.specs).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}{r.ip&&<div><dt>Private IP</dt><dd className="mono">{r.ip}</dd></div>}{r.cidr&&<div><dt>CIDR</dt><dd className="mono">{r.cidr}</dd></div>}{r.group&&<div><dt>{r.provider==='azure'?'리소스 그룹':'위치'}</dt><dd>{r.group}</dd></div>}</dl>
      {r.metrics&&<div className="metrics"><div className="section-row"><h3><Activity size={13}/>사용률</h3><span className="demo-label">예제값</span></div><div className="metric-values"><div><small>CPU</small><strong>{r.metrics.cpu}<em>%</em></strong></div><div><small>메모리</small><strong>{r.metrics.memory}<em>%</em></strong></div></div><svg className="sparkline" viewBox="0 0 260 55" aria-label="시뮬레이션 CPU 추이" role="img"><polyline points={r.metrics.history.map((v,i)=>`${i*23.5},${55-v*.5}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2"/></svg></div>}
      {!!Object.keys(r.tags).length&&<><h3>태그</h3><div className="tags">{Object.entries(r.tags).map(([k,v])=><span key={k}>{k}<b>{v}</b></span>)}</div></>}
      <h3>수집 출처</h3><p className="small">{r.source}</p><button className="id-copy" onClick={copy} title={r.nativeId}><span>{r.nativeId}</span>{copied?<Check size={13}/>:<Copy size={13}/>}</button></>}
    {tab==='network'&&<>{r.rules.length>0&&<><h3>이 정책의 규칙 <span className="count">{r.rules.length}</span></h3>{r.rules.map((rule,i)=><RuleCard rule={rule} key={i}/>)}</>}
      {r.kind!=='firewall'&&<><h3>적용 정책 <span className="count">{policies.length}</span></h3>{policies.length?policies.map(p=><div className="policy-group" key={p.id}><button className="relation-row" onClick={()=>onSelect(p.id)}><ShieldCheck size={14}/><span>{p.name}<small>{p.parent&&ancestry.has(p.parent)?'상위 범위':'직접/서브넷 적용'} · 규칙 {p.rules.length}개</small></span><ArrowUpRight size={13}/></button>{p.rules.slice(0,3).map((rule,i)=><RuleCard rule={rule} key={i}/>)}</div>):<p className="muted small">구성 참조로 연결된 정책이 없습니다. 전체 유효 정책을 평가한 결과는 아닙니다.</p>}</>}
      <h3>연결 관계 <span className="count">{related.length}</span></h3>{related.map(e=>{const other=snapshot.resources.find(x=>x.id===(e.source===r.id?e.target:e.source));return <button className="relation-row" key={e.id} onClick={()=>other&&onSelect(other.id)}><Link2 size={14}/><span>{other?.name}<small>{e.label}{e.kind==='simulation'?' · 시뮬레이션':''}</small></span><ArrowUpRight size={13}/></button>})}
      <div className="notice"><Info size={15}/><p>정책 허용은 실제 도달 가능 여부와 다릅니다. 라우팅·NAT·반환 경로는 별도 검증이 필요합니다.</p></div></>}
    {tab==='access'&&<><h3><ShieldCheck size={14}/>역할 할당</h3>{r.iam.length?r.iam.map((a,i)=><div key={i} className="rule-card"><span className="demo-label">예제 할당</span><h4>{a.principal}</h4><p className="small">{a.role}</p><small className="muted">{scopeName(snapshot,a.scope)}</small></div>):<p className="muted small">IAM 데이터는 이번 수집 범위에 포함되지 않습니다.</p>}<div className="notice"><Info size={15}/><p>실제 IAM API 연동 전입니다. 상속·조건·거부 정책을 반영한 실효 권한이 아닙니다.</p></div></>}
    </div></aside>;
}
function RuleCard({rule}:{rule:Resource['rules'][number]}){
  const open=rule.action==='Allow'&&/0\.0\.0\.0\/0|Internet|^\*$/.test(rule.source)&&/inbound|ingress/i.test(rule.direction);
  return <div className={`rule-card ${open?'is-open':''}`}><div className="rule-top"><span className={`badge ${rule.action==='Deny'?'red':''}`}>{rule.action}</span><b>{rule.protocol} / {rule.ports}</b></div><dl><dt>방향 · 우선순위</dt><dd>{rule.direction} · {rule.priority}</dd><dt>출발지</dt><dd>{rule.source}</dd><dt>목적지</dt><dd>{rule.destination}</dd></dl>{open&&<p className="small rule-warn"><AlertTriangle size={12}/>넓은 출발지 허용 규칙입니다. 실제 노출 여부는 경로 확인이 필요합니다.</p>}</div>;
}
export function Attention({snapshot,onSelect}:{snapshot:Snapshot;onSelect:(id:string)=>void}){
  const order=['warn','unknown','stopped'],attention=snapshot.resources.filter(r=>r.kind!=='firewall'&&order.includes(health(r.status))).sort((a,b)=>order.indexOf(health(a.status))-order.indexOf(health(b.status)));
  const open=snapshot.resources.filter(r=>r.rules.some(x=>x.action==='Allow'&&/0\.0\.0\.0\/0|Internet/.test(x.source)&&/inbound|ingress/i.test(x.direction)));
  const icon={warn:AlertTriangle,stopped:CircleOff,unknown:CircleHelp} as Record<string,typeof Info>;
  return <><h2>확인 필요 <span className="count">{attention.length}</span></h2>{!attention.length&&<p className="muted small">중지되었거나 이상 상태인 자원이 없습니다.</p>}
    {attention.map(r=>{const Icon=icon[health(r.status)];return <button key={r.id} className={`relation-row h-${health(r.status)}`} onClick={()=>onSelect(r.id)}><Icon size={15}/><span>{r.name}<small>{r.status}{r.scope!=='external'?` · ${scopeName(snapshot,r.scope)}`:''}</small></span><ArrowUpRight size={13}/></button>})}
    {open.length>0&&<><h2>넓은 인바운드 허용 <span className="count">{open.length}</span></h2>{open.map(r=><button key={r.id} className="relation-row" onClick={()=>onSelect(r.id)}><ShieldCheck size={15}/><span>{r.name}<small>{scopeName(snapshot,r.scope)} · 실제 노출은 경로 확인 필요</small></span><ArrowUpRight size={13}/></button>)}</>}
    {!!snapshot.warnings.length&&<details className="warnings"><summary>수집 범위 메모 {snapshot.warnings.length}건</summary>{snapshot.warnings.map((w,i)=><p key={i}>{w}</p>)}</details>}</>;
}
export function PathPanel({snapshot,from,to,path,onChange,onSelect,onClose}:{snapshot:Snapshot;from:string;to:string;path:string[];onChange:(from:string,to:string)=>void;onSelect:(id:string)=>void;onClose:()=>void}){
  const options=snapshot.resources.filter(r=>r.kind!=='firewall'&&r.kind!=='subnet'&&r.scope!=='external').sort((a,b)=>a.provider.localeCompare(b.provider)||a.name.localeCompare(b.name));
  const groups=['onprem','azure','aws','gcp'].map(p=><optgroup key={p} label={providerNames[p]}>{options.filter(o=>o.provider===p).map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>);
  const hops=path.map(id=>snapshot.resources.find(r=>r.id===id)!);
  const policiesAt=(r:Resource)=>[...new Set(snapshot.links.filter(l=>l.kind==='policy'&&l.target===r.id).map(l=>snapshot.resources.find(x=>x.id===l.source)?.name))];
  return <aside className="inspector"><div className="inspector-head"><span>경로 추적</span><button className="icon-button" onClick={onClose} aria-label="경로 추적 닫기"><X size={16}/></button></div><div className="inspector-body">
    <label className="field">출발<select value={from} onChange={e=>onChange(e.target.value,to)}>{groups}</select></label>
    <label className="field">목적지<select value={to} onChange={e=>onChange(from,e.target.value)}>{groups}</select></label>
    {hops.length?<><h3>구성상 경로 <span className="count">{hops.length} 홉</span></h3><ol className="hops">{hops.map(r=>{const applied=policiesAt(r);return <li key={r.id} className={r.provider}><button onClick={()=>onSelect(r.id)}><span className="hop-icon"><ResourceIcon resource={r} size={24}/></span><span>{r.name}<small>{kindNames[r.kind]}{scopeNouns[r.provider]?` · ${scopeName(snapshot,r.scope)}`:''}{r.ip?` · ${r.ip}`:r.cidr?` · ${r.cidr}`:''}</small>{applied.map(p=><small className="hop-policy" key={p}><ShieldCheck size={10}/>{p}</small>)}</span></button></li>})}</ol></>:<div className="notice warn"><AlertTriangle size={15}/><p>수집한 구성에서 두 자원을 잇는 경로를 찾지 못했습니다. 미수집 구간이 있을 수 있습니다.</p></div>}
    <div className="notice"><Info size={15}/><p>구성 참조를 이은 후보 경로입니다. 라우팅 표, 피어링의 비전이성, 방화벽 판정, 실제 패킷은 확인하지 않았습니다.</p></div></div></aside>;
}
export function ImpactPanel({snapshot,id,lost,onSelect,onClose}:{snapshot:Snapshot;id:string;lost:string[];onSelect:(id:string)=>void;onClose:()=>void}){
  const r=snapshot.resources.find(x=>x.id===id)!,items=lost.map(l=>snapshot.resources.find(x=>x.id===l)!).filter(x=>x.kind!=='subnet');
  return <aside className="inspector"><div className="inspector-head"><span>단절 영향</span><button className="icon-button" onClick={onClose} aria-label="단절 영향 닫기"><X size={16}/></button></div><div className="hero"><div className="large-icon impact"><Unplug size={20}/></div><h2>{r.name}</h2><p className="muted small">이 자원이 사라지면 사내망까지 이어지는 구성 경로가 모두 끊기는 자원입니다.</p></div><div className="inspector-body"><h3>영향 가능 자원 <span className="count">{items.length}</span></h3>{items.length?items.map(x=><button key={x.id} className="relation-row" onClick={()=>onSelect(x.id)}><ResourceIcon resource={x} size={22}/><span>{x.name}<small>{kindNames[x.kind]} · {scopeName(snapshot,x.scope)}</small></span><ArrowUpRight size={13}/></button>):<p className="muted small">수집한 구성에서는 다른 경로가 남아 있거나 사내망에 의존하는 자원이 없습니다.</p>}<div className="notice"><Info size={15}/><p>구성 그래프로 계산한 가능성입니다. 피어링의 비전이성과 라우팅 표는 반영하지 않아, 실제 영향은 이보다 클 수 있습니다.</p></div></div></aside>;
}
