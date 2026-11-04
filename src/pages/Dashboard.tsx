import {useMemo,useState} from 'react';
import {ArrowRight,Minus,Network,PenLine,Plus} from 'lucide-react';
import type {Resource,Snapshot} from '../../shared/schema';
import {money,summarizeCost} from '../../shared/cost';
import {exposures,health} from '../../shared/topology';
import type {Category,Finding} from '../../shared/findings';
import {ProviderMark,kindNames} from '../graph';
import {providerNames} from '../layout';
import {BarRows,CostTrend,Delta,Kpi,ProviderFilter} from '../charts';
import {CATEGORY,FindingList} from './Findings';
export type Go=(view:'map'|'iam'|'cost'|'network'|'inventory'|'scopes',id?:string)=>void;
const changeIcon={added:Plus,removed:Minus,changed:PenLine};
export function Dashboard({snapshot,list,go,openFinding}:{snapshot:Snapshot;list:Finding[];go:Go;openFinding:(f:Finding)=>void}){
  const [provider,setProvider]=useState('all'),[category,setCategory]=useState<Category|'all'>('all');
  const present=['azure','aws','gcp'].filter(p=>snapshot.resources.some(r=>r.provider===p));
  const match=(p?:string)=>provider==='all'||p===provider;
  const resources=useMemo(()=>snapshot.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external'&&match(r.provider)),[snapshot,provider]);
  const cost=useMemo(()=>summarizeCost(snapshot.cost.filter(c=>match(c.provider))),[snapshot,provider]);
  const iam=snapshot.iam.filter(a=>match(a.provider)),fmt=(v:number)=>money(v,cost.currency);
  const shown=list.filter(f=>(!f.provider||match(f.provider))&&(category==='all'||f.category===category)),urgent=list.filter(f=>(f.severity==='critical'||f.severity==='high')&&(!f.provider||match(f.provider))).length;
  const exposed=exposures(snapshot.resources,snapshot.links).filter(e=>match(e.resource.provider)).length,privileged=iam.filter(a=>a.privileged).length;
  const headline=cost.projected??cost.currentTotal,delta=cost.previousTotal?(headline-cost.previousTotal)/cost.previousTotal:null;
  const byKind=new Map<Resource['kind'],number>();for(const r of resources)if(r.kind!=='subnet')byKind.set(r.kind,(byKind.get(r.kind)??0)+1);
  const kinds=[...byKind].sort((a,b)=>b[1]-a[1]).slice(0,7),changes=(snapshot.changes?.items??[]).filter(c=>match(c.provider));
  return <div className="page"><header className="page-head"><div><h1>운영 대시보드</h1><p>{snapshot.mode==='mock'?'예시 데이터입니다. 자원, 사용률, 비용, IAM 모두 실제 값이 아닙니다.':`수집 시각 ${new Date(snapshot.collectedAt).toLocaleString('ko-KR')}`}</p></div>
      <div className="page-actions"><ProviderFilter value={provider} onChange={setProvider} present={present}/><button className="button primary" onClick={()=>go('map')}><Network size={15}/>토폴로지 보기</button></div></header>
    <section className="kpi-row" aria-label="주요 지표">
      <Kpi label={cost.projected!==null?'이번 달 예상 비용':'최근 월 비용'} value={cost.mixed?'통화 혼재':fmt(headline)} hint={cost.mixed?'클라우드별로 확인하세요':delta===null?'지난달 데이터 없음':`지난달 대비 ${delta>0?'+':''}${Math.round(delta*100)}%`} onClick={()=>go('cost')}/>
      <Kpi label="수집 자원" value={resources.length.toLocaleString('ko-KR')} hint={`범위 ${new Set(resources.map(r=>r.scope)).size}개`} onClick={()=>go('inventory')}/>
      <Kpi label="조치 필요" value={String(urgent)} hint="긴급, 높음" tone={urgent?'bad':undefined}/>
      <Kpi label="공인 노출 후보" value={String(exposed)} hint="공인 IP + 넓은 허용" tone={exposed?'warn':undefined} onClick={()=>go('network')}/>
      <Kpi label="특권 할당" value={String(privileged)} hint={`전체 할당 ${iam.length}건`} onClick={()=>go('iam')}/>
    </section>
    <div className="dash-grid">
      <section className="panel span-2"><header className="panel-head"><h2>월별 비용</h2><button className="link-button" onClick={()=>go('cost')}>비용 상세<ArrowRight size={14}/></button></header><CostTrend summary={cost}/></section>
      <section className="panel"><header className="panel-head"><h2>클라우드별 현황</h2></header><ul className="csp-rows">{present.filter(p=>match(p)).map(p=>{const t=cost.providerTotals[p],rs=resources.filter(r=>r.provider===p),bad=rs.filter(r=>r.kind!=='firewall'&&health(r.status)==='warn').length,conn=snapshot.connections.find(c=>c.provider===p),now=t?.projected??t?.current??0;return <li key={p}><ProviderMark provider={p}/><div><strong>{providerNames[p]}</strong><small>자원 {rs.length} · 범위 {new Set(rs.map(r=>r.scope)).size}{bad?` · 이상 ${bad}`:''}{conn?.status==='demo'?' · 로그인 전':''}</small></div><div className="csp-cost"><strong>{t?fmt(now):'—'}</strong>{t&&<Delta value={t.previous?(now-t.previous)/t.previous:null}/>}</div></li>})}</ul></section>
      <section className="panel span-2"><header className="panel-head"><h2>조치 목록 <span className="count">{shown.length}</span></h2><div className="segmented" role="group" aria-label="영역 필터">{(['all','network','iam','cost','infra'] as const).map(c=><button key={c} className={category===c?'active':''} aria-pressed={category===c} onClick={()=>setCategory(c)}>{c==='all'?'전체':CATEGORY[c]}</button>)}</div></header><FindingList items={shown} onOpen={openFinding} limit={9}/>{shown.length>9&&<p className="more-note">가장 중요한 9건을 표시합니다. 나머지는 각 영역 화면에서 확인하세요.</p>}</section>
      <div className="dash-side">
        <section className="panel"><header className="panel-head"><h2>자원 구성</h2><button className="link-button" onClick={()=>go('inventory')}>인벤토리<ArrowRight size={14}/></button></header><BarRows rows={kinds.map(([k,v])=>({key:k,label:kindNames[k],value:v}))} total={kinds[0]?.[1]??1} format={v=>String(v)}/></section>
        <section className="panel"><header className="panel-head"><h2>최근 변경 <span className="count">{changes.length}</span></h2></header>{changes.length?<ul className="change-rows">{changes.slice(0,6).map(c=>{const Icon=changeIcon[c.kind];return <li key={c.id+c.kind} className={`change-${c.kind}`}><Icon size={14}/><span>{c.name}<small>{c.detail}</small></span></li>})}</ul>:<p className="muted small empty-note">이전 수집과 달라진 점이 없습니다.</p>}</section>
      </div>
    </div></div>;
}
