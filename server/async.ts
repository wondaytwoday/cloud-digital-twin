import {setTimeout as pause} from 'node:timers/promises';

export type Wait=(ms:number,signal?:AbortSignal)=>Promise<void>;
export const wait:Wait=async(ms,signal)=>{await pause(ms,undefined,{signal});};
export const positiveSetting=(value:string|undefined,fallback:number,max:number)=>{
  const n=Number(value);return Number.isFinite(n)&&n>0?Math.min(max,n):fallback;
};
const statusOf=(e:any)=>Number(e?.status??e?.response?.status??e?.$metadata?.httpStatusCode);
export const retryable=(e:unknown)=>{
  const status=statusOf(e),name=(e as Error)?.name??'';
  return status===429||status>=500||/Throttl|RequestLimitExceeded|TooManyRequests|ServiceUnavailable/.test(name)||
    (e instanceof TypeError&&/fetch|network/i.test(e.message));
};
export function retryDelay(headers:Headers|undefined,attempt:number,now=Date.now()){
  const delays=[2**(attempt+1)*1000];
  // Cost Management can throttle without the standard Retry-After header.
  if(headers)for(const [key,value] of headers){
    if(key==='retry-after'){
      const n=Number(value),ms=Number.isFinite(n)?n*1000:Date.parse(value)-now;
      if(Number.isFinite(ms)&&ms>=0)delays.push(ms);
    }else if(/^x-ms-ratelimit-microsoft\.costmanagement-.*-retry-after$/i.test(key)){
      const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)delays.push(seconds*1000);
    }
  }
  return Math.max(...delays);
}
export async function retry<T>(work:(attempt:number)=>Promise<T>,options:{signal?:AbortSignal;wait?:Wait;attempts?:number}={}):Promise<T>{
  const attempts=options.attempts??4;
  for(let attempt=0;;attempt++){
    options.signal?.throwIfAborted();
    try{return await work(attempt);}catch(e){
      if(options.signal?.aborted||attempt>=attempts-1||!retryable(e))throw e;
      const raw=(e as any)?.headers??(e as any)?.response?.headers;
      await (options.wait??wait)(retryDelay(raw?new Headers(raw):undefined,attempt),options.signal);
    }
  }
}
export async function fetchRetry(url:string,init:RequestInit,request:typeof fetch,options:{signal?:AbortSignal;wait?:Wait;timeoutMs?:number}={}){
  return retry(async attempt=>{
    // Retry-After waits do not consume the next request's timeout budget.
    const signals=[options.signal,init.signal,options.timeoutMs===undefined?undefined:AbortSignal.timeout(options.timeoutMs)].filter((s):s is AbortSignal=>!!s);
    const signal=signals.length>1?AbortSignal.any(signals):signals[0];
    const response=await request(url,{...init,signal});
    if((response.status===429||response.status>=500)&&attempt<3){
      await response.body?.cancel();
      throw Object.assign(new Error(`HTTP ${response.status}`),{status:response.status,headers:response.headers});
    }
    return response;
  },options);
}
export async function mapLimit<T,R>(items:readonly T[],limit:number,work:(item:T,index:number)=>Promise<R>,signal?:AbortSignal){
  const out:R[]=[];let next=0;
  const settled=await Promise.allSettled(Array.from({length:Math.min(Math.max(1,Math.floor(limit)),items.length)},async()=>{
    while(next<items.length){signal?.throwIfAborted();const i=next++;out[i]=await work(items[i],i);}
  }));
  const failed=settled.find((s):s is PromiseRejectedResult=>s.status==='rejected');if(failed)throw failed.reason;
  return out;
}
