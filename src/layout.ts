import type {ElkNode} from 'elkjs/lib/elk-api';
import type {Link,Resource,ResourceKind,Snapshot} from '../shared/schema';
import {adjacency,distances,findPath,health,ingressIds} from '../shared/topology';
export type Variant='provider'|'region'|'network'|'subnet';
export type Filter={provider:string;scopes:Set<string>|null;policy:boolean;flow:boolean;expanded:Set<string>};
export type Item={id:string;parent?:string;resource?:Resource;variant?:Variant;label:string;subtitle?:string;provider:string;outOfScope?:boolean};
export type Summary={total:number;stopped:number;warn:number;counts:Partial<Record<ResourceKind,number>>};
export type Placed={id:string;x:number;y:number;width:number;height:number;depth:number;item:Item;collapsed:boolean;expandable:boolean;summary:Summary;policies:number;hub:boolean};
export type Bundle={id:string;source:string;target:string;links:Link[];kind:'hybrid'|'peering'|'attachment'|'policy'|'simulation';hasFlow:boolean;label:string;points:{x:number;y:number}[]};
export type Topology={nodes:Placed[];edges:Bundle[];rollup:(id:string)=>string|undefined};
export const providerNames:Record<string,string>={azure:'Microsoft Azure',aws:'Amazon Web Services',gcp:'Google Cloud',onprem:'On-premises'};
export const scopeNouns:Record<string,string>={azure:'구독',aws:'계정',gcp:'프로젝트'};
const CARD={width:204,height:60},SUMMARY={width:236,height:92},SUBNET_SUMMARY={width:204,height:60};
const PADDING_TOP:Record<Variant,number>={provider:58,region:44,network:50,subnet:40};
const kindOrder:ResourceKind[]=['gateway','appliance','loadbalancer','nat','cluster','compute','database','storage','firewall','external','subnet','network','onprem'];
export const regionId=(r:Pick<Resource,'provider'|'region'>)=>`region:${r.provider}:${r.region}`;
// Large environments open at the summary level; small ones have nothing worth hiding.
export const startingLevel=(count:number)=>count<=30?2:count<=90?1:0;
export function defaultExpanded(snapshot:Snapshot,level:number){
  const out=new Set<string>();
  for(const p of ['azure','aws','gcp'])out.add(`provider:${p}`);
  for(const r of snapshot.resources)out.add(regionId(r));
  for(const r of snapshot.resources){if(level>=1&&r.kind==='network')out.add(r.id);if(level>=2&&r.kind==='subnet')out.add(r.id);}
  return out;
}
// Chooses what stays visible. Scope filters keep the out-of-scope route to on-prem, collapsed, so circuits never look disconnected.
function selectResources(snapshot:Snapshot,f:Filter){
  const matches=(r:Resource)=>(f.provider==='all'||r.provider===f.provider||r.provider==='onprem')&&(!f.scopes||f.scopes.has(r.scope));
  const keep=new Map(snapshot.resources.filter(matches).map(r=>[r.id,r])),outside=new Set<string>(),byId=new Map(snapshot.resources.map(r=>[r.id,r]));
  if(!f.scopes)return{keep,outside};
  const graph=adjacency(snapshot.resources,snapshot.links),ingress=ingressIds(snapshot.resources);
  for(const r of [...keep.values()].filter(r=>r.kind==='network'))for(const hop of findPath(graph,r.id,ingress))if(!keep.has(hop)){keep.set(hop,byId.get(hop)!);outside.add(hop);}
  for(const id of [...keep.keys()])for(let p=byId.get(id)?.parent;p;p=byId.get(p)?.parent)if(!keep.has(p)){keep.set(p,byId.get(p)!);outside.add(p);}
  return{keep,outside};
}
function buildItems(snapshot:Snapshot,f:Filter){
  const {keep,outside}=selectResources(snapshot,f),items=new Map<string,Item>();
  const ensure=(item:Item)=>{if(!items.has(item.id))items.set(item.id,item);return item.id;};
  const provider=(p:string)=>ensure({id:`provider:${p}`,variant:'provider',label:providerNames[p],provider:p});
  // Region frames only earn their space once a provider really spans regions; global VPCs stay directly under the provider.
  const regionsOf=new Map<string,Set<string>>();
  for(const r of keep.values())if(!(r.parent&&keep.has(r.parent))&&r.region!=='global'&&r.region!=='미확인')(regionsOf.get(r.provider)??regionsOf.set(r.provider,new Set()).get(r.provider)!).add(r.region);
  const topLevel=(r:Resource)=>(regionsOf.get(r.provider)?.size??0)>=2&&regionsOf.get(r.provider)!.has(r.region)?ensure({id:regionId(r),parent:provider(r.provider),variant:'region',label:r.region,subtitle:'리전',provider:r.provider}):provider(r.provider);
  for(const r of keep.values()){
    if(r.kind==='firewall'&&!f.policy)continue;
    if(r.provider==='onprem'){ensure({id:r.id,resource:r,label:r.name,provider:r.provider});continue;}
    const container=r.kind==='network'||r.kind==='subnet';
    ensure({id:r.id,parent:r.parent&&keep.has(r.parent)?r.parent:topLevel(r),resource:r,variant:container?r.kind as Variant:undefined,label:r.name,subtitle:r.cidr,provider:r.provider,outOfScope:outside.has(r.id)});
  }
  return items;
}
function summarize(items:Map<string,Item>,children:Map<string,string[]>,id:string):Summary{
  const out:Summary={total:0,stopped:0,warn:0,counts:{}};
  for(const c of children.get(id)??[]){
    const r=items.get(c)!.resource;
    if(r&&r.kind!=='subnet'){out.total++;out.counts[r.kind]=(out.counts[r.kind]??0)+1;const h=health(r.status);if(h==='stopped')out.stopped++;if(h==='warn')out.warn++;}
    const sub=summarize(items,children,c);out.total+=sub.total;out.stopped+=sub.stopped;out.warn+=sub.warn;
    for(const [k,v] of Object.entries(sub.counts))out.counts[k as ResourceKind]=(out.counts[k as ResourceKind]??0)+(v??0);
  }
  return out;
}
// Runs in a worker: a large expanded graph takes long enough to freeze the page otherwise.
let engine:Promise<import('elkjs/lib/elk-api').ELK>|undefined;
const elk=()=>engine??=(async()=>{
  const [{default:ELK},{default:workerUrl}]=await Promise.all([import('elkjs/lib/elk-api.js'),import('elkjs/lib/elk-worker.min.js?url')]);
  return new ELK({workerUrl,workerFactory:url=>new Worker(url!)});
})();
const bundleKind=(links:Link[],hybrid:boolean):Bundle['kind']=>hybrid?'hybrid':links.some(l=>l.kind==='peering')?'peering':links.some(l=>l.kind==='attachment')?'attachment':links.some(l=>l.kind==='policy')?'policy':'simulation';
export async function computeTopology(snapshot:Snapshot,f:Filter):Promise<Topology>{
  const items=buildItems(snapshot,f),children=new Map<string,string[]>();
  for(const it of items.values())if(it.parent)(children.get(it.parent)??children.set(it.parent,[]).get(it.parent)!).push(it.id);
  const isOpen=(it:Item)=>!!it.variant&&!it.outOfScope&&f.expanded.has(it.id)&&!!children.get(it.id)?.length;
  const visible=(id:string):string|undefined=>{
    let item=items.get(id);if(!item)return undefined;
    const chain:Item[]=[];for(let c:Item|undefined=item;c;c=c.parent?items.get(c.parent):undefined)chain.unshift(c);
    return (chain.find((c,i)=>i<chain.length-1&&!isOpen(c))??item).id;
  };
  const byId=new Map(snapshot.resources.map(r=>[r.id,r]));
  const graph=adjacency(snapshot.resources,snapshot.links),dist=distances(graph,ingressIds(snapshot.resources));
  const rankOf=(id:string):number=>dist.get(id)??Math.min(9999,...(children.get(id)??[]).map(rankOf));
  const groups=new Map<string,{a:string;b:string;links:Link[]}>();
  for(const l of snapshot.links){
    if((l.kind==='policy'&&!f.policy)||(l.kind==='simulation'&&!f.flow))continue;
    const a=visible(l.source),b=visible(l.target);if(!a||!b||a===b)continue;
    const within=(top:string,other:string)=>{for(let c=items.get(other);c;c=c.parent?items.get(c.parent):undefined)if(c.id===top)return true;return false;};
    if(within(a,b)||within(b,a))continue;
    const key=[a,b].sort().join('|');(groups.get(key)??groups.set(key,{a,b,links:[]}).get(key)!).links.push(l);
  }
  const peerCount=new Map<string,number>();for(const l of snapshot.links)if(l.kind==='peering')for(const end of [l.source,l.target])peerCount.set(end,(peerCount.get(end)??0)+1);
  const hubs=new Set([...peerCount].filter(([id,n])=>n>=2&&byId.get(id)?.kind==='network').map(([id])=>id));
  const policiesOn=new Map<string,string[]>();for(const l of snapshot.links)if(l.kind==='policy')(policiesOn.get(l.target)??policiesOn.set(l.target,[]).get(l.target)!).push(l.source);
  const policyCount=(r?:Resource)=>{if(!r||r.kind==='firewall')return 0;const found=new Set(policiesOn.get(r.id));for(let p=r.parent;p;p=byId.get(p)?.parent)for(const s of policiesOn.get(p)??[])found.add(s);return found.size;};
  const sizeOf=(it:Item)=>it.variant==='subnet'?SUBNET_SUMMARY:it.variant?SUMMARY:CARD;
  const orderKey=(it:Item)=>{const r=it.resource;return r?kindOrder.indexOf(r.kind)*1000+(rankOf(it.id)>=9999?999:rankOf(it.id)):0;};
  const toElk=(it:Item):ElkNode=>{
    if(!isOpen(it)){const s=sizeOf(it);return{id:it.id,...s};}
    const kids=children.get(it.id)!.map(id=>items.get(id)!).sort((a,b)=>orderKey(a)-orderKey(b)||a.label.localeCompare(b.label));
    return{id:it.id,layoutOptions:{'elk.padding':`[top=${PADDING_TOP[it.variant!]},left=16,bottom=16,right=16]`,...(it.variant==='network'||it.variant==='subnet'?{'elk.nodeSize.constraints':'MINIMUM_SIZE','elk.nodeSize.minimum':it.variant==='network'?'(340,0)':'(270,0)'}:{}),},children:kids.map(toElk)};
  };
  const roots=[...items.values()].filter(it=>!it.parent).sort((a,b)=>(a.provider==='onprem'?0:1)-(b.provider==='onprem'?0:1)||['azure','aws','gcp'].indexOf(a.provider)-['azure','aws','gcp'].indexOf(b.provider));
  const edgeList=[...groups.entries()].map(([key,g])=>{const [source,target]=rankOf(g.a)<=rankOf(g.b)?[g.a,g.b]:[g.b,g.a];return{id:key,source,target,links:g.links};});
  const rootOptions:Record<string,string>={
    'elk.algorithm':'layered','elk.direction':'RIGHT','elk.hierarchyHandling':'INCLUDE_CHILDREN','elk.edgeRouting':'ORTHOGONAL','elk.json.edgeCoords':'ROOT',
    'elk.layered.spacing.nodeNodeBetweenLayers':'96','elk.spacing.nodeNode':'20','elk.spacing.edgeNode':'16','elk.spacing.edgeEdge':'10','elk.layered.spacing.edgeNodeBetweenLayers':'16','elk.layered.spacing.edgeEdgeBetweenLayers':'10',
    'elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES','elk.layered.crossingMinimization.forceNodeModelOrder':'false','elk.layered.nodePlacement.strategy':'NETWORK_SIMPLEX','elk.separateConnectedComponents':'false','elk.padding':'[top=8,left=8,bottom=8,right=8]',
  };
  const graphInput:ElkNode={id:'root',layoutOptions:rootOptions,children:roots.map(toElk),edges:edgeList.map(e=>({id:e.id,sources:[e.source],targets:[e.target]}))};
  const laid=await (await elk()).layout(graphInput);
  const nodes:Placed[]=[];
  const walk=(n:ElkNode,ox:number,oy:number,depth:number)=>{for(const c of n.children??[]){
    const x=ox+(c.x??0),y=oy+(c.y??0),item=items.get(c.id)!,kids=children.get(c.id)??[];
    nodes.push({id:c.id,x,y,width:c.width??0,height:c.height??0,depth,item,collapsed:!c.children?.length,expandable:!!kids.length&&!item.outOfScope,summary:item.variant?summarize(items,children,c.id):{total:0,stopped:0,warn:0,counts:{}},policies:policyCount(item.resource),hub:hubs.has(c.id)});
    walk(c,x,y,depth+1);
  }};
  walk(laid,0,0,0);
  const sections=new Map((laid.edges??[]).map(e=>[e.id,(e as any).sections?.[0]]));
  const placedIds=new Set(nodes.map(n=>n.id));
  const edges:Bundle[]=edgeList.filter(e=>placedIds.has(e.source)&&placedIds.has(e.target)).map(e=>{
    const s=sections.get(e.id),config=e.links.filter(l=>l.kind!=='simulation');
    const hybrid=items.get(e.source)?.provider==='onprem'||items.get(e.target)?.provider==='onprem';
    const first=config[0]??e.links[0];
    return{id:e.id,source:e.source,target:e.target,links:e.links,kind:bundleKind(e.links,hybrid),hasFlow:e.links.some(l=>l.kind==='simulation'),label:config.length>1?`${first.label} +${config.length-1}`:first.label,points:s?[s.startPoint,...(s.bendPoints??[]),s.endPoint]:[]};
  });
  return{nodes,edges,rollup:visible};
}
