import {ResourceKind,type Provider,type Resource} from './schema.js';

type Classification={kind:ResourceKind;auxiliary?:boolean};
import mappings from './resource-types.json' with {type:'json'};
// Exact provider type mappings are data; unregistered types remain visible.
export const RESOURCE_CLASSIFICATIONS=new Map<string,Classification>(Object.entries(mappings).map(([type,value])=>[type,{kind:ResourceKind.parse(value.kind),...('auxiliary' in value?{auxiliary:value.auxiliary}:{})}]));
const tiers=new Map<string,number>(Object.entries(mappings).map(([type,value])=>[type,value.tier]));
export const classifyResource=(provider:Provider,type:string):Classification=>RESOURCE_CLASSIFICATIONS.get(`${provider}:${type.toLowerCase()}`)??{kind:'service'};
export const isAuxiliary=(r:Pick<Resource,'provider'|'type'|'auxiliary'>)=>r.auxiliary??classifyResource(r.provider,r.type).auxiliary??false;
const NETWORK_KINDS=new Set<ResourceKind>(['network','subnet','endpoint','gateway','appliance','loadbalancer','nat','onprem','external','firewall']);
export const isNetworkResource=(r:Pick<Resource,'kind'>)=>NETWORK_KINDS.has(r.kind);
export const classificationSummary=(resources:Resource[])=>{
  const counts=new Map<string,number>();
  for(const r of resources)if(r.kind==='service')counts.set(`${r.provider}:${r.type}`,(counts.get(`${r.provider}:${r.type}`)??0)+1);
  return [...counts].map(([type,count])=>({type,count})).sort((a,b)=>b.count-a.count||a.type.localeCompare(b.type)).slice(0,10);
};

// Security policies and unknown types are always retained; never optimize away evidence.
export const collectionTier=(r:Pick<Resource,'provider'|'type'|'auxiliary'|'kind'>):1|2|3=>{
  if(r.kind==='firewall'||r.kind==='security'||r.kind==='service')return 1;
  const configured=tiers.get(`${r.provider}:${r.type.toLowerCase()}`);
  if(configured===1||configured===2||configured===3)return configured;
  return isAuxiliary(r)&&r.kind==='configuration'?3:['dns','monitoring','logging'].includes(r.kind)||isAuxiliary(r)?2:1;
};
