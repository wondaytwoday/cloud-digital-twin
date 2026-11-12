import type {Resource,ResourceKind} from './schema.js';
import {health,type Health} from './topology.js';
// Collectors write sizes as display strings ("16 GiB", "1 × NVIDIA T4"), so the numbers are read back from them here.
const number=(v?:string)=>{const m=v?.replace(/,/g,'').match(/\d+(\.\d+)?/);return m?Number(m[0]):undefined;};
export const gpuCount=(v?:string)=>!v||/없음|미수집|필요/.test(v)?0:v.split(',').reduce((s,part)=>s+(number(part.split('×')[0])??0),0);
export type Capacity={vcpu?:number;memoryGiB?:number;diskGiB?:number;gpus:number;gpuModel?:string;size?:string};
export function capacityOf(r:Resource):Capacity{
  const s=r.specs,gpu=s['GPU'];
  return{vcpu:number(s['vCPU']),memoryGiB:number(s['메모리']),diskGiB:number(s['디스크']),gpus:gpuCount(gpu),gpuModel:gpuCount(gpu)?gpu.replace(/^\s*\d+\s*×\s*/,''):undefined,size:s['인스턴스']};
}
// Explain excluded capacity separately from known fallback values and stopped VMs.
export function capacityIssues(vms:Resource[]){
  const counts=new Map<string,number>();
  for(const r of vms){
    if(health(r.status)==='stopped')continue;
    const c=capacityOf(r),fallback=r.specs['크기 조회']==='내장표 폴백';
    if(!fallback&&c.vcpu!==undefined&&c.memoryGiB!==undefined)continue;
    const reason=fallback?`내장표 폴백 (${r.specs['크기 조회 사유']??'API 미조회'})`:r.specs['크기 조회 사유']??r.specs['크기 조회']??'크기 조회 정보 없음';
    counts.set(reason,(counts.get(reason)??0)+1);
  }
  return [...counts].map(([reason,count])=>({reason,count}));
}
// Categories follow how an operator looks for things, not the collector's kind list.
export const CATEGORIES=[
  {id:'compute',label:'컴퓨팅',kinds:['compute']},
  {id:'container',label:'컨테이너',kinds:['cluster']},
  {id:'data',label:'데이터·스토리지',kinds:['database','storage']},
  {id:'network',label:'네트워크',kinds:['network','subnet','endpoint','gateway','loadbalancer','nat','appliance','external','onprem']},
  {id:'security',label:'보안·정책',kinds:['firewall','security']},
  {id:'application',label:'애플리케이션',kinds:['application']},
  {id:'dns',label:'DNS',kinds:['dns']},
  {id:'monitoring',label:'모니터링·알림',kinds:['monitoring']},
  {id:'logging',label:'로그·감사',kinds:['logging']},
  {id:'analytics',label:'분석·데이터',kinds:['analytics']},
  {id:'configuration',label:'구성 관리',kinds:['configuration']},
  {id:'service',label:'기타 서비스',kinds:['service']},
] as const satisfies readonly {id:string;label:string;kinds:readonly ResourceKind[]}[];
export type CategoryId=typeof CATEGORIES[number]['id'];
export const categoryOf=(kind:ResourceKind):CategoryId=>CATEGORIES.find(c=>(c.kinds as readonly ResourceKind[]).includes(kind))!.id;
export type FleetTotals={count:number;running:number;stopped:number;warn:number;vcpu:number;memoryGiB:number;diskGiB:number;gpus:number;gpuHosts:number;unsized:number;undisked:number};
// Stopped machines keep their disks but not their cores, so only running capacity counts toward vCPU, memory and GPU.
export function fleetTotals(vms:Resource[]):FleetTotals{
  const t:FleetTotals={count:vms.length,running:0,stopped:0,warn:0,vcpu:0,memoryGiB:0,diskGiB:0,gpus:0,gpuHosts:0,unsized:0,undisked:0};
  for(const r of vms){
    const c=capacityOf(r),h=health(r.status),on=h!=='stopped';
    if(h==='stopped')t.stopped++;else t.running++;if(h==='warn')t.warn++;
    if(c.vcpu===undefined)t.unsized++;
    if(c.diskGiB===undefined)t.undisked++;else t.diskGiB+=c.diskGiB;
    if(on){t.vcpu+=c.vcpu??0;t.memoryGiB+=c.memoryGiB??0;t.gpus+=c.gpus;if(c.gpus)t.gpuHosts++;}
  }
  return t;
}
export const statusCounts=(rows:Resource[])=>{const out:Record<Health,number>={ok:0,warn:0,stopped:0,unknown:0,neutral:0};for(const r of rows)out[health(r.status)]++;return out;};
export function countBy<T>(rows:T[],key:(r:T)=>string|undefined){const m=new Map<string,number>();for(const r of rows){const k=key(r);if(k)m.set(k,(m.get(k)??0)+1);}return [...m].sort((a,b)=>b[1]-a[1]);}
