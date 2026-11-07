import {useState,useEffect,useRef,useMemo} from 'react';
import {ArrowUpRight,Copy,Check,ShieldCheck,Activity,Info,Link2,X,Route,Unplug,AlertTriangle,CircleOff,CircleHelp,ArrowDown,Globe2,Plus,Minus,PenLine,MousePointerClick} from 'lucide-react';
import type {Resource,Snapshot} from '../shared/schema';
import {exposures,health,isWideInbound} from '../shared/topology';
import {kindNames,ProviderMark,ResourceIcon} from './graph';
import {DEFAULT_OWNERSHIP_KEYS,ownershipOf} from '../shared/ownership';
import {BASIS_LABEL,LINK_LABEL,basisOf} from '../shared/relations';
import {providerNames,scopeNouns,type Bundle} from './layout';
type Common={snapshot:Snapshot;onSelect:(id:string)=>void;onClose:()=>void};
const scopeName=(s:Snapshot,id:string)=>s.scopeLabels[id]??id;
const statusClass:Record<string,string>={ok:'',stopped:'neutral',warn:'red',unknown:'amber',neutral:'neutral'};
export function EdgeDetail({bundle,snapshot,onSelect,onClose}:Common&{bundle:Bundle}){
  const find=(id:string)=>snapshot.resources.find(r=>r.id===id);
  return <aside className="inspector"><div className="inspector-head"><span>연결 상세</span><button className="icon-button" onClick={onClose} aria-label="상세 닫기"><X size={16}/></button></div>
    <div className="hero"><div className="large-icon"><Link2 size={20}/></div><h2>{bundle.label}</h2><p className="muted small">접힌 자원 사이의 관계는 한 선으로 묶입니다. 관계 {bundle.links.length}개가 이 선에 포함됩니다.</p></div>
    <div className="inspector-body">{bundle.links.map(link=>{const from=find(link.source),to=find(link.target);return <div className="rule-card" key={link.id}>
      <div className="rule-top"><span className={`badge ${link.kind==='simulation'?'amber':''}`}>{LINK_LABEL[link.kind]}</span><span className={`badge ${link.basis==='inferred'||link.basis==='declared'?'amber':'neutral'}`} title="이 관계의 근거">{basisOf(link)}</span><b>{link.label}</b></div>
      <button className="hop-link" onClick={()=>onSelect(link.source)}>{from?.name}<ArrowUpRight size={12}/></button><ArrowDown size={12} className="hop-arrow"/><button className="hop-link" onClick={()=>onSelect(link.target)}>{to?.name}<ArrowUpRight size={12}/></button>
      {link.ports&&<p className="small muted">{link.protocol} / {link.ports}{link.rate?` · 예제 ${link.rate}`:''}</p>}
      <p className="small evidence">근거: {link.evidence}</p>{link.ref&&<p className="small mono muted" title="원본 참조">{link.ref}</p>}{link.note&&<p className="small">{link.note}</p>}
      <p className="small muted">수집 {(()=>{const p=from?.provider==='onprem'?to?.provider:from?.provider,at=snapshot.connections.find(c=>c.provider===p)?.collectedAt;return at?new Date(at).toLocaleString('ko-KR'):snapshot.mode==='mock'?'예시 데이터':'시각 미상';})()}{link.basis==='inferred'?' · Atlas가 구성에서 추론':link.basis==='declared'?' · 운영자가 수동 등록':''}</p></div>})}
      <div className="notice"><Info size={15}/><p>구성 관계는 통신 가능 여부를 말하지 않습니다. 통신 여부는 경로·정책 분석으로 판정하며, 관측 통신은 연동되지 않았습니다. 근거 구분: {Object.values(BASIS_LABEL).join(' / ')}.</p></div></div></aside>;
}
export function ResourceDetail({resource:r,snapshot,onSelect,onClose,onTrace,onImpact,canImpact,scopePath,onOpenScope}:Common&{resource:Resource;onTrace:(id:string)=>void;onImpact:(id:string)=>void;canImpact:boolean;scopePath:{id:string;name:string}[];onOpenScope:(id:string)=>void}){
  const [tab,setTab]=useState('overview'),[copied,setCopied]=useState(false);useEffect(()=>{setTab('overview');setCopied(false)},[r.id]);
  const related=snapshot.links.filter(e=>e.source===r.id||e.target===r.id);
  const ancestry=new Set([r.id]);for(let p=r.parent;p;p=snapshot.resources.find(x=>x.id===p)?.parent)ancestry.add(p);
  // A VM's policies sit on its NICs (Azure NIC NSG, AWS ENI security groups), so those count as its own.
  for(const l of snapshot.links)if(l.kind==='attachment'&&l.source===r.id&&snapshot.resources.find(x=>x.id===l.target)?.kind==='nic')ancestry.add(l.target);
  const appliedPolicies=snapshot.links.filter(e=>e.kind==='policy'&&ancestry.has(e.target)).map(e=>snapshot.resources.find(x=>x.id===e.source)!);
  const policies=[...new Map(appliedPolicies.map(p=>[p.id,p])).values()];
  const access=snapshot.iam.filter(a=>a.scope===r.scope);
  const change=snapshot.changes?.items.find(c=>c.id===r.id);
  const routes=[r,...[...ancestry].map(id=>snapshot.resources.find(x=>x.id===id)).filter((x):x is Resource=>!!x)].find(x=>x.routes.length)?.routes??[];
  const copy=async()=>{try{await navigator.clipboard.writeText(r.nativeId);setCopied(true)}catch{setCopied(false)}};
  return <aside className="inspector"><div className="inspector-head"><span>리소스 상세</span><button className="icon-button" onClick={onClose} aria-label="상세 닫기"><X size={16}/></button></div>
    <div className="hero"><div className="large-icon plain"><ResourceIcon resource={r} size={38}/></div><div className="caption">{providerNames[r.provider]} · {kindNames[r.kind]}</div><h2>{r.name}</h2><div className="hero-badges"><span className={`badge ${statusClass[health(r.status)]}`}>{r.status}</span><span className="badge neutral">{r.region}</span></div>
      {!!scopePath.length&&<nav className="scope-path" aria-label="소유 범위">{scopePath.map((n,i)=><span key={n.id}>{i>0&&<i>/</i>}<button onClick={()=>onOpenScope(n.id)}>{n.name}</button></span>)}</nav>}
      {r.kind!=='firewall'&&r.kind!=='external'&&r.provider!=='onprem'&&<div className="hero-actions"><button className="button" onClick={()=>onTrace(r.id)}><Route size={14}/>경로 추적</button>{canImpact&&<button className="button" onClick={()=>onImpact(r.id)}><Unplug size={14}/>단절 영향</button>}</div>}</div>
    <div className="tabs" role="tablist" aria-label="리소스 상세">{[['overview','개요'],['network',`네트워크${policies.length+r.rules.length?` ${policies.length+(r.rules.length?1:0)}`:''}`],['access','접근 권한']].map(([k,l])=><button key={k} role="tab" aria-selected={tab===k} onClick={()=>setTab(k)}>{l}</button>)}</div>
    <div className="inspector-body" role="tabpanel">
    {tab==='overview'&&<>{change&&<div className={`notice change-${change.kind}`}><Info size={15}/><p>최근 수집에서 변경됨: {change.detail}</p></div>}<Ownership snapshot={snapshot} resource={r}/><h3>구성</h3><dl className="properties">{Object.entries(r.specs).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}{r.ip&&<div><dt>사설 IP</dt><dd className="mono">{r.ip}</dd></div>}{r.publicIp&&<div><dt>공인 IP</dt><dd className="mono">{r.publicIp}</dd></div>}{r.cidr&&<div><dt>CIDR</dt><dd className="mono">{r.cidr}</dd></div>}{r.group&&<div><dt>{r.provider==='azure'?'리소스 그룹':'위치'}</dt><dd>{r.group}</dd></div>}</dl>
      {r.metrics&&<div className="metrics"><div className="section-row"><h3><Activity size={13}/>사용률</h3><span className="demo-label">예제값</span></div><div className="metric-values"><div><small>CPU</small><strong>{r.metrics.cpu}<em>%</em></strong></div><div><small>메모리</small><strong>{r.metrics.memory}<em>%</em></strong></div></div><svg className="sparkline" viewBox="0 0 260 55" aria-label="시뮬레이션 CPU 추이" role="img"><polyline points={r.metrics.history.map((v,i)=>`${i*23.5},${55-v*.5}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2"/></svg></div>}
      {!!Object.keys(r.tags).length&&<><h3>태그</h3><div className="tags">{Object.entries(r.tags).map(([k,v])=><span key={k}>{k}<b>{v}</b></span>)}</div></>}
      <h3>수집 출처</h3><p className="small">{r.source}</p><button className="id-copy" onClick={copy} title={r.nativeId}><span>{r.nativeId}</span>{copied?<Check size={13}/>:<Copy size={13}/>}</button></>}
    {tab==='network'&&<>{r.rules.length>0&&<><h3>이 정책의 규칙 <span className="count">{r.rules.length}</span></h3>{r.rules.map((rule,i)=><RuleCard rule={rule} key={i}/>)}</>}
      {r.kind!=='firewall'&&<><h3>적용 정책 <span className="count">{policies.length}</span></h3>{policies.length?policies.map(p=><div className="policy-group" key={p.id}><button className="relation-row" onClick={()=>onSelect(p.id)}><ShieldCheck size={14}/><span>{p.name}<small>{p.parent&&ancestry.has(p.parent)?'상위 범위':'직접/서브넷 적용'} · 규칙 {p.rules.length}개</small></span><ArrowUpRight size={13}/></button>{p.rules.slice(0,3).map((rule,i)=><RuleCard rule={rule} key={i}/>)}</div>):<p className="muted small">구성 참조로 연결된 정책이 없습니다. 전체 유효 정책을 평가한 결과는 아닙니다.</p>}</>}
      {!!routes.length&&<><h3>라우팅 <span className="count">{routes.length}</span></h3><table className="routes"><thead><tr><th>목적지</th><th>다음 홉</th></tr></thead><tbody>{routes.map((x,i)=><tr key={i}><td className="mono">{x.destination}</td><td>{x.nextHop}<small>{x.via}</small></td></tr>)}</tbody></table></>}
      <h3>연결 관계 <span className="count">{related.length}</span></h3>{related.map(e=>{const other=snapshot.resources.find(x=>x.id===(e.source===r.id?e.target:e.source));return <button className="relation-row" key={e.id} onClick={()=>other&&onSelect(other.id)}><Link2 size={14}/><span>{other?.name}<small>{LINK_LABEL[e.kind]} · {e.label} · {basisOf(e)}</small></span><ArrowUpRight size={13}/></button>})}
      <div className="notice"><Info size={15}/><p>정책 허용은 실제 도달 가능 여부와 다릅니다. 라우팅·NAT·반환 경로는 별도 검증이 필요합니다.</p></div></>}
    {tab==='access'&&<><h3><ShieldCheck size={14}/>이 범위의 역할 할당 <span className="count">{access.length}</span></h3>{access.length?access.slice(0,20).map(a=><div key={a.id} className="rule-card"><div className="rule-top"><b>{a.role}</b>{a.privileged&&<span className="badge amber">특권</span>}{snapshot.mode==='mock'&&<span className="demo-label">예제</span>}</div><h4>{a.principal}</h4><small className="muted">{scopeName(snapshot,a.scope)}</small></div>):<p className="muted small">수집된 역할 할당이 없습니다.</p>}<div className="notice"><Info size={15}/><p>역할 할당 목록이며 상속, 조건, 거부 정책을 반영한 실효 권한이 아닙니다.</p></div></>}
    </div></aside>;
}
function RuleCard({rule}:{rule:Resource['rules'][number]}){
  const open=isWideInbound(rule);
  return <div className={`rule-card ${open?'is-open':''}`}><div className="rule-top"><span className={`badge ${rule.action==='Deny'?'red':''}`}>{rule.action}</span><b>{rule.protocol} / {rule.ports}</b></div><dl><dt>방향 · 우선순위</dt><dd>{rule.direction} · {rule.priority}</dd><dt>출발지</dt><dd>{rule.source}</dd><dt>목적지</dt><dd>{rule.destination}</dd></dl>{open&&<p className="small rule-warn"><AlertTriangle size={12}/>넓은 출발지 허용 규칙입니다. 실제 노출 여부는 경로 확인이 필요합니다.</p>}</div>;
}
export function Attention({snapshot,onSelect}:{snapshot:Snapshot;onSelect:(id:string)=>void}){
  const order=['warn','unknown','stopped'],attention=snapshot.resources.filter(r=>r.kind!=='firewall'&&order.includes(health(r.status))).sort((a,b)=>order.indexOf(health(a.status))-order.indexOf(health(b.status)));
  const exposed=exposures(snapshot.resources,snapshot.links),wide=snapshot.resources.filter(r=>r.rules.some(isWideInbound));
  const icon={warn:AlertTriangle,stopped:CircleOff,unknown:CircleHelp} as Record<string,typeof Info>,changeIcon={added:Plus,removed:Minus,changed:PenLine};
  const changes=snapshot.changes?.items??[],known=new Set(snapshot.resources.map(r=>r.id));
  return <>{exposed.length>0&&<><h2>공인 IP + 넓은 허용 <span className="count warn">{exposed.length}</span></h2>{exposed.map(e=><button key={e.resource.id} className="relation-row h-warn" onClick={()=>onSelect(e.resource.id)}><Globe2 size={15}/><span>{e.resource.name}<small>{e.rules[0].policy} · {e.rules[0].rule.protocol}/{e.rules[0].rule.ports} · 노출 후보</small></span><ArrowUpRight size={13}/></button>)}</>}
    <h2>확인 필요 <span className="count">{attention.length}</span></h2>{!attention.length&&<p className="muted small">중지되었거나 이상 상태인 자원이 없습니다.</p>}
    {attention.map(r=>{const Icon=icon[health(r.status)];return <button key={r.id} className={`relation-row h-${health(r.status)}`} onClick={()=>onSelect(r.id)}><Icon size={15}/><span>{r.name}<small>{r.status}{r.scope!=='external'?` · ${scopeName(snapshot,r.scope)}`:''}</small></span><ArrowUpRight size={13}/></button>})}
    {changes.length>0&&<><h2>최근 변경 <span className="count">{changes.length}</span></h2><p className="rail-since">{new Date(snapshot.changes!.since).toLocaleString('ko-KR')} 이후{snapshot.mode==='mock'?' · 예제':''}</p>{changes.map(c=>{const Icon=changeIcon[c.kind],exists=known.has(c.id);return <button key={c.id+c.kind} className={`relation-row change-${c.kind}`} disabled={!exists} onClick={()=>onSelect(c.id)}><Icon size={15}/><span>{c.name}<small>{c.detail}</small></span>{exists&&<ArrowUpRight size={13}/>}</button>})}</>}
    {wide.length>0&&<><h2>넓은 인바운드 규칙 <span className="count">{wide.length}</span></h2>{wide.map(r=><button key={r.id} className="relation-row" onClick={()=>onSelect(r.id)}><ShieldCheck size={15}/><span>{r.name}<small>{scopeName(snapshot,r.scope)}</small></span><ArrowUpRight size={13}/></button>)}</>}
    {!!snapshot.warnings.length&&<details className="warnings"><summary>수집 범위 메모 {snapshot.warnings.length}건</summary>{snapshot.warnings.map((w,i)=><p key={i}>{w}</p>)}</details>}</>;
}
export type Picking='from'|'to'|null;
export function ResourcePicker({label,value,options,onChange,picking,onPick}:{label:string;value:string;options:Resource[];onChange:(id:string)=>void;picking:boolean;onPick:()=>void}){
  const current=options.find(o=>o.id===value),[text,setText]=useState(''),[open,setOpen]=useState(false),[cursor,setCursor]=useState(0),root=useRef<HTMLDivElement>(null);
  const shown=useMemo(()=>{const q=text.trim().toLowerCase();return (q?options.filter(o=>`${o.name} ${o.ip??''}`.toLowerCase().includes(q)):options).slice(0,40);},[text,options]);
  useEffect(()=>{setCursor(0)},[text,open]);
  useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node)){setOpen(false);setText('');}};addEventListener('pointerdown',close);return()=>removeEventListener('pointerdown',close);},[open]);
  const choose=(id:string)=>{onChange(id);setOpen(false);setText('');};
  return <div className="field picker" ref={root}><label htmlFor={`pick-${label}`}>{label}</label><div className="picker-row"><input id={`pick-${label}`} role="combobox" aria-expanded={open} aria-autocomplete="list" autoComplete="off" value={open?text:current?.name??''} placeholder={current?.name??'자원 검색'} onFocus={()=>setOpen(true)} onChange={e=>{setText(e.target.value);setOpen(true)}} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setCursor(c=>Math.min(c+1,shown.length-1));}if(e.key==='ArrowUp'){e.preventDefault();setCursor(c=>Math.max(c-1,0));}if(e.key==='Enter'&&shown[cursor]){e.preventDefault();choose(shown[cursor].id);}if(e.key==='Escape'){setOpen(false);setText('');}}}/><button type="button" className={`icon-button ${picking?'is-on':''}`} aria-pressed={picking} onClick={onPick} aria-label={`${label}을(를) 지도에서 선택`} title="지도에서 선택"><MousePointerClick size={15}/></button></div>
    {open&&<ul className="picker-list" role="listbox">{shown.map((o,i)=><li key={o.id} role="option" aria-selected={o.id===value} className={i===cursor?'is-cursor':''} onPointerDown={e=>{e.preventDefault();choose(o.id)}}><ResourceIcon resource={o} size={18}/><span>{o.name}<small>{kindNames[o.kind]}{o.ip?` · ${o.ip}`:''}</small></span></li>)}{!shown.length&&<li className="picker-empty">검색 결과가 없습니다.</li>}</ul>}</div>;
}
export function PathPanel({snapshot,from,to,path,activeHop,picking,onPick,onChange,onSelect,onClose}:{snapshot:Snapshot;from:string;to:string;path:string[];activeHop:string|null;picking:Picking;onPick:(which:Picking)=>void;onChange:(from:string,to:string)=>void;onSelect:(id:string)=>void;onClose:()=>void}){
  const options=useMemo(()=>snapshot.resources.filter(r=>r.kind!=='firewall'&&r.kind!=='subnet'&&r.scope!=='external').sort((a,b)=>a.name.localeCompare(b.name)),[snapshot]);
  const hops=path.map(id=>snapshot.resources.find(r=>r.id===id)!);
  const policiesAt=(r:Resource)=>[...new Set(snapshot.links.filter(l=>l.kind==='policy'&&l.target===r.id).map(l=>snapshot.resources.find(x=>x.id===l.source)?.name))];
  const routeAt=(r:Resource)=>r.routes.find(x=>x.destination==='0.0.0.0/0');
  return <aside className="inspector"><div className="inspector-head"><span>경로 추적</span><button className="icon-button" onClick={onClose} aria-label="경로 추적 닫기"><X size={16}/></button></div><div className="inspector-body">
    <ResourcePicker label="출발" value={from} options={options} onChange={id=>onChange(id,to)} picking={picking==='from'} onPick={()=>onPick(picking==='from'?null:'from')}/>
    <ResourcePicker label="목적지" value={to} options={options} onChange={id=>onChange(from,id)} picking={picking==='to'} onPick={()=>onPick(picking==='to'?null:'to')}/>
    {picking&&<p className="pick-hint" role="status">지도에서 {picking==='from'?'출발':'목적지'} 자원을 누르세요.</p>}
    {hops.length?<><h3>구성상 경로 <span className="count">{hops.length} 홉</span></h3><ol className="hops">{hops.map(r=>{const applied=policiesAt(r),route=routeAt(r);return <li key={r.id} className={r.provider}><button className={activeHop===r.id?'is-active':''} aria-current={activeHop===r.id?'step':undefined} onClick={()=>onSelect(r.id)}><span className="hop-icon"><ResourceIcon resource={r} size={24}/></span><span>{r.name}<small>{kindNames[r.kind]}{scopeNouns[r.provider]?` · ${scopeName(snapshot,r.scope)}`:''}{r.ip?` · ${r.ip}`:r.cidr?` · ${r.cidr}`:''}</small>{route&&<small>기본 경로 → {route.nextHop}</small>}{applied.map(p=><small className="hop-policy" key={p}><ShieldCheck size={10}/>{p}</small>)}</span></button></li>})}</ol></>:<div className="notice warn"><AlertTriangle size={15}/><p>수집한 구성으로는 두 자원을 잇는 경로가 없습니다. 피어링은 전이되지 않으므로 라우팅 장비나 게이트웨이 전이가 필요할 수 있고, 미수집 구간이 있을 수도 있습니다.</p></div>}
    <div className="notice"><Info size={15}/><p>구성 참조, 피어링 전이 규칙, UDR을 반영한 후보 경로입니다. 경로 우선순위, 방화벽 판정, 실제 패킷은 확인하지 않았습니다.</p></div></div></aside>;
}
export function ImpactPanel({snapshot,id,lost,onSelect,onClose}:{snapshot:Snapshot;id:string;lost:string[];onSelect:(id:string)=>void;onClose:()=>void}){
  const r=snapshot.resources.find(x=>x.id===id)!,items=lost.map(l=>snapshot.resources.find(x=>x.id===l)!).filter(x=>x.kind!=='subnet');
  return <aside className="inspector"><div className="inspector-head"><span>단절 영향</span><button className="icon-button" onClick={onClose} aria-label="단절 영향 닫기"><X size={16}/></button></div><div className="hero"><div className="large-icon impact"><Unplug size={20}/></div><h2>{r.name}</h2><p className="muted small">이 자원이 사라지면 사내망까지 이어지는 구성 경로가 모두 끊기는 자원입니다.</p></div><div className="inspector-body"><h3>영향 가능 자원 <span className="count">{items.length}</span></h3>{items.length?items.map(x=><button key={x.id} className="relation-row" onClick={()=>onSelect(x.id)}><ResourceIcon resource={x} size={22}/><span>{x.name}<small>{kindNames[x.kind]} · {scopeName(snapshot,x.scope)}</small></span><ArrowUpRight size={13}/></button>):<p className="muted small">수집한 구성에서는 다른 경로가 남아 있거나 사내망에 의존하는 자원이 없습니다.</p>}<div className="notice"><Info size={15}/><p>구성과 피어링 전이 규칙으로 계산한 가능성입니다. 경로 우선순위와 BGP 상태는 반영하지 않아 실제 장애 영향으로 단정할 수 없습니다.</p></div></div></aside>;
}

// Who to ask about this resource. An inherited value names where it came from, and a missing one says which tag would set it.
function Ownership({snapshot,resource}:{snapshot:Snapshot;resource:Resource}){
  const keys=snapshot.ownership??DEFAULT_OWNERSHIP_KEYS,byId=useMemo(()=>new Map(snapshot.resources.map(x=>[x.id,x])),[snapshot]),o=ownershipOf(resource,byId,keys);
  if(resource.provider==='onprem'||resource.kind==='external')return null;
  const value=(v:string|undefined,from:string|undefined,tags:string[])=>v?<dd>{v}{from&&<small className="inherited"> · {from}에서 상속</small>}</dd>:<dd className="muted" title={`태그 ${tags.join(', ')} 중 하나로 지정합니다.`}>미지정</dd>;
  return <><h3>담당</h3><dl className="properties"><div><dt>담당자</dt>{value(o.owner,o.ownerFrom,keys.owner)}</div><div><dt>서비스</dt>{value(o.service,o.serviceFrom,keys.service)}</div></dl></>;
}
