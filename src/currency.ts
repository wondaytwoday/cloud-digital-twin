import {useState} from 'react';
import type {Snapshot} from '../shared/schema';
import {resolveCostFx} from '../shared/currency';
export type CostCurrency='KRW'|'USD';
// Storage can be blocked; the choice then lasts until the page closes.
const read=(key:string)=>{try{return localStorage.getItem(key)??'';}catch{return '';}};
const write=(key:string,value:string)=>{try{value?localStorage.setItem(key,value):localStorage.removeItem(key);}catch{/* see read */}};
const DEMO_RATE=1380;
// One reading of the USD→KRW rate, from the first of: what the reader typed, the server's ATLAS_FX_RATES, a labelled demo rate in mock mode.
export function useCostCurrency(snapshot:Snapshot){
  const [currency,setCurrencyState]=useState<CostCurrency>(()=>read('atlas.cost.currency')==='USD'?'USD':'KRW');
  const [typed,setTyped]=useState(()=>read('atlas.fx.usdkrw'));
  const {rate,source,fx}=resolveCostFx(snapshot.fx,typed,snapshot.mode==='mock'?DEMO_RATE:undefined);
  return{currency,setCurrency:(c:CostCurrency)=>{setCurrencyState(c);write('atlas.cost.currency',c);},rate,source,typed,setRate:(v:string)=>{setTyped(v);write('atlas.fx.usdkrw',Number.isFinite(Number(v))&&Number(v)>0?v:'');},fx};
}
