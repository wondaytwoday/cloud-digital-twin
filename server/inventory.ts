import {collectionTier} from '../shared/classification.js';
import type {InventorySummary,Snapshot} from '../shared/schema.js';
import type {Normalized} from './normalize.js';
export function compactInventory(result:Normalized,previous:Snapshot|null=null,mode:'summary'|'full'=process.env.ATLAS_INVENTORY_MODE==='full'?'full':'summary'):Normalized{
  const retainedSummaries=(previous?.inventorySummary??[])
    .filter(old=>result.incomplete?.includes(old.scope))
    .map(old=>({...old,retained:true,collectedAt:old.collectedAt??previous!.collectedAt}));
  if(mode==='full')return{...result,inventoryMode:mode,inventorySummary:retainedSummaries};
  // Referenced endpoints, policies, parents and resources with rule evidence are never summarized away.
  const referenced=new Set([...result.links.flatMap(l=>[l.source,l.target]),...result.resources.flatMap(r=>r.parent?[r.parent]:[])]);
  const groups=new Map<string,InventorySummary>(),resources=result.resources.filter(r=>{
    const tier=collectionTier(r);
    if(tier===1||referenced.has(r.id)||r.rules.length)return true;
    const key=JSON.stringify([r.provider,r.scope,r.type]);
    let group=groups.get(key);
    if(!group){group={provider:r.provider,scope:r.scope,type:r.type,tier,count:0,examples:[]};groups.set(key,group);}
    group.count++;if(group.examples.length<3)group.examples.push({id:r.id,name:r.name});
    return false;
  });
  // Counts cannot be merged by identity after summarization. A partial scope must
  // keep its last complete summary, even when the partial read found this type.
  for(const old of retainedSummaries){
    const key=JSON.stringify([old.provider,old.scope,old.type]);
    groups.set(key,old);
  }
  return{...result,resources,inventoryMode:mode,inventorySummary:[...groups.values()]};
}
