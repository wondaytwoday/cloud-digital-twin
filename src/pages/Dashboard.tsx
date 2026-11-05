import {useMemo} from 'react';
import {ArrowRight,Minus,Network,PenLine,Plus} from 'lucide-react';
import type {Resource,Snapshot} from '../../shared/schema';
import {money,summarizeCost} from '../../shared/cost';
import {exposures,health} from '../../shared/topology';
import type {Finding} from '../../shared/findings';
import {iamInScope,inScope,type Focus} from '../../shared/hierarchy';
import {ProviderMark,kindNames} from '../graph';
import {providerNames} from '../layout';
import {BarRows,CostTrend,Delta,Kpi} from '../charts';
import {FindingList} from './Findings';
export type Go=(view:'findings'|'changes'|'map'|'iam'|'cost'|'network'|'security'|'inventory',id?:string)=>void;
const changeIcon={added:Plus,removed:Minus,changed:PenLine};
const SHOWN_FINDINGS=6;
export function Dashboard({snapshot,focus,list,go,openFinding}:{snapshot:Snapshot;focus:Focus;list:Finding[];go:Go;openFinding:(f:Finding)=>void}){
  const present=['azure','aws','gcp'].filter(p=>(focus.provider==='all'||p===focus.provider)&&snapshot.resources.some(r=>r.provider===p));
  const resources=useMemo(()=>snapshot.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external'&&inScope(focus,r.provider,r.scope)),[snapshot,focus]);
  const cost=useMemo(()=>summarizeCost(snapshot.cost.filter(c=>inScope(focus,c.provider,c.scope))),[snapshot,focus]);
  const iam=snapshot.iam.filter(a=>iamInScope(focus,a)),fmt=(v:number)=>money(v,cost.currency);
  const urgent=list.filter(f=>f.severity==='critical'||f.severity==='high').length;
  const exposed=exposures(snapshot.resources,snapshot.links).filter(e=>inScope(focus,e.resource.provider,e.resource.scope)).length,privileged=iam.filter(a=>a.privileged).length;
  const headline=cost.projected??cost.currentTotal,delta=cost.previousTotal?(headline-cost.previousTotal)/cost.previousTotal:null;
  const byKind=new Map<Resource['kind'],number>();for(const r of resources)if(r.kind!=='subnet')byKind.set(r.kind,(byKind.get(r.kind)??0)+1);
  const kinds=[...byKind].sort((a,b)=>b[1]-a[1]).slice(0,7),changes=(snapshot.changes?.items??[]).filter(c=>inScope(focus,c.provider,c.scope));
  return <div className="page"><header className="page-head"><div><h1>운영 대시보드</h1><p>{snapshot.mode==='mock'?'예시 데이터입니다. 자원, 사용률, 비용, IAM 모두 실제 값이 아닙니다.':`수집 시각 ${new Date(snapshot.collectedAt).toLocaleString('ko-KR')}`}</p></div>
      <div className="page-actions"><button className="button primary" onClick={()=>go('map')}><Network size={15}/>토폴로지 보기</button></div></header>
    <section className="kpi-row" aria-label="주요 지표">
      <Kpi label={cost.projected!==null?'이번 달 예상 비용':'최근 월 비용'} value={cost.mixed?'통화 혼재':fmt(headline)} hint={cost.mixed?'클라우드별로 확인하세요':delta===null?'지난달 데이터 없음':`지난달 대비 ${delta>0?'+':''}${Math.round(delta*100)}%`} onClick={()=>go('cost')}/>
      <Kpi label="수집 자원" value={resources.length.toLocaleString('ko-KR')} hint={`범위 ${new Set(resources.map(r=>r.scope)).size}개`} onClick={()=>go('inventory')}/>
      <Kpi label="조치 필요" value={String(urgent)} hint="긴급, 높음" tone={urgent?'bad':undefined} onClick={()=>go('findings')}/>
      <Kpi label="공인 노출 후보" value={String(exposed)} hint="공인 IP + 넓은 허용" tone={exposed?'warn':undefined} onClick={()=>go('security')}/>
      <Kpi label="특권 할당" value={String(privileged)} hint={`전체 할당 ${iam.length}건`} onClick={()=>go('iam')}/>
    </section>
    <div className="dash-grid">
      <section className="panel span-2"><header className="panel-head"><h2>월별 비용</h2><button className="link-button" onClick={()=>go('cost')}>비용 상세<ArrowRight size={14}/></button></header><CostTrend summary={cost}/></section>
      <section className="panel"><header className="panel-head"><h2>클라우드별 현황</h2></header><ul className="csp-rows">{present.map(p=>{const t=cost.providerTotals[p],rs=resources.filter(r=>r.provider===p),bad=rs.filter(r=>r.kind!=='firewall'&&health(r.status)==='warn').length,conn=snapshot.connections.find(c=>c.provider===p),now=t?.projected??t?.current??0;return <li key={p}><ProviderMark provider={p}/><div><strong>{providerNames[p]}</strong><small>자원 {rs.length} · 범위 {new Set(rs.map(r=>r.scope)).size}{bad?` · 이상 ${bad}`:''}{conn?.status==='demo'?' · 예시 데이터':''}</small></div><div className="csp-cost"><strong>{t?fmt(now):'—'}</strong>{t&&<Delta value={t.previous?(now-t.previous)/t.previous:null}/>}</div></li>})}</ul></section>
      <section className="panel span-2"><header className="panel-head"><h2>우선 조치 <span className="count">{list.length}</span></h2><button className="link-button" onClick={()=>go('findings')}>조치 항목 전체<ArrowRight size={14}/></button></header><FindingList items={list} onOpen={openFinding} limit={SHOWN_FINDINGS}/></section>
      <div className="dash-side">
        <section className="panel"><header className="panel-head"><h2>자원 구성</h2><button className="link-button" onClick={()=>go('inventory')}>인벤토리<ArrowRight size={14}/></button></header><BarRows rows={kinds.map(([k,v])=>({key:k,label:kindNames[k],value:v}))} total={kinds[0]?.[1]??1} format={v=>String(v)}/></section>
        <section className="panel"><header className="panel-head"><h2>최근 변경 <span className="count">{changes.length}</span></h2><button className="link-button" onClick={()=>go('changes')}>변경 이력<ArrowRight size={14}/></button></header>{changes.length?<ul className="change-rows">{changes.slice(0,6).map(c=>{const Icon=changeIcon[c.kind];return <li key={c.id+c.kind} className={`change-${c.kind}`}><Icon size={14}/><span>{c.name}<small>{c.detail}</small></span></li>})}</ul>:<p className="muted small empty-note">이전 수집과 달라진 점이 없습니다.</p>}</section>
      </div>
    </div></div>;
}
