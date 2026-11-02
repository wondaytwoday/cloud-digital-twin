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
const CARD={width:204,height:60},SUMMARY={width:236,height:92},SUBNET_SUMMARY=CARD,PACK_GAP=12,TRUNK_GAP=40,TRUNK_STEP=14,CLOUD_GAP=28;
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
  const model={resources:snapshot.resources,links:snapshot.links},ingress=ingressIds(snapshot.resources);
  for(const r of [...keep.values()].filter(r=>r.kind==='network'))for(const hop of findPath(model,r.id,ingress))if(!keep.has(hop)){keep.set(hop,byId.get(hop)!);outside.add(hop);}
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
const ROOT_LAYOUT:Record<string,string>={
  'elk.algorithm':'layered','elk.direction':'RIGHT','elk.hierarchyHandling':'INCLUDE_CHILDREN','elk.edgeRouting':'ORTHOGONAL','elk.json.edgeCoords':'ROOT',
  'elk.layered.spacing.nodeNodeBetweenLayers':'96','elk.spacing.nodeNode':'20','elk.spacing.edgeNode':'16','elk.spacing.edgeEdge':'10','elk.layered.spacing.edgeNodeBetweenLayers':'16','elk.layered.spacing.edgeEdgeBetweenLayers':'10',
  'elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES','elk.layered.crossingMinimization.forceNodeModelOrder':'false','elk.layered.nodePlacement.strategy':'NETWORK_SIMPLEX','elk.separateConnectedComponents':'false','elk.padding':'[top=0,left=0,bottom=0,right=0]',
};
const layoutCache=new Map<string,Promise<ElkNode>>();
function cachedLayout(input:ElkNode){
  const key=JSON.stringify(input);let hit=layoutCache.get(key);
  if(!hit){hit=elk().then(engine=>engine.layout(input));layoutCache.set(key,hit);hit.catch(()=>layoutCache.delete(key));if(layoutCache.size>60)layoutCache.delete(layoutCache.keys().next().value!);}
  return hit;
}
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
    if(l.kind==='route'||(l.kind==='policy'&&!f.policy)||(l.kind==='simulation'&&!f.flow))continue;
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
  const roots=[...items.values()].filter(it=>!it.parent);
  const edgeList=[...groups.entries()].map(([key,g])=>{const [source,target]=rankOf(g.a)<=rankOf(g.b)?[g.a,g.b]:[g.b,g.a];return{id:key,source,target,links:g.links};});
  const touched=new Set(edgeList.flatMap(e=>[e.source,e.target]));
  // Unconnected same-size children would otherwise stack in one tall column, so they are laid out as a grid inside one block.
  const packs=new Map<string,Item[]>();
  const toElk=(it:Item):ElkNode=>{
    if(!isOpen(it)){const s=sizeOf(it);return{id:it.id,...s};}
    const kids=children.get(it.id)!.map(id=>items.get(id)!).sort((a,b)=>orderKey(a)-orderKey(b)||a.label.localeCompare(b.label));
    const packable=it.variant==='network'||it.variant==='subnet'?kids.filter(k=>!isOpen(k)&&sizeOf(k)===CARD&&!touched.has(k.id)||!isOpen(k)&&k.variant==='subnet'&&!touched.has(k.id)):[];
    const elkKids:ElkNode[]=[];
    if(packable.length>=3){
      const id=`pack:${it.id}`,cols=Math.min(3,Math.ceil(Math.sqrt(packable.length))),rows=Math.ceil(packable.length/cols);packs.set(id,packable);
      elkKids.push({id,width:cols*CARD.width+(cols-1)*PACK_GAP,height:rows*CARD.height+(rows-1)*PACK_GAP});
    }
    const packed=new Set(packable.length>=3?packable.map(k=>k.id):[]);
    elkKids.push(...kids.filter(k=>!packed.has(k.id)).map(toElk));
    return{id:it.id,layoutOptions:{'elk.padding':`[top=${PADDING_TOP[it.variant!]},left=16,bottom=16,right=16]`,...(it.variant==='network'||it.variant==='subnet'?{'elk.nodeSize.constraints':'MINIMUM_SIZE','elk.nodeSize.minimum':it.variant==='network'?'(340,0)':'(270,0)'}:{})},children:elkKids};
  };
  const rootOf=(id:string)=>{let c=items.get(id);while(c?.parent)c=items.get(c.parent);return c;};
  const sites=roots.filter(r=>r.provider==='onprem').sort((a,b)=>a.label.localeCompare(b.label)),clouds=roots.filter(r=>r.provider!=='onprem').sort((a,b)=>['azure','aws','gcp'].indexOf(a.provider)-['azure','aws','gcp'].indexOf(b.provider));
  // One ELK run per cloud: expanding something in AWS cannot rearrange Azure, and an unchanged cloud comes straight from cache.
  const laidClouds=await Promise.all(clouds.map(async cloud=>{
    const inside=edgeList.filter(e=>rootOf(e.source)===cloud&&rootOf(e.target)===cloud);
    const fromSites=edgeList.filter(e=>items.get(e.source)?.provider==='onprem'&&rootOf(e.target)===cloud);
    const portals=[...new Set(fromSites.map(e=>e.source))].map(site=>({id:`portal:${cloud.id}:${site}`,width:2,height:2}));
    const portalEdges=fromSites.map(e=>({id:e.id,sources:[`portal:${cloud.id}:${e.source}`],targets:[e.target]}));
    const input:ElkNode={id:'root',layoutOptions:ROOT_LAYOUT,children:[...portals,toElk(cloud)],edges:[...portalEdges,...inside.map(e=>({id:e.id,sources:[e.source],targets:[e.target]}))]};
    return{cloud,laid:await cachedLayout(input)};
  }));
  const nodes:Placed[]=[],sections=new Map<string,{x:number;y:number}[]>(),portalY=new Map<string,number[]>();
  const place=(id:string,x:number,y:number,width:number,height:number,depth:number,collapsed:boolean)=>{
    const item=items.get(id)!,kids=children.get(id)??[];
    nodes.push({id,x,y,width,height,depth,item,collapsed,expandable:!!kids.length&&!item.outOfScope,summary:item.variant?summarize(items,children,id):{total:0,stopped:0,warn:0,counts:{}},policies:policyCount(item.resource),hub:hubs.has(id)});
  };
  const walk=(n:ElkNode,ox:number,oy:number,depth:number)=>{for(const c of n.children??[]){
    const x=ox+(c.x??0),y=oy+(c.y??0);
    if(c.id.startsWith('portal:'))continue;
    const pack=packs.get(c.id);
    if(pack){const cols=Math.min(3,Math.ceil(Math.sqrt(pack.length)));pack.forEach((k,i)=>place(k.id,x+(i%cols)*(CARD.width+PACK_GAP),y+Math.floor(i/cols)*(CARD.height+PACK_GAP),CARD.width,CARD.height,depth,true));continue;}
    place(c.id,x,y,c.width??0,c.height??0,depth,!c.children?.length);
    walk(c,x,y,depth+1);
  }};
  const siteColumn=sites.length?CARD.width+TRUNK_GAP+sites.length*TRUNK_STEP:0;let cursor=8;
  for(const {cloud,laid} of laidClouds){
    const frame=laid.children!.find(c=>c.id===cloud.id)!,portalNodes=laid.children!.filter(c=>c.id.startsWith('portal:'));
    const dx=siteColumn+(sites.length?16:0)-(frame.x??0),dy=cursor-Math.min(frame.y??0,...portalNodes.map(p=>p.y??0));
    walk({id:'root',children:[frame]},dx,dy,0);
    for(const p of portalNodes)(portalY.get(p.id)??portalY.set(p.id,[]).get(p.id)!).push((p.y??0)+dy);
    for(const e of laid.edges??[]){const sec=(e as any).sections?.[0];if(sec)sections.set(e.id,[sec.startPoint,...(sec.bendPoints??[]),sec.endPoint].map((pt:{x:number;y:number})=>({x:pt.x+dx,y:pt.y+dy})));}
    cursor=dy+Math.max((frame.y??0)+(frame.height??0),...portalNodes.map(p=>(p.y??0)+(p.height??0)))+CLOUD_GAP;
  }
  // Sites sit beside the clouds they connect to, then get nudged apart.
  const siteCenter=(site:Item)=>{const ys=[...portalY].filter(([k])=>k.endsWith(`:${site.id}`)).flatMap(([,v])=>v);return ys.length?ys.reduce((a,b)=>a+b,0)/ys.length:cursor/2;};
  let siteCursor=-Infinity;
  const siteTop=new Map<string,number>();
  for(const site of [...sites].sort((a,b)=>siteCenter(a)-siteCenter(b))){const y=Math.max(siteCenter(site)-CARD.height/2,siteCursor);siteTop.set(site.id,y);place(site.id,0,y,CARD.width,CARD.height,0,true);siteCursor=y+CARD.height+20;}
  const trunkX=(site:string)=>CARD.width+TRUNK_GAP/2+sites.findIndex(s=>s.id===site)*TRUNK_STEP;
  for(const e of edgeList)if(items.get(e.source)?.provider==='onprem'){
    const route=sections.get(e.id);if(!route)continue;
    const x=trunkX(e.source),y=siteTop.get(e.source)!+CARD.height/2;
    // The portal itself is only a routing anchor, so the line turns off the trunk instead of starting at it.
    sections.set(e.id,[{x:CARD.width,y},{x,y},{x,y:route[0].y},...route.slice(1)]);
  }
  const placedIds=new Set(nodes.map(n=>n.id));
  const edges:Bundle[]=edgeList.filter(e=>placedIds.has(e.source)&&placedIds.has(e.target)).map(e=>{
    const config=e.links.filter(l=>l.kind!=='simulation');
    const hybrid=items.get(e.source)?.provider==='onprem'||items.get(e.target)?.provider==='onprem';
    const first=config[0]??e.links[0];
    return{id:e.id,source:e.source,target:e.target,links:e.links,kind:bundleKind(e.links,hybrid),hasFlow:e.links.some(l=>l.kind==='simulation'),label:config.length>1?`${first.label} +${config.length-1}`:first.label,points:sections.get(e.id)??[]};
  });
  return{nodes,edges,rollup:visible};
}
