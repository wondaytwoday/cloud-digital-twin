import type { Link, Resource } from './schema.js';
export type Graph = Map<string, Set<string>>;
export type Health = 'ok'|'stopped'|'warn'|'unknown'|'neutral';
const STOPPED=new Set(['stopped','stopping','deallocated','deallocating','terminated','suspended','paused']);
const WARN=new Set(['degraded','failed','failure','error','down','unhealthy','inactive','unavailable','impaired']);
const OK=new Set(['running','succeeded','available','enabled','runnable','active','provisioned','up','ready','established','attached']);
// Whole words only: "inactive" and "unavailable" must not read as healthy because they contain a healthy word.
export function health(status:string):Health{
  if(status.includes('권한'))return 'unknown';
  const words=status.toLowerCase().split(/[^a-z0-9]+/);
  if(words.some(w=>STOPPED.has(w)))return 'stopped';
  if(words.some(w=>WARN.has(w)))return 'warn';
  return words.some(w=>OK.has(w))?'ok':'neutral';
}
// Attachments that carry packets join network things; a disk or an identity attached to a VM is a dependency, not a hop.
const NOT_A_HOP=new Set<Resource['kind']>(['disk','fileshare','bucket','identity','serviceaccount','pvc','pv','firewall']);
export const carriesTraffic=(l:Link,byId:Map<string,Resource>)=>(l.kind==='attachment'||l.kind==='peering'||l.kind==='private_link'||l.kind==='route')&&!NOT_A_HOP.has(byId.get(l.source)?.kind as Resource['kind'])&&!NOT_A_HOP.has(byId.get(l.target)?.kind as Resource['kind']);
// Layout and on-prem reachability graph: containment plus configured links. This is a drawing aid, not a statement that traffic flows;
// the flow analyser in shared/flow.ts decides that from routes and policies.
export function adjacency(resources:Resource[],links:Link[]):Graph{
  const graph:Graph=new Map(),ids=new Set<string>();
  for(const r of resources)if(r.kind!=='firewall'){ids.add(r.id);graph.set(r.id,new Set());}
  const join=(a:string,b:string)=>{if(ids.has(a)&&ids.has(b)){graph.get(a)!.add(b);graph.get(b)!.add(a);}};
  const byId=new Map(resources.map(r=>[r.id,r]));
  for(const r of resources)if(r.parent)join(r.id,r.parent);
  for(const l of links)if(l.kind!=='route'&&carriesTraffic(l,byId))join(l.source,l.target);
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
/* Routing model. VPC/VNet peering is not transitive, so a walk carries how it got here:
   L started inside this network; P crossed a peering that may use the remote gateway; Q crossed a plain peering;
   X arrived from outside any network, through a gateway. Only L and transit X may cross a peering, and Q may never leave. */
type State='L'|'P'|'Q'|'X';
export type RoutingModel={resources:Resource[];links:Link[]};
function buildRouting({resources,links}:RoutingModel){
  const all=new Map(resources.map(r=>[r.id,r])),byId=new Map(resources.filter(r=>!NOT_A_HOP.has(r.kind)).map(r=>[r.id,r]));
  const networkOf=(id:string)=>{for(let c=byId.get(id);c;c=c.parent?byId.get(c.parent):undefined)if(c.kind==='network')return c.id;return undefined;};
  const edges=new Map<string,{to:string;kind:'contain'|'attachment'|'peering'|'route'|'private_link';transit?:boolean}[]>();
  const add=(a:string,b:string,kind:'contain'|'attachment'|'peering'|'route'|'private_link',transit?:boolean)=>{if(!byId.has(a)||!byId.has(b))return;(edges.get(a)??edges.set(a,[]).get(a)!).push({to:b,kind,transit});if(kind!=='route')(edges.get(b)??edges.set(b,[]).get(b)!).push({to:a,kind,transit});};
  for(const r of byId.values())if(r.parent)add(r.id,r.parent,'contain');
  for(const l of links)if(carriesTraffic(l,all))add(l.source,l.target,l.kind as 'attachment'|'peering'|'route'|'private_link',l.transit);
  const step=(state:State,from:string,e:{to:string;kind:string;transit?:boolean}):State|null=>{
    if(e.kind==='contain')return state;
    // A UDR hands traffic that starts in this network to a router, which decides afresh inside the hub. One way, and never for transit traffic.
    if(e.kind==='route')return state==='L'?'L':null;
    if(e.kind==='peering'){
      // Gateway peering (TGW to TGW) routes transitively; everything else, including unreadable peers, follows network rules.
      if(byId.get(from)?.kind==='gateway'&&byId.get(e.to)?.kind==='gateway')return state;
      if(state==='L')return e.transit?'P':'Q';
      if(state==='X')return e.transit?'Q':null;
      return null;
    }
    const a=networkOf(from),b=networkOf(e.to);
    if(a&&a===b)return state;
    if(state==='Q')return null;
    return 'X';
  };
  const start=(id:string):State=>networkOf(id)?'L':'X';
  return{byId,edges,step,start};
}
type Routing=ReturnType<typeof buildRouting>;
function walk(r:Routing,sources:string[],visit:(id:string,prev:Map<string,string|null>,key:string)=>boolean){
  const prev=new Map<string,string|null>(),queue:string[]=[];
  for(const s of sources)if(r.byId.has(s)){const key=`${s}|${r.start(s)}`;prev.set(key,null);queue.push(key);}
  for(let i=0;i<queue.length;i++){
    const key=queue[i],bar=key.lastIndexOf('|'),id=key.slice(0,bar),state=key.slice(bar+1) as State;
    if(visit(id,prev,key))return;
    // No U-turns: reaching a circuit and coming straight back is not a route between two spokes.
    const parentKey=prev.get(key),cameFrom=parentKey?parentKey.slice(0,parentKey.lastIndexOf('|')):undefined;
    for(const e of r.edges.get(id)??[]){if(e.to===cameFrom)continue;const next=r.step(state,id,e);if(!next)continue;const k=`${e.to}|${next}`;if(!prev.has(k)){prev.set(k,key);queue.push(k);}}
  }
}
export function reachable(model:RoutingModel,sources:string[]){
  const seen=new Set<string>();walk(buildRouting(model),sources,id=>{seen.add(id);return false;});return seen;
}
// Shortest candidate route to the nearest target, inclusive of both ends. Respects non-transitive peering.
export function findPath(model:RoutingModel,from:string,targets:string[]):string[]{
  const goal=new Set(targets);let path:string[]=[];
  walk(buildRouting(model),[from],(id,prev,key)=>{
    if(!goal.has(id))return false;
    const out:string[]=[];for(let c:string|null=key;c;c=prev.get(c)??null)out.unshift(c.slice(0,c.lastIndexOf('|')));
    path=out.filter((x,i)=>x!==out[i-1]);return true;
  });
  return path;
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
  const before=reachable({resources,links},ingress);
  const remaining=resources.filter(r=>!removed.has(r.id)),after=reachable({resources:remaining,links},ingress.filter(i=>!removed.has(i)));
  const lost=remaining.filter(r=>before.has(r.id)&&!after.has(r.id)).map(r=>r.id);
  return {removed:[...removed],lost};
}
const WIDE=/^(0\.0\.0\.0\/0|\*|internet|::\/0)$/i;
export const isWideInbound=(rule:Resource['rules'][number])=>rule.action==='Allow'&&/inbound|ingress/i.test(rule.direction)&&rule.source.split(/,\s*/).some(s=>WIDE.test(s.trim()));
export const isPublic=(r:Resource)=>!!r.publicIp||r.specs['공개 범위']==='internet-facing';
// Candidates only: a public address plus a wide rule says nothing about routing, listeners, or the app behind them.
export function exposures(resources:Resource[],links:Link[]){
  const byId=new Map(resources.map(r=>[r.id,r])),on=new Map<string,string[]>();
  for(const l of links)if(l.kind==='policy')(on.get(l.target)??on.set(l.target,[]).get(l.target)!).push(l.source);
  // A NIC is judged as part of its VM: the VM's chain includes its NICs, which is where Azure NIC NSGs and AWS ENI groups are attached.
  const nicsOf=new Map<string,string[]>();for(const l of links)if(l.kind==='attachment'&&byId.get(l.target)?.kind==='nic')(nicsOf.get(l.source)??nicsOf.set(l.source,[]).get(l.source)!).push(l.target);
  return resources.filter(r=>isPublic(r)&&r.kind!=='nic').flatMap(r=>{
    const chain=[r.id,...ancestors(byId,r.id),...(nicsOf.get(r.id)??[]).flatMap(n=>[n,...ancestors(byId,n)])],policies=[...new Set(chain.flatMap(id=>on.get(id)??[]))].map(id=>byId.get(id)).filter((p):p is Resource=>!!p);
    const rules=policies.flatMap(p=>p.rules.filter(isWideInbound).map(rule=>({policy:p.name,rule})));
    return rules.length?[{resource:r,rules}]:[];
  });
}
