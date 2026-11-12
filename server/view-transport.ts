import {createHash} from 'node:crypto';
import type {Snapshot} from '../shared/schema.js';
import type {ViewTransport} from '../shared/view-transport.js';

const cache=new WeakMap<Snapshot,{full:ViewTransport;reused:ViewTransport}>();
// The caller must supply the already access-restricted representation. This is
// a content revision, independent of collection progress and HTTP encoding.
export function viewTransport(snapshot:Snapshot,base:string|undefined):ViewTransport{
  let entry=cache.get(snapshot);
  if(!entry){
    const {resources,links,...metadata}=snapshot;
    const revision=createHash('sha256').update(JSON.stringify([snapshot.mode,resources,links])).digest('hex');
    entry={full:{transport:1,revision,snapshot},reused:{transport:1,revision,metadata}};
    cache.set(snapshot,entry);
  }
  return snapshot.resources.length&&base===entry.full.revision?entry.reused:entry.full;
}
