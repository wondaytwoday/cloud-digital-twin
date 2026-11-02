import type { Link, Resource } from './schema.js';
export type Graph = Map<string, Set<string>>;
export type Health = 'ok'|'stopped'|'warn'|'unknown'|'neutral';
export function health(status:string):Health{
  const s=status.toLowerCase();
  if(/stopped|deallocated|terminated|stopping|suspended/.test(s))return 'stopped';
  if(/degraded|failed|error|down|unhealthy/.test(s))return 'warn';
  if(s.includes('권한'))return 'unknown';
  if(/running|succeeded|available|enabled|runnable|active|provisioned|up/.test(s))return 'ok';
  return 'neutral';
}
// Connectivity graph: containment plus configured links. Policies and simulated flows are not hops.
export function adjacency(resources:Resource[],links:Link[]):Graph{
  const graph:Graph=new Map(),ids=new Set<string>();
  for(const r of resources)if(r.kind!=='firewall'){ids.add(r.id);graph.set(r.id,new Set());}
  const join=(a:string,b:string)=>{if(ids.has(a)&&ids.has(b)){graph.get(a)!.add(b);graph.get(b)!.add(a);}};
  for(const r of resources)if(r.parent)join(r.id,r.parent);
  for(const l of links)if(l.kind==='attachment'||l.kind==='peering')join(l.source,l.target);
  return graph;
}
export function ingressIds(resources:Resource[]){
  const onprem=resources.filter(r=>r.kind==='onprem').map(r=>r.id);
  return onprem.length?onprem:resources.filter(r=>r.kind==='gateway'&&!r.parent).map(r=>r.id);
}
export function distances(graph:Graph,sources:string[]){
  const dist=new Map(sources.filter(s=>graph.has(s)).map(s=>[s,0]));let frontier=[...dist.keys()];
  while(frontier.length){const next:string[]=[];for(const id of frontier)for(const n of graph.get(id)??[])if(!dist.has(n)){dist.set(n,dist.get(id)!+1);next.push(n);}frontier=next;}
  return dist;
}
// Shortest configured path from one node to the nearest of the targets, inclusive of both ends.
export function findPath(graph:Graph,from:string,targets:string[]):string[]{
  const goal=new Set(targets);if(!graph.has(from))return [];
  const prev=new Map<string,string|null>([[from,null]]);let frontier=[from];
  while(frontier.length){
    const next:string[]=[];
    for(const id of frontier){
      if(goal.has(id)){const path:string[]=[];for(let c:string|null=id;c;c=prev.get(c)??null)path.unshift(c);return path;}
      for(const n of graph.get(id)??[])if(!prev.has(n)){prev.set(n,id);next.push(n);}
    }
    frontier=next;
  }
  return [];
}
export function descendants(resources:Resource[],id:string){
  const out=new Set([id]);let grew=true;
  while(grew){grew=false;for(const r of resources)if(r.parent&&out.has(r.parent)&&!out.has(r.id)){out.add(r.id);grew=true;}}
  return out;
}
export function ancestors(byId:Map<string,Resource>,id:string){
  const out:string[]=[];for(let c=byId.get(id)?.parent;c;c=byId.get(c)?.parent)out.push(c);
  return out;
}
// What loses every configured route to on-prem if this node disappears. Redundant paths keep a resource out of the list.
export function impactOf(resources:Resource[],links:Link[],id:string){
  const removed=descendants(resources,id),ingress=ingressIds(resources);
  const before=distances(adjacency(resources,links),ingress);
  const remaining=resources.filter(r=>!removed.has(r.id)),after=distances(adjacency(remaining,links),ingress.filter(i=>!removed.has(i)));
  const lost=remaining.filter(r=>before.has(r.id)&&!after.has(r.id)).map(r=>r.id);
  return {removed:[...removed],lost};
}
