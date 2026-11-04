import {useMemo} from 'react';
import {ArrowUpRight} from 'lucide-react';
import type {Snapshot} from '../../shared/schema';
import {inScope,type Focus} from '../../shared/hierarchy';
import {cidrOverlaps,hybridLinks} from '../../shared/network';
import {health} from '../../shared/topology';
import {ProviderMark} from '../graph';
import {Kpi} from '../charts';
const stateClass=(s:string)=>`status h-${health(s)}`;
export function NetworkPage({snapshot,focus,openResource}:{snapshot:Snapshot;focus:Focus;openResource:(id:string)=>void}){
  const byId=useMemo(()=>new Map(snapshot.resources.map(r=>[r.id,r])),[snapshot]),within=(r?:{provider:string;scope:string})=>!!r&&inScope(focus,r.provider,r.scope);
  const networks=snapshot.resources.filter(r=>r.kind==='network'&&within(r)),subnets=snapshot.resources.filter(r=>r.kind==='subnet'&&within(r)).length;
  const hybrid=hybridLinks(snapshot.resources,snapshot.links).filter(h=>within(h.target));
  // Peerings and overlaps span two networks, so either side being in scope is enough to show them.
  const peerings=snapshot.links.filter(l=>l.kind==='peering'&&(within(byId.get(l.source))||within(byId.get(l.target))));
  const overlaps=cidrOverlaps(snapshot.resources).filter(o=>within(o.a)||within(o.b));
  const Link=({id,name}:{id:string;name:string})=><button className="table-link" onClick={()=>openResource(id)}>{name}<ArrowUpRight size={12}/></button>;
  return <div className="page"><header className="page-head"><div><h1>네트워크</h1><p>{snapshot.mode==='mock'?'예시 데이터입니다. ':''}사내망 연결, 피어링, 주소 대역 중복을 봅니다.</p></div></header>
    <section className="kpi-row" aria-label="네트워크 지표"><Kpi label="네트워크" value={String(networks.length)} hint={`서브넷 ${subnets}개`}/><Kpi label="사내망 연결" value={String(hybrid.length)} hint={hybrid.some(h=>health(h.target.status)==='warn')?'이상 있음':'이상 없음'} tone={hybrid.some(h=>health(h.target.status)==='warn')?'bad':undefined}/><Kpi label="피어링" value={String(peerings.length)}/><Kpi label="주소 대역 중복" value={String(overlaps.length)} tone={overlaps.length?'warn':undefined}/></section>
    <div className="dash-grid">
      <section className="panel span-2"><header className="panel-head"><h2>사내망 연결 <span className="count">{hybrid.length}</span></h2></header>{hybrid.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>거점</th><th>연결</th><th>대상</th><th>상태</th></tr></thead><tbody>{hybrid.map(h=><tr key={h.site.id+h.target.id}><td>{h.site.name}</td><td>{h.label}</td><td><Link id={h.target.id} name={h.target.name}/></td><td><span className={stateClass(h.target.status)}><i/>{h.target.status}</span></td></tr>)}</tbody></table></div>:focus.provider==='all'?<p className="muted small empty-note">등록된 사내망 연결이 없습니다. <code>data/onprem.json</code>에 등록하면 표시합니다.</p>:<p className="muted small empty-note">이 범위에 연결된 사내망이 없습니다.</p>}</section>
      <section className="panel"><header className="panel-head"><h2>주소 대역 중복 <span className="count">{overlaps.length}</span></h2></header>{overlaps.length?<ul className="overlap-rows">{overlaps.slice(0,10).map(o=><li key={o.a.id+o.b.id}><Link id={o.a.id} name={o.a.name}/><span className="mono">{o.cidrA}</span><span className="overlap-x">중복</span><Link id={o.b.id} name={o.b.name}/><span className="mono">{o.cidrB}</span></li>)}</ul>:<p className="muted small empty-note">겹치는 주소 대역이 없습니다.</p>}<p className="more-note">겹치는 대역은 피어링과 사내망 라우팅을 막을 수 있습니다.</p></section>
      <section className="panel span-3"><header className="panel-head"><h2>피어링 <span className="count">{peerings.length}</span></h2></header>{peerings.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>네트워크</th><th>상대 네트워크</th><th>클라우드</th><th>구분</th></tr></thead><tbody>{peerings.map(l=>{const a=byId.get(l.source)!,b=byId.get(l.target)!;return <tr key={l.id}><td><Link id={a.id} name={a.name}/></td><td><Link id={b.id} name={b.name}/></td><td><ProviderMark provider={a.provider}/></td><td>{l.label}</td></tr>})}</tbody></table></div>:<p className="muted small empty-note">이 범위에 피어링이 없습니다.</p>}</section>
    </div></div>;
}
