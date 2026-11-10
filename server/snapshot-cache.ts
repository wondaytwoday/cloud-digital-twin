import type {Snapshot} from '../shared/schema.js';
import type {SnapshotStore} from './store.js';
export function snapshotCache(build:(store:SnapshotStore)=>Promise<Snapshot|null>){
  const entries=new WeakMap<SnapshotStore,{revision:string;value:Promise<Snapshot|null>}>();
  return async(store:SnapshotStore)=>{
    if(!store.revision)return build(store);
    const revision=await store.revision(),previous=entries.get(store);
    if(previous?.revision===revision)return previous.value;
    const value=build(store);entries.set(store,{revision,value});
    try{return await value;}catch(e){if(entries.get(store)?.value===value)entries.delete(store);throw e;}
  };
}
