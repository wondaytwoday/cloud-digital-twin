import type {Fx} from './cost.js';

const positive=(value:number|undefined)=>value!==undefined&&Number.isFinite(value)&&value>0?value:undefined;

// Fx rates mean one unit of the named currency in units of the base currency.
// Keep that base when adding the reader's USD/KRW rate, so other currencies retain their known relationships.
export function resolveCostFx(server:Fx|undefined,typed:string,fallbackRate?:number){
  const configured=server&&/^[A-Z]{3}$/.test(server.base)?{
    ...server,rates:Object.fromEntries(Object.entries(server.rates).filter(([,value])=>positive(value)!==undefined)),
  }:undefined;
  const inBase=(currency:string)=>currency===configured?.base?1:positive(configured?.rates[currency]);
  const usd=inBase('USD'),krw=inBase('KRW');
  const serverRate=usd&&krw?positive(usd/krw):undefined;
  const typedRate=positive(Number(typed)),demoRate=positive(fallbackRate);
  const rate=typedRate??serverRate??demoRate;
  const source=typedRate?'직접 입력':serverRate?'.env 설정':demoRate?'예시 환율':undefined;
  let fx:Fx|undefined=configured;
  if(rate&&(typedRate!==undefined||serverRate===undefined)){
    if(configured?.base==='USD'){
      const value=positive(1/rate);
      fx=value?{...configured,rates:{...configured.rates,KRW:value},source:source!}:undefined;
    }else if(configured&&krw){
      const value=positive(rate*krw);
      fx=value?{...configured,rates:{...configured.rates,USD:value},source:source!}:undefined;
    }else if(configured&&usd){
      const value=positive(usd/rate);
      fx=value?{...configured,rates:{...configured.rates,KRW:value},source:source!}:undefined;
    }else fx={base:'KRW',rates:{USD:rate},source:source!};
  }
  return{rate,source,fx};
}
