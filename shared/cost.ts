import type {CostRow} from './schema.js';
export type Group={key:string;amount:number;previous:number;change:number|null};
// Rates read "1 unit of that currency = rate units of base". They come from the operator's settings, never from a guess.
export type Fx={base:string;rates:Record<string,number>;source:string};
export function parseFx(env:Record<string,string|undefined>):Fx|undefined{
  const raw=env.ATLAS_FX_RATES?.trim();if(!raw)return undefined;
  const base=(env.ATLAS_COST_CURRENCY??'KRW').trim().toUpperCase(),rates:Record<string,number>={};
  for(const part of raw.split(',')){const [code,value]=part.split('=').map(x=>x?.trim());const n=Number(value);if(/^[A-Za-z]{3}$/.test(code??'')&&n>0)rates[code.toUpperCase()]=n;}
  return Object.keys(rates).length&&/^[A-Z]{3}$/.test(base)?{base,rates,source:'ATLAS_FX_RATES'}:undefined;
}
// Rows in a currency with no rate stay as they are, so the summary can still say the currencies are mixed.
export function convertCost(rows:CostRow[],fx?:Fx){
  const converted=new Set<string>();
  const out=fx?rows.map(r=>{if(r.currency===fx.base)return r;const rate=fx.rates[r.currency];if(!rate)return r;converted.add(r.currency);return{...r,amount:r.amount*rate,currency:fx.base};}):rows;
  return{rows:out,converted:[...converted]};
}
// Any currency to the one the reader picked, through the base the rates are written in. A row with no usable rate is left out and counted, never shown in the wrong unit.
export function convertTo(rows:CostRow[],target:string,fx?:Fx){
  const rate=(c:string)=>c===fx?.base?1:fx?.rates[c],to=rate(target),converted=new Set<string>(),dropped=new Map<string,{currency:string;providers:Set<string>;count:number}>();
  const out:CostRow[]=[];
  for(const r of rows){
    if(r.currency===target){out.push(r);continue;}
    const from=rate(r.currency);
    if(from&&to){out.push({...r,amount:r.amount*from/to,currency:target});converted.add(r.currency);continue;}
    const d=dropped.get(r.currency)??{currency:r.currency,providers:new Set<string>(),count:0};d.providers.add(r.provider);d.count++;dropped.set(r.currency,d);
  }
  return{rows:out,converted:[...converted],dropped:[...dropped.values()].map(d=>({currency:d.currency,providers:[...d.providers],count:d.count}))};
}
export const billingCurrencies=(rows:CostRow[])=>{const m=new Map<string,Set<string>>();for(const r of rows)(m.get(r.provider)??m.set(r.provider,new Set()).get(r.provider)!).add(r.currency);return [...m].map(([provider,set])=>({provider,currencies:[...set]}));};
export type CostSummary={currency:string|null;mixed:boolean;converted:string[];dropped:{currency:string;providers:string[];count:number}[];currencyTotals:{currency:string;current:number;previous:number}[];months:string[];currentMonth:string|null;byMonth:Record<string,Record<string,number>>;monthTotals:Record<string,number>;currentTotal:number;previousTotal:number;projected:number|null;providerTotals:Record<string,{current:number;previous:number;projected:number|null}>;services:Group[];scopes:Group[]};
const pct=(now:number,before:number)=>before>0?(now-before)/before:null;
const monthKey=(d:Date)=>`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
// A partial month is only comparable to a full one once scaled to the whole month, and that scaling is an estimate.
const project=(amount:number,now:Date)=>{const day=now.getUTCDate(),days=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0)).getUTCDate();return amount/day*days;};
export function summarizeCost(input:CostRow[],now=new Date(),fx?:Fx,target?:string):CostSummary{
  const {rows,converted,dropped}=target?convertTo(input,target,fx):{...convertCost(input,fx),dropped:[]};
  const currencies=[...new Set(rows.map(r=>r.currency))],mixed=currencies.length>1,months=[...new Set(rows.map(r=>r.month))].sort(),thisMonth=monthKey(now),currentMonth=months.at(-1)??null;
  const partial=currentMonth===thisMonth,lastFull=partial?months.at(-2)??null:currentMonth,beforeFull=lastFull?months[months.indexOf(lastFull)-1]??null:null;
  const byMonth:CostSummary['byMonth']={},monthTotals:Record<string,number>={};
  for(const r of rows){(byMonth[r.month]??={})[r.provider]=(byMonth[r.month][r.provider]??0)+r.amount;monthTotals[r.month]=(monthTotals[r.month]??0)+r.amount;}
  const providerTotals:CostSummary['providerTotals']={};
  for(const p of new Set(rows.map(r=>r.provider))){const current=currentMonth?byMonth[currentMonth]?.[p]??0:0,previous=(partial?lastFull:beforeFull)?byMonth[(partial?lastFull:beforeFull)!]?.[p]??0:0;providerTotals[p]={current,previous,projected:partial?project(current,now):null};}
  const group=(key:(r:CostRow)=>string):Group[]=>{const m=new Map<string,{amount:number;previous:number}>();for(const r of rows){if(r.month!==lastFull&&r.month!==beforeFull)continue;const e=m.get(key(r))??{amount:0,previous:0};if(r.month===lastFull)e.amount+=r.amount;else e.previous+=r.amount;m.set(key(r),e);}return [...m].map(([k,e])=>({key:k,...e,change:pct(e.amount,e.previous)})).sort((a,b)=>b.amount-a.amount);};
  const currentTotal=currentMonth?monthTotals[currentMonth]??0:0,previousTotal=(partial?lastFull:beforeFull)?monthTotals[(partial?lastFull:beforeFull)!]??0:0;
  const totalsFor=(c:string)=>{const sum=(m:string|null)=>m?rows.filter(r=>r.currency===c&&r.month===m).reduce((n,r)=>n+r.amount,0):0;return{currency:c,current:sum(currentMonth),previous:sum((partial?lastFull:beforeFull)??null)};};
  return{currency:mixed?null:currencies[0]??target??null,mixed,converted,dropped,currencyTotals:currencies.sort().map(totalsFor),months,currentMonth,byMonth,monthTotals,currentTotal,previousTotal,projected:partial?project(currentTotal,now):null,providerTotals,services:group(r=>`${r.provider}|${r.service}`),scopes:group(r=>`${r.provider}|${r.scope}`)};
}
export type Spike={provider:string;scope:string;service:string;amount:number;previous:number;change:number;currency:string};
// Compares the last two complete months, because a partial month always looks like a drop.
// The floor is a few hundred dollars' worth in each currency, so a 300 KRW change never counts as a spike.
const SPIKE_FLOOR:Record<string,number>={KRW:400_000,JPY:45_000};
export function costSpikes(input:CostRow[],now=new Date(),minIncrease?:number,minRatio=.3,fx?:Fx,target?:string):Spike[]{
  const {rows}=target?convertTo(input,target,fx):convertCost(input,fx),floor=(c:string)=>minIncrease??SPIKE_FLOOR[c]??300,currencyOf=new Map(rows.map(r=>[`${r.provider}|${r.scope}|${r.service}`,r.currency]));
  const full=[...new Set(rows.map(r=>r.month))].sort().filter(m=>m!==monthKey(now)),last=full.at(-1),before=full.at(-2);if(!last||!before)return [];
  const sum=new Map<string,{provider:string;scope:string;service:string;amount:number;previous:number}>();
  for(const r of rows){if(r.month!==last&&r.month!==before)continue;const k=`${r.provider}|${r.scope}|${r.service}`,e=sum.get(k)??{provider:r.provider,scope:r.scope,service:r.service,amount:0,previous:0};if(r.month===last)e.amount+=r.amount;else e.previous+=r.amount;sum.set(k,e);}
  return [...sum.values()].filter(e=>e.previous>0&&e.amount-e.previous>=floor(currencyOf.get(`${e.provider}|${e.scope}|${e.service}`)??'USD')&&(e.amount-e.previous)/e.previous>=minRatio).map(e=>({...e,change:(e.amount-e.previous)/e.previous,currency:currencyOf.get(`${e.provider}|${e.scope}|${e.service}`)??'USD'})).sort((a,b)=>(b.amount-b.previous)-(a.amount-a.previous));
}
export const moneyShort=(amount:number,currency:string|null)=>new Intl.NumberFormat(currency==='KRW'?'ko-KR':'en-US',{style:currency?'currency':'decimal',currency:currency??undefined,notation:'compact',maximumFractionDigits:1}).format(amount);
export const money=(amount:number,currency:string|null)=>new Intl.NumberFormat('ko-KR',{style:currency?'currency':'decimal',currency:currency??undefined,maximumFractionDigits:amount>=1_000_000?1:amount>=100?0:2,notation:amount>=1_000_000?'compact':'standard'}).format(amount);
