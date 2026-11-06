import {useState} from 'react';
import {money,moneyShort,type CostSummary} from '../shared/cost';
const NAMES:Record<string,string>={azure:'Azure',aws:'AWS',gcp:'Google Cloud'};
const ORDER=['azure','aws','gcp'];
const monthLabel=(m:string)=>`${Number(m.slice(5))}월`;
const niceMax=(v:number)=>{if(v<=0)return 1;const step=10**Math.floor(Math.log10(v)),n=v/step;return (n<=1?1:n<=2?2:n<=5?5:10)*step;};
export function Legend({series}:{series:string[]}){return <ul className="chart-legend" aria-hidden="true">{series.map(s=><li key={s}><i className={`swatch c-${s}`}/>{NAMES[s]??s}</li>)}</ul>;}
// One axis, thin bars, a 2px surface gap between segments. The partial month shows its projection as an outline, never as if it were spent.
export function CostTrend({summary,compact}:{summary:CostSummary;compact?:boolean}){
  const [active,setActive]=useState<string|null>(null),[table,setTable]=useState(false),{months,byMonth,monthTotals,currentMonth,projected,currency}=summary;
  const present=ORDER.filter(p=>months.some(m=>byMonth[m]?.[p]));
  const top=niceMax(Math.max(...months.map(m=>monthTotals[m]??0),projected??0)),fmt=(v:number)=>money(v,currency);
  if(!months.length)return <p className="muted small">비용 데이터가 없습니다.</p>;
  return <figure className={`cost-trend ${compact?'compact':''}`}>
    <figcaption className="chart-head"><Legend series={present}/><button className="link-button small" aria-pressed={table} onClick={()=>setTable(!table)}>{table?'차트 보기':'표 보기'}</button></figcaption>
    {table?<table className="data-table"><thead><tr><th>월</th>{present.map(p=><th key={p} className="num">{NAMES[p]}</th>)}<th className="num">합계</th></tr></thead><tbody>{months.map(m=><tr key={m}><td>{m}{m===currentMonth&&projected!==null?' (진행 중)':''}</td>{present.map(p=><td key={p} className="num">{fmt(byMonth[m]?.[p]??0)}</td>)}<td className="num strong">{fmt(monthTotals[m]??0)}</td></tr>)}</tbody></table>:
    <div className="bars" role="img" aria-label={`월별 비용. 최근 합계 ${fmt(summary.currentTotal)}`}>
      <div className="bars-grid" aria-hidden="true">{[1,.5,0].map(f=><div key={f} style={{bottom:`${f*100}%`}}><span>{moneyShort(top*f,currency)}</span></div>)}</div>
      <div className="bars-plot">{months.map(m=>{const total=monthTotals[m]??0,partial=m===currentMonth&&projected!==null;return <button key={m} className={`bar-col ${active===m?'is-active':''}`} onMouseEnter={()=>setActive(m)} onMouseLeave={()=>setActive(null)} onFocus={()=>setActive(m)} onBlur={()=>setActive(null)} aria-label={`${m} 합계 ${fmt(total)}`}>
        <span className="bar-stack">{partial&&<i className="bar-projected" style={{height:`${projected/top*100}%`}}/>}<span className="bar-fill" style={{height:`${total/top*100}%`}}>{present.map(p=>byMonth[m]?.[p]?<i key={p} className={`bar-seg c-${p}`} style={{flexGrow:byMonth[m][p]}}/>:null)}</span></span>
        <span className="bar-label">{monthLabel(m)}{partial&&<small>진행 중</small>}</span>
        {active===m&&<span className="chart-tip" role="tooltip"><b>{m}</b>{present.map(p=><span key={p}><i className={`swatch c-${p}`}/>{NAMES[p]}<em>{fmt(byMonth[m]?.[p]??0)}</em></span>)}<span className="tip-total">합계<em>{fmt(total)}</em></span>{partial&&<span className="tip-total">월말 예상<em>{fmt(projected)}</em></span>}</span>}
      </button>})}</div>
    </div>}
  </figure>;
}
export const Delta=({value}:{value:number|null})=>value===null?<span className="delta none">신규</span>:<span className={`delta ${value>.02?'up':value<-.02?'down':'flat'}`}>{value>0?'+':''}{Math.round(value*100)}%</span>;
export function BarRows({rows,total,format}:{rows:{key:string;label:string;sub?:string;value:number;series?:string;change?:number|null;onClick?:()=>void}[];total:number;format:(v:number)=>string}){
  return <ul className="bar-rows">{rows.map(r=>{const body=<><span className="bar-row-name"><span>{r.series&&<i className={`swatch c-${r.series}`}/>}{r.label}</span>{r.sub&&<small>{r.sub}</small>}</span><span className="bar-row-track" aria-hidden="true"><i className={r.series?`c-${r.series}`:'c-neutral'} style={{width:`${total?r.value/total*100:0}%`}}/></span><span className="bar-row-value">{format(r.value)}</span>{r.change!==undefined&&<Delta value={r.change}/>}</>;return <li key={r.key}>{r.onClick?<button onClick={r.onClick}>{body}</button>:<div>{body}</div>}</li>})}</ul>;
}
export function Kpi({label,value,hint,tone,title,onClick}:{label:string;value:string;hint?:string;tone?:'bad'|'warn';title?:string;onClick?:()=>void}){
  const inner=<><span className="kpi-label">{label}</span><strong className={tone?`kpi-${tone}`:''}>{value}</strong>{hint&&<small>{hint}</small>}</>;
  return onClick?<button className="kpi" title={title} onClick={onClick}>{inner}</button>:<div className="kpi" title={title}>{inner}</div>;
}
export function ProviderFilter({value,onChange,present}:{value:string;onChange:(v:string)=>void;present:string[]}){
  return <div className="segmented" role="group" aria-label="클라우드 필터">{['all',...present].map(p=><button key={p} className={value===p?'active':''} aria-pressed={value===p} onClick={()=>onChange(p)}>{p==='all'?'전체':NAMES[p]}</button>)}</div>;
}
