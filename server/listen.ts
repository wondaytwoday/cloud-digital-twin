import {accessEntries} from './auth.js';
// Where the server listens, decided before it starts. Loopback stays the default; a shared server is an explicit choice that must bring access control.
export type BindPlan={host:string;loopbackOnly:boolean;trustProxy?:string|number;error?:string};
const LOOPBACK=new Set(['127.0.0.1','::1','localhost']);
export function bindPlan(env:NodeJS.ProcessEnv):BindPlan{
  const host=env.ATLAS_HOST?.trim()||'127.0.0.1',loopbackOnly=LOOPBACK.has(host),raw=env.ATLAS_TRUST_PROXY?.trim();
  // Trusting every hop would let any client name its own address in X-Forwarded-For and walk past the sign-in attempt limit and the audit trail.
  if(raw&&/^(true|\*)$/i.test(raw))return{host,loopbackOnly,error:'ATLAS_TRUST_PROXY에 모든 프록시를 신뢰하는 값은 쓸 수 없습니다. 리버스 프록시의 주소(예: 10.0.0.5, loopback)나 홉 수(예: 1)를 지정하세요.'};
  const trustProxy=!raw?undefined:/^\d+$/.test(raw)?Number(raw):raw;
  if(loopbackOnly)return{host,loopbackOnly,trustProxy};
  if(env.DATA_MODE==='live'){
    let entries=0;try{entries=accessEntries(env).length;}catch{return{host,loopbackOnly,error:'ACCESS_TOKENS 형식이 올바르지 않습니다. 공유 서버는 접근 제어 없이 시작하지 않습니다.'};}
    if(!entries)return{host,loopbackOnly,error:`${host}에서 실제 데이터를 제공하려면 ACCESS_TOKENS가 필요합니다. 접근 제어 없이 공유 주소로 열지 않습니다.`};
  }
  return{host,loopbackOnly,trustProxy};
}
