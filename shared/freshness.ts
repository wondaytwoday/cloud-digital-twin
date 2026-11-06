import type {Resource} from './schema.js';
// How old a cloud's data may get before the portal calls it out. Three missed runs, never less than three hours; a day when nothing runs on a timer.
export function staleAfterHours(env:Record<string,string|undefined>){
  const set=Number(env.ATLAS_STALE_HOURS);if(set>0)return set;
  const minutes=Number(env.ATLAS_COLLECT_MINUTES??60);
  return minutes>0?Math.max(3,minutes*3/60):24;
}
export const isStale=(collectedAt:string|undefined,hours:number,now=Date.now())=>!!collectedAt&&now-Date.parse(collectedAt)>hours*3_600_000;
export function age(at:string,now=Date.now()){
  const minutes=Math.max(0,Math.round((now-Date.parse(at))/60_000));
  return minutes<1?'방금':minutes<60?`${minutes}분 전`:minutes<48*60?`${Math.round(minutes/60)}시간 전`:`${Math.round(minutes/1440)}일 전`;
}
// One definition of "how many resources", so every page either shows the same number or says what it leaves out.
// Subnets and security policies (NSGs, security groups, firewall rules) are configuration of a network, not things that run; on-prem sites and unreadable peers are not inventory.
export function resourceCounts(resources:Resource[]){
  const inventory=resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external'),subnets=inventory.filter(r=>r.kind==='subnet').length,policies=inventory.filter(r=>r.kind==='firewall').length;
  return{all:inventory.length,primary:inventory.length-subnets-policies,subnets,policies};
}
export const countDefinition=(c:ReturnType<typeof resourceCounts>)=>`서브넷 ${c.subnets.toLocaleString('ko-KR')}개와 보안 정책(NSG·보안 그룹·방화벽 규칙) ${c.policies.toLocaleString('ko-KR')}개를 포함하면 ${c.all.toLocaleString('ko-KR')}개입니다. 사내망과 조회 권한이 없는 외부 참조는 세지 않습니다.`;
