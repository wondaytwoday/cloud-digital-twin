import type {HierarchyNode,Resource} from './schema.js';
import {health} from './topology.js';
export type ScopeStats={resources:number;networks:number;warn:number;stopped:number};
export type ScopeIndex={nodes:Map<string,HierarchyNode>;children:Map<string,HierarchyNode[]>;roots:Record<string,HierarchyNode[]>;stats:Map<string,ScopeStats>;scopesUnder:(id:string)=>string[];pathTo:(id:string)=>HierarchyNode[]};
const blank=():ScopeStats=>({resources:0,networks:0,warn:0,stopped:0});
export function buildScopeIndex(hierarchy:HierarchyNode[],resources:Resource[]):ScopeIndex{
  const nodes=new Map(hierarchy.map(n=>[n.id,n])),children=new Map<string,HierarchyNode[]>(),roots:Record<string,HierarchyNode[]>={azure:[],aws:[],gcp:[]};
  // Groups first, then scopes by name: the tree reads top-down the way the CSP consoles do.
  const sorted=[...hierarchy].sort((a,b)=>Number(!!a.scope)-Number(!!b.scope)||a.name.localeCompare(b.name));
  for(const n of sorted){if(n.parent)(children.get(n.parent)??children.set(n.parent,[]).get(n.parent)!).push(n);else roots[n.provider]?.push(n);}
  const byScope=new Map<string,ScopeStats>();
  for(const r of resources){
    if(r.provider==='onprem'||r.scope==='external')continue;
    const s=byScope.get(r.scope)??byScope.set(r.scope,blank()).get(r.scope)!;s.resources++;
    if(r.kind==='network')s.networks++;
    if(r.kind!=='firewall'&&r.kind!=='subnet'){const h=health(r.status);if(h==='warn')s.warn++;if(h==='stopped')s.stopped++;}
  }
  const stats=new Map<string,ScopeStats>();
  const roll=(n:HierarchyNode):ScopeStats=>{
    const total=blank(),own=n.scope?byScope.get(n.scope):undefined;
    for(const part of [own,...(children.get(n.id)??[]).map(roll)])if(part){total.resources+=part.resources;total.networks+=part.networks;total.warn+=part.warn;total.stopped+=part.stopped;}
    stats.set(n.id,total);return total;
  };
  Object.values(roots).flat().forEach(roll);
  const scopesUnder=(id:string):string[]=>{const n=nodes.get(id);if(!n)return [];return [...(n.scope?[n.scope]:[]),...(children.get(id)??[]).flatMap(c=>scopesUnder(c.id))];};
  const pathTo=(id:string)=>{const out:HierarchyNode[]=[];for(let c=nodes.get(id);c;c=c.parent?nodes.get(c.parent):undefined)out.unshift(c);return out;};
  return{nodes,children,roots,stats,scopesUnder,pathTo};
}
export const hierarchyNouns:Record<HierarchyNode['kind'],string>={tenant:'테넌트',managementGroup:'관리 그룹',subscription:'구독',organization:'조직',ou:'OU',account:'계정',folder:'폴더',project:'프로젝트'};
