import {CostNotice} from '../CostNotice';
import {costIssues} from '../../shared/collectionView';
import {useMemo} from 'react';
import {Download,Info} from 'lucide-react';
import type {Snapshot} from '../../shared/schema';
import {billingCurrencies,convertTo,costSpikes,money,summarizeCost} from '../../shared/cost';
import {useCostCurrency,type CostCurrency} from '../currency';
import {Donut,PROVIDER_COLOR} from '@/ui/viz';
import {inScope,type Focus} from '../../shared/hierarchy';
import {BarRows,CostTrend,Delta,Kpi} from '../charts';
const NAMES:Record<string,string>={azure:'Azure',aws:'AWS',gcp:'Google Cloud'};
const SOURCES='Azure Cost Management, AWS Cost Explorer, GCP BigQuery 결제 내보내기';
export function CostPage({snapshot,focus,onScope,onCsv}:{snapshot:Snapshot;focus:Focus;onScope:(tab:string)=>void;onCsv:(content:string,name:string)=>void}){
  const rows=useMemo(()=>snapshot.cost.filter(c=>inScope(focus,c.provider,c.scope)),[snapshot,focus]);
  const cur=useCostCurrency(snapshot),{currency,fx}=cur;
  const s=useMemo(()=>summarizeCost(rows,undefined,fx,currency),[rows,fx,currency]),spikes=useMemo(()=>costSpikes(rows,undefined,undefined,undefined,fx,currency),[rows,fx,currency]);
  const billed=billingCurrencies(rows),fmt=(v:number)=>money(v,currency),label=(x:string)=>snapshot.scopeLabels[x]??x;
  const lastTotal=s.services.reduce((n,x)=>n+x.amount,0),headline=s.projected??s.currentTotal,delta=s.previousTotal?(headline-s.previousTotal)/s.previousTotal:null;
  // The export keeps each row's own amount and currency beside the converted one, so nothing is lost to a rate.
  const exportCsv=()=>onCsv(['provider,scope,scope_name,service,month,amount,currency,original_amount,original_currency',...rows.map(r=>{const c=convertTo([r],currency,fx).rows[0];return [r.provider,r.scope,`"${label(r.scope).replace(/"/g,'""')}"`,`"${r.service.replace(/"/g,'""')}"`,r.month,c?.amount??'',c?currency:'',r.amount,r.currency].join(',');})].join('\n'),`cloud-atlas-cost-${currency}.csv`);
  const issues=costIssues(snapshot,focus);
  if(!rows.length)return <div className="page"><header className="page-head"><div><h1>비용</h1></div></header><CostNotice snapshot={snapshot} focus={focus}/><div className="panel empty-panel"><p>{issues.length?'이 범위의 비용 수집을 완료하지 못했습니다.':'이 범위에 수집된 비용 데이터가 없습니다.'}</p><p className="muted small">{SOURCES}을 읽습니다. 필요한 권한은 클라우드 연결 가이드에 있습니다.</p></div></div>;
  const providerShare=Object.entries(s.providerTotals).map(([p,t])=>({key:p,label:NAMES[p]??p,value:s.projected!==null?t.projected??t.current:t.current,color:PROVIDER_COLOR[p]}));
  return <div className="page"><header className="page-head"><div><h1>비용</h1><p>{snapshot.mode==='mock'?'예시 금액입니다. ':''}{snapshot.costAt?`비용 수집 ${new Date(snapshot.costAt).toLocaleString('ko-KR')}`:''}</p></div>
    <div className="page-actions"><div className="segmented" role="group" aria-label="표시 통화">{(['KRW','USD'] as CostCurrency[]).map(c=><button key={c} className={currency===c?'active':''} aria-pressed={currency===c} onClick={()=>cur.setCurrency(c)}>{c==='KRW'?'원화 ₩':'달러 $'}</button>)}</div>
      <label className="fx-field">1 USD =<input type="number" min="1" step="any" inputMode="decimal" aria-label="환율 (1 USD당 원)" placeholder={cur.rate?String(cur.rate):'환율'} value={cur.typed} onChange={e=>cur.setRate(e.target.value)}/>원{cur.source&&<small>{cur.source}</small>}</label>
      <button className="button" onClick={exportCsv}><Download size={14}/>CSV</button></div></header>
    <CostNotice snapshot={snapshot} focus={focus}/>
    <p className="muted small page-notice">청구 통화: {billed.map(b=>`${NAMES[b.provider]??b.provider} ${b.currencies.join('·')}`).join(' / ')}{billed.some(b=>b.provider==='aws')?' · AWS Cost Explorer는 항상 USD로 반환합니다.':''} 모든 금액을 {currency==='KRW'?'원화':'달러'}로 바꿔 보여주며 두 통화를 섞어 더하지 않습니다.</p>
    {s.converted.length>0&&cur.rate&&<div className="notice page-notice"><Info size={15}/><p>{s.converted.join(', ')} 금액을 1 USD = {cur.rate.toLocaleString('ko-KR')}원({cur.source})으로 환산했습니다. 청구서 환율과 다를 수 있습니다.</p></div>}
    {s.dropped.length>0&&<div className="notice warn page-notice"><Info size={15}/><p>환율이 없어 {s.dropped.map(d=>`${d.providers.map(p=>NAMES[p]??p).join('·')}의 ${d.currency} 비용 ${d.count}건`).join(', ')}을 이 보기에서 뺐습니다. 위에 환율을 입력하거나 .env에 <code>ATLAS_FX_RATES</code>를 넣으면 포함됩니다.</p></div>}
    <section className="kpi-row" aria-label="비용 지표">
      <Kpi label={`${s.projected!==null?'이번 달 누적':'최근 월'}${issues.length?' · 일부 누락':''}`} value={fmt(s.currentTotal)} hint={s.converted.length?`${currency} 환산`:undefined}/>
      {s.projected!==null&&<Kpi label="월말 예상" value={fmt(s.projected)} hint="현재 일평균으로 단순 추정"/>}
      <Kpi label="지난달" value={fmt(s.previousTotal)} hint={delta===null?undefined:`${s.projected!==null?'월말 예상은':'최근 월은'} ${delta>0?'+':''}${Math.round(delta*100)}%`}/>
      <Kpi label="급증 항목" value={String(spikes.length)} hint="지난 두 달 비교, 30% 이상" tone={spikes.length?'warn':undefined}/>
    </section>
    <div className="dash-grid">
      <section className="panel span-2"><header className="panel-head"><h2>월별 비용</h2></header><CostTrend summary={s}/></section>
      <section className="panel"><header className="panel-head"><h2>클라우드별 비중 <small>{s.projected!==null?'이번 달 예상':'최근 월'}</small></h2></header><Donut data={providerShare} format={fmt} center={money(providerShare.reduce((n,p)=>n+p.value,0),currency).replace(/\s/g,'')}/></section>
      <section className="panel span-2"><header className="panel-head"><h2>서비스별 <small>지난 완료 월</small></h2></header><BarRows rows={s.services.slice(0,12).map(x=>{const [p,name]=x.key.split('|');return{key:x.key,label:name,sub:NAMES[p],value:x.amount,series:p,change:x.change};})} total={s.services[0]?.amount??1} format={fmt}/></section>
      <section className="panel"><header className="panel-head"><h2>범위별 <small>누르면 이 범위로 좁힘</small></h2></header><BarRows rows={s.scopes.slice(0,12).map(x=>{const [p,id]=x.key.split('|');return{key:x.key,label:label(id),sub:NAMES[p],value:x.amount,series:p,change:x.change,onClick:()=>onScope(focus.scopes?.size===1&&focus.scopes.has(id)?`provider:${p}`:`${p}:scope:${id}`)};})} total={s.scopes[0]?.amount??1} format={fmt}/></section>
      {spikes.length>0&&<section className="panel span-3"><header className="panel-head"><h2>급증 항목 <span className="count">{spikes.length}</span></h2></header><div className="table-wrap"><table className="data-table"><thead><tr><th>클라우드</th><th>범위</th><th>서비스</th><th className="num">이전 달</th><th className="num">지난달</th><th className="num">변화</th></tr></thead><tbody>{spikes.map(x=><tr key={`${x.provider}${x.scope}${x.service}`}><td>{NAMES[x.provider]}</td><td>{label(x.scope)}</td><td>{x.service}</td><td className="num">{fmt(x.previous)}</td><td className="num strong">{fmt(x.amount)}</td><td className="num"><Delta value={x.change}/></td></tr>)}</tbody></table></div></section>}
      <p className="source-note span-3">출처: {SOURCES}. 할인, 약정, 세금 반영 방식이 CSP마다 달라 청구서 금액과 다를 수 있습니다. 전체 합계는 {lastTotal?fmt(lastTotal):'—'} (지난 완료 월)입니다.</p>
    </div></div>;
}
