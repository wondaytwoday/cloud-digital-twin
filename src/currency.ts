import {useState} from 'react';
import type {Snapshot} from '../shared/schema';
import type {Fx} from '../shared/cost';
export type CostCurrency='KRW'|'USD';
// Storage can be blocked; the choice then lasts until the page closes.
const read=(key:string)=>{try{return localStorage.getItem(key)??'';}catch{return '';}};
const write=(key:string,value:string)=>{try{value?localStorage.setItem(key,value):localStorage.removeItem(key);}catch{/* see read */}};
const DEMO_RATE=1380;
// One reading of the USD→KRW rate, from the first of: what the reader typed, the server's ATLAS_FX_RATES, a labelled demo rate in mock mode.
export function useCostCurrency(snapshot:Snapshot){
  const [currency,setCurrencyState]=useState<CostCurrency>(()=>read('atlas.cost.currency')==='USD'?'USD':'KRW');
  const [typed,setTyped]=useState(()=>read('atlas.fx.usdkrw'));
  const server=snapshot.fx,serverRate=server?.base==='KRW'?server.rates.USD:server?.base==='USD'&&server.rates.KRW?server.rates.KRW:undefined;
  const typedRate=Number(typed)>0?Number(typed):undefined,rate=typedRate??serverRate??(snapshot.mode==='mock'?DEMO_RATE:undefined);
  const source=typedRate?'직접 입력':serverRate?'.env 설정':rate?'예시 환율':undefined;
  // Other currencies keep whatever rates the server was given, re-expressed against KRW.
  const others=server?Object.fromEntries(Object.entries(server.rates).filter(([c])=>c!=='USD'&&c!=='KRW').map(([c,v])=>[c,server.base==='KRW'?v:v*(rate??0)]).filter(([,v])=>Number(v)>0)):{};
  const fx:Fx|undefined=rate?{base:'KRW',rates:{...others,USD:rate},source:source!}:undefined;
  return{currency,setCurrency:(c:CostCurrency)=>{setCurrencyState(c);write('atlas.cost.currency',c);},rate,source,typed,setRate:(v:string)=>{setTyped(v);write('atlas.fx.usdkrw',Number(v)>0?v:'');},fx};
}
