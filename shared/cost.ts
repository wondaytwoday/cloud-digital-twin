import type {CostRow} from './schema.js';
export type Group={key:string;amount:number;previous:number;change:number|null};
export type CostSummary={currency:string|null;mixed:boolean;months:string[];currentMonth:string|null;byMonth:Record<string,Record<string,number>>;monthTotals:Record<string,number>;currentTotal:number;previousTotal:number;projected:number|null;providerTotals:Record<string,{current:number;previous:number;projected:number|null}>;services:Group[];scopes:Group[]};
const pct=(now:number,before:number)=>before>0?(now-before)/before:null;
const monthKey=(d:Date)=>`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
// A partial month is only comparable to a full one once scaled to the whole month, and that scaling is an estimate.
const project=(amount:number,now:Date)=>{const day=now.getUTCDate(),days=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0)).getUTCDate();return amount/day*days;};
export function summarizeCost(rows:CostRow[],now=new Date()):CostSummary{
  const currencies=[...new Set(rows.map(r=>r.currency))],mixed=currencies.length>1,months=[...new Set(rows.map(r=>r.month))].sort(),thisMonth=monthKey(now),currentMonth=months.at(-1)??null;
  const partial=currentMonth===thisMonth,lastFull=partial?months.at(-2)??null:currentMonth,beforeFull=lastFull?months[months.indexOf(lastFull)-1]??null:null;
  const byMonth:CostSummary['byMonth']={},monthTotals:Record<string,number>={};
  for(const r of rows){(byMonth[r.month]??={})[r.provider]=(byMonth[r.month][r.provider]??0)+r.amount;monthTotals[r.month]=(monthTotals[r.month]??0)+r.amount;}
  const providerTotals:CostSummary['providerTotals']={};
  for(const p of new Set(rows.map(r=>r.provider))){const current=currentMonth?byMonth[currentMonth]?.[p]??0:0,previous=(partial?lastFull:beforeFull)?byMonth[(partial?lastFull:beforeFull)!]?.[p]??0:0;providerTotals[p]={current,previous,projected:partial?project(current,now):null};}
  const group=(key:(r:CostRow)=>string):Group[]=>{const m=new Map<string,{amount:number;previous:number}>();for(const r of rows){if(r.month!==lastFull&&r.month!==beforeFull)continue;const e=m.get(key(r))??{amount:0,previous:0};if(r.month===lastFull)e.amount+=r.amount;else e.previous+=r.amount;m.set(key(r),e);}return [...m].map(([k,e])=>({key:k,...e,change:pct(e.amount,e.previous)})).sort((a,b)=>b.amount-a.amount);};
  const currentTotal=currentMonth?monthTotals[currentMonth]??0:0,previousTotal=(partial?lastFull:beforeFull)?monthTotals[(partial?lastFull:beforeFull)!]??0:0;
  return{currency:mixed?null:currencies[0]??null,mixed,months,currentMonth,byMonth,monthTotals,currentTotal,previousTotal,projected:partial?project(currentTotal,now):null,providerTotals,services:group(r=>`${r.provider}|${r.service}`),scopes:group(r=>`${r.provider}|${r.scope}`)};
}
export type Spike={provider:string;scope:string;service:string;amount:number;previous:number;change:number};
// Compares the last two complete months, because a partial month always looks like a drop.
export function costSpikes(rows:CostRow[],now=new Date(),minIncrease=300,minRatio=.3):Spike[]{
  const full=[...new Set(rows.map(r=>r.month))].sort().filter(m=>m!==monthKey(now)),last=full.at(-1),before=full.at(-2);if(!last||!before)return [];
  const sum=new Map<string,{provider:string;scope:string;service:string;amount:number;previous:number}>();
  for(const r of rows){if(r.month!==last&&r.month!==before)continue;const k=`${r.provider}|${r.scope}|${r.service}`,e=sum.get(k)??{provider:r.provider,scope:r.scope,service:r.service,amount:0,previous:0};if(r.month===last)e.amount+=r.amount;else e.previous+=r.amount;sum.set(k,e);}
  return [...sum.values()].filter(e=>e.previous>0&&e.amount-e.previous>=minIncrease&&(e.amount-e.previous)/e.previous>=minRatio).map(e=>({...e,change:(e.amount-e.previous)/e.previous})).sort((a,b)=>(b.amount-b.previous)-(a.amount-a.previous));
}
export const moneyShort=(amount:number,currency:string|null)=>new Intl.NumberFormat('en-US',{style:currency?'currency':'decimal',currency:currency??undefined,notation:'compact',maximumFractionDigits:1}).format(amount);
export const money=(amount:number,currency:string|null)=>new Intl.NumberFormat('ko-KR',{style:currency?'currency':'decimal',currency:currency??undefined,maximumFractionDigits:amount>=100?0:2,notation:amount>=1_000_000?'compact':'standard'}).format(amount);
