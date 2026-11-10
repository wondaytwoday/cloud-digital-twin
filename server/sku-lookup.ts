import type {Resource} from '../shared/schema.js';
import {fetchRetry,mapLimit,type Wait} from './async.js';
import {skuSpecs,type Sku} from './skus.js';

type Options={signal?:AbortSignal;wait?:Wait};
type Lookup={sku?:Sku;reason?:string};
const positive=(value:unknown)=>{const n=Number(value);return Number.isFinite(n)&&n>0?n:undefined;};
function failure(error:any){
  const status=Number(error?.status??error?.response?.status??error?.code);
  if(status===401||status===403)return '조회 실패: 권한 또는 API 설정 확인';
  if(status===404)return '알 수 없는 크기';
  if(status===429)return '조회 실패: 속도 제한';
  if(error?.name==='TimeoutError')return '조회 실패: 요청 시간 초과';
  return '조회 실패: API 응답 또는 네트워크 확인';
}
function apply(resource:Resource,result:Lookup,source:string){
  const attachedGpu=resource.provider==='gcp'&&resource.specs.GPU!=='없음'?resource.specs.GPU:undefined;
  if(result.sku){
    Object.assign(resource.specs,skuSpecs(result.sku),{'크기 조회':source});
    if(attachedGpu)resource.specs.GPU=attachedGpu;
    delete resource.specs['크기 조회 사유'];
  }else{
    // Keep a known offline fallback, but never put error codes into numeric fields.
    const fallback=resource.specs['크기 조회']==='내장표 폴백';
    resource.specs['크기 조회']=fallback?'내장표 폴백':result.reason??'알 수 없는 크기';
    resource.specs['크기 조회 사유']=result.reason??'알 수 없는 크기';
  }
}

// Cache lifetime is one collection: credentials and failed responses never leak between runs.
export async function enrichAzureSizes(resources:Resource[],token:()=>Promise<string>,request:typeof fetch,options:Options={}){
  const groups=new Map<string,Resource[]>();
  for(const r of resources.filter(r=>r.provider==='azure'&&r.kind==='compute')){
    const key=JSON.stringify([r.scope,r.region.toLowerCase()]);
    const group=groups.get(key);if(group)group.push(r);else groups.set(key,[r]);
  }
  await mapLimit([...groups.values()],2,async vms=>{
    const {scope,region}=vms[0],catalog=new Map<string,Sku>();let reason:string|undefined;
    const path=`/subscriptions/${encodeURIComponent(scope)}/providers/Microsoft.Compute/skus`;
    let url:string|undefined=`https://management.azure.com${path}?api-version=2021-07-01&$filter=${encodeURIComponent(`location eq '${region.replace(/'/g,"''")}'`)}`;
    const seen=new Set<string>();
    try{
      while(url){
        const next=new URL(url);
        if(next.origin!=='https://management.azure.com'||next.pathname.toLowerCase()!==path.toLowerCase()||next.username||next.password||seen.has(url))throw new Error('Invalid SKU continuation');
        seen.add(url);
        const response=await fetchRetry(url,{headers:{Authorization:`Bearer ${await token()}`},redirect:'error'},request,{...options,timeoutMs:30_000});
        if(!response.ok)throw Object.assign(new Error('SKU request failed'),{status:response.status});
        const body=await response.json();if(!Array.isArray(body.value))throw new Error('Invalid SKU response');
        for(const row of body.value){
          if(String(row.resourceType).toLowerCase()!=='virtualmachines'||typeof row.name!=='string')continue;
          const caps=new Map<string,unknown>((row.capabilities??[]).map((c:any)=>[String(c.name).toLowerCase(),c.value]));
          // Constrained-vCPU SKUs expose fewer usable cores than the family size.
          const vcpu=positive(caps.get('vcpusavailable'))??positive(caps.get('vcpus')),memoryGiB=positive(caps.get('memorygb')),gpus=positive(caps.get('gpus'));
          if(vcpu&&memoryGiB)catalog.set(row.name.toLowerCase(),{vcpu,memoryGiB,...(gpus?{gpu:`${gpus} × GPU (모델 미제공)`}:{})});
        }
        url=body.nextLink||undefined;
      }
    }catch(e){options.signal?.throwIfAborted();reason=failure(e);}
    // A failed later page cannot prove that an absent SKU does not exist.
    for(const r of vms)apply(r,{sku:catalog.get(r.specs['인스턴스']?.toLowerCase()),reason},'Azure Resource SKUs');
  },options.signal);
}

// Explicit custom type names encode MiB. Do not extrapolate unfamiliar families.
export function customGcpSize(name:string):Sku|undefined{
  const match=name.match(/^(?:(?:n2|n2d|e2|n4)-)?custom-(\d+)-(\d+)(?:-ext)?$/);
  if(!match)return;
  const vcpu=positive(match[1]),memory=positive(match[2]);
  return vcpu&&memory?{vcpu,memoryGiB:memory/1024}:undefined;
}
export async function enrichGcpSizes(resources:Resource[],request:(url:string)=>Promise<any>,options:Options={}){
  const cache=new Map<string,Promise<Lookup>>();
  await mapLimit(resources.filter(r=>r.provider==='gcp'&&r.kind==='compute'),4,async r=>{
    const machine=r.specs['인스턴스'],custom=customGcpSize(machine);
    if(custom){apply(r,{sku:custom},'맞춤형 머신 이름');return;}
    const zone=r.nativeId.match(/\/zones\/([^/]+)\//)?.[1];
    if(!zone||!machine||machine==='미확인'){apply(r,{reason:'알 수 없는 크기 또는 영역'},'');return;}
    const url=`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(r.scope)}/zones/${encodeURIComponent(zone)}/machineTypes/${encodeURIComponent(machine)}`;
    let lookup=cache.get(url);
    if(!lookup){
      lookup=(async():Promise<Lookup>=>{
        try{
          const body=await request(url),vcpu=positive(body.guestCpus),memory=positive(body.memoryMb);
          if(!vcpu||!memory)throw new Error('Invalid machine type response');
          const accelerators=body.accelerators??[];
          const gpu=accelerators.map((a:any)=>{const n=positive(a.guestAcceleratorCount);return n?`${n} × ${String(a.guestAcceleratorType??'GPU (모델 미제공)').split('/').pop()}`:undefined;}).filter(Boolean).join(', ');
          return{sku:{vcpu,memoryGiB:memory/1024,...(gpu?{gpu}:{})}};
        }catch(e){options.signal?.throwIfAborted();return{reason:failure(e)};}
      })();cache.set(url,lookup);
    }
    apply(r,await lookup,'GCP machineTypes.get');
  },options.signal);
}
