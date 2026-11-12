import type {Resource,Snapshot} from './schema.js';

const indexes=new WeakMap<Snapshot,Map<string,string>>();
export const searchKey=(value:string)=>value.normalize('NFC').trim().toLocaleLowerCase('ko-KR');
export function resourceSearchIndex(snapshot:Snapshot){
  let index=indexes.get(snapshot);
  if(!index){
    index=new Map(snapshot.resources.map(r=>[r.id,searchKey(`${r.name} ${r.ip??''} ${r.cidr??''} ${r.type} ${snapshot.scopeLabels[r.scope]??''}`)]));
    indexes.set(snapshot,index);
  }
  return index;
}
export function searchResources(snapshot:Snapshot,query:string,limit=10):Resource[]{
  const key=searchKey(query),found:Resource[]=[];
  if(!key||limit<=0)return found;
  const index=resourceSearchIndex(snapshot);
  for(const r of snapshot.resources){
    if(index.get(r.id)?.includes(key))found.push(r);
    if(found.length>=limit)break;
  }
  return found;
}
