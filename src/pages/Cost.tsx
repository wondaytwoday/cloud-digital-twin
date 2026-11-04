import {useMemo} from 'react';
import {Download,Info} from 'lucide-react';
import type {Snapshot} from '../../shared/schema';
import {costSpikes,money,summarizeCost} from '../../shared/cost';
import {inScope,type Focus} from '../../shared/hierarchy';
import {BarRows,CostTrend,Delta,Kpi} from '../charts';
const NAMES:Record<string,string>={azure:'Azure',aws:'AWS',gcp:'Google Cloud'};
const SOURCES='Azure Cost Management, AWS Cost Explorer, GCP BigQuery 결제 내보내기';
export function CostPage({snapshot,focus,onScope,onCsv}:{snapshot:Snapshot;focus:Focus;onScope:(tab:string)=>void;onCsv:(content:string,name:string)=>void}){
  const rows=useMemo(()=>snapshot.cost.filter(c=>inScope(focus,c.provider,c.scope)),[snapshot,focus]);
  const s=useMemo(()=>summarizeCost(rows),[rows]),spikes=useMemo(()=>costSpikes(rows),[rows]),fmt=(v:number)=>money(v,s.currency),label=(x:string)=>snapshot.scopeLabels[x]??x;
  const lastTotal=s.services.reduce((n,x)=>n+x.amount,0),headline=s.projected??s.currentTotal,delta=s.previousTotal?(headline-s.previousTotal)/s.previousTotal:null;
  const exportCsv=()=>onCsv(['provider,scope,scope_name,service,month,amount,currency',...rows.map(r=>[r.provider,r.scope,`"${label(r.scope).replace(/"/g,'""')}"`,`"${r.service.replace(/"/g,'""')}"`,r.month,r.amount,r.currency].join(','))].join('\n'),'cloud-atlas-cost.csv');
  if(!snapshot.cost.length)return <div className="page"><header className="page-head"><div><h1>비용</h1></div></header><div className="panel empty-panel"><p>아직 수집한 비용 데이터가 없습니다.</p><p className="muted small">{SOURCES}을 읽습니다. 필요한 권한은 클라우드 연결 가이드에 있습니다.</p></div></div>;
  return <div className="page"><header className="page-head"><div><h1>비용</h1><p>{snapshot.mode==='mock'?'예시 금액입니다. ':''}{snapshot.costAt?`비용 수집 ${new Date(snapshot.costAt).toLocaleString('ko-KR')}`:''}</p></div>
    <div className="page-actions"><button className="button" onClick={exportCsv}><Download size={14}/>CSV</button></div></header>
    {s.mixed&&<div className="notice warn page-notice"><Info size={15}/><p>통화가 섞여 있어 합계를 내지 않습니다. 환율을 임의로 적용하지 않으니 클라우드별로 필터해서 보세요.</p></div>}
    <section className="kpi-row" aria-label="비용 지표">
      <Kpi label={s.projected!==null?'이번 달 누적':'최근 월'} value={s.mixed?'—':fmt(s.currentTotal)}/>
      {s.projected!==null&&<Kpi label="월말 예상" value={s.mixed?'—':fmt(s.projected)} hint="현재 일평균으로 단순 추정"/>}
      <Kpi label="지난달" value={s.mixed?'—':fmt(s.previousTotal)} hint={delta===null?undefined:`${s.projected!==null?'월말 예상은':'최근 월은'} ${delta>0?'+':''}${Math.round(delta*100)}%`}/>
      <Kpi label="급증 항목" value={String(spikes.length)} hint="지난 두 달 비교, 30% 이상" tone={spikes.length?'warn':undefined}/>
    </section>
    <div className="dash-grid">
      <section className="panel span-3"><header className="panel-head"><h2>월별 비용</h2></header><CostTrend summary={s}/></section>
      <section className="panel span-2"><header className="panel-head"><h2>서비스별 <small>지난 완료 월</small></h2></header><BarRows rows={s.services.slice(0,12).map(x=>{const [p,name]=x.key.split('|');return{key:x.key,label:name,sub:NAMES[p],value:x.amount,series:p,change:x.change};})} total={s.services[0]?.amount??1} format={fmt}/></section>
      <section className="panel"><header className="panel-head"><h2>범위별 <small>누르면 이 범위로 좁힘</small></h2></header><BarRows rows={s.scopes.slice(0,12).map(x=>{const [p,id]=x.key.split('|');return{key:x.key,label:label(id),sub:NAMES[p],value:x.amount,series:p,change:x.change,onClick:()=>onScope(focus.scopes?.size===1&&focus.scopes.has(id)?`provider:${p}`:`${p}:scope:${id}`)};})} total={s.scopes[0]?.amount??1} format={fmt}/></section>
      {spikes.length>0&&<section className="panel span-3"><header className="panel-head"><h2>급증 항목 <span className="count">{spikes.length}</span></h2></header><div className="table-wrap"><table className="data-table"><thead><tr><th>클라우드</th><th>범위</th><th>서비스</th><th className="num">이전 달</th><th className="num">지난달</th><th className="num">변화</th></tr></thead><tbody>{spikes.map(x=><tr key={`${x.provider}${x.scope}${x.service}`}><td>{NAMES[x.provider]}</td><td>{label(x.scope)}</td><td>{x.service}</td><td className="num">{fmt(x.previous)}</td><td className="num strong">{fmt(x.amount)}</td><td className="num"><Delta value={x.change}/></td></tr>)}</tbody></table></div></section>}
      <p className="source-note span-3">출처: {SOURCES}. 할인, 약정, 세금 반영 방식이 CSP마다 달라 청구서 금액과 다를 수 있습니다. 전체 합계는 {lastTotal?fmt(lastTotal):'—'} (지난 완료 월)입니다.</p>
    </div></div>;
}
