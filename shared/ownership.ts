import type {Resource} from './schema.js';
// Who answers for a resource and what it serves, read from tags. Every organisation spells these differently, so the keys are configurable; these are the common spellings.
export const DEFAULT_OWNERSHIP_KEYS={owner:['owner','team','owner-team','담당자','담당팀'],service:['service','app','application','system','workload','서비스']};
export type OwnershipKeys=typeof DEFAULT_OWNERSHIP_KEYS;
const list=(v:string|undefined)=>{const out=v?.split(',').map(x=>x.trim()).filter(Boolean);return out?.length?out:undefined;};
export function ownershipKeys(env:Record<string,string|undefined>):OwnershipKeys{
  return{owner:list(env.ATLAS_OWNER_TAGS)??DEFAULT_OWNERSHIP_KEYS.owner,service:list(env.ATLAS_SERVICE_TAGS)??DEFAULT_OWNERSHIP_KEYS.service};
}
export type Ownership={owner?:string;service?:string;ownerFrom?:string;serviceFrom?:string};
// Keys are compared without case: Azure and AWS keep the case a person typed, GCP labels are always lower case.
const pick=(tags:Record<string,string>,keys:string[])=>{const lower=new Map(Object.entries(tags).map(([k,v])=>[k.toLowerCase(),v]));for(const k of keys){const v=lower.get(k.toLowerCase())?.trim();if(v)return v;}return undefined;};
// A resource without its own tag takes its parent's: a subnet belongs to whoever owns its network. ownerFrom names the resource the value came from.
export function ownershipOf(r:Resource,byId:Map<string,Resource>,keys:OwnershipKeys=DEFAULT_OWNERSHIP_KEYS):Ownership{
  const out:Ownership={},seen=new Set<string>();
  for(let c:Resource|undefined=r;c&&!seen.has(c.id)&&(!out.owner||!out.service);c=c.parent?byId.get(c.parent):undefined){
    seen.add(c.id);
    if(!out.owner){const v=pick(c.tags,keys.owner);if(v){out.owner=v;if(c!==r)out.ownerFrom=c.name;}}
    if(!out.service){const v=pick(c.tags,keys.service);if(v){out.service=v;if(c!==r)out.serviceFrom=c.name;}}
  }
  return out;
}
