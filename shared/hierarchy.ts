import type {HierarchyNode,IamAssignment,Resource} from './schema.js';
import {health} from './topology.js';
// incomplete counts the scopes beneath a node that were only partly read, so a total is never shown as if it were whole.
export type ScopeStats={resources:number;networks:number;warn:number;stopped:number;incomplete:number};
export type ScopeIndex={nodes:Map<string,HierarchyNode>;children:Map<string,HierarchyNode[]>;roots:Record<string,HierarchyNode[]>;stats:Map<string,ScopeStats>;scopesUnder:(id:string)=>string[];pathTo:(id:string)=>HierarchyNode[]};
const blank=():ScopeStats=>({resources:0,networks:0,warn:0,stopped:0,incomplete:0});
export function buildScopeIndex(hierarchy:HierarchyNode[],resources:Resource[],incomplete:string[]=[]):ScopeIndex{
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
  for(const scope of new Set(incomplete))(byScope.get(scope)??byScope.set(scope,blank()).get(scope)!).incomplete=1;
  const stats=new Map<string,ScopeStats>();
  const roll=(n:HierarchyNode):ScopeStats=>{
    const total=blank(),own=n.scope?byScope.get(n.scope):undefined;
    for(const part of [own,...(children.get(n.id)??[]).map(roll)])if(part)for(const k of Object.keys(total) as (keyof ScopeStats)[])total[k]+=part[k];
    stats.set(n.id,total);return total;
  };
  Object.values(roots).flat().forEach(roll);
  const scopesUnder=(id:string):string[]=>{const n=nodes.get(id);if(!n)return [];return [...(n.scope?[n.scope]:[]),...(children.get(id)??[]).flatMap(c=>scopesUnder(c.id))];};
  const pathTo=(id:string)=>{const out:HierarchyNode[]=[];for(let c=nodes.get(id);c;c=c.parent?nodes.get(c.parent):undefined)out.unshift(c);return out;};
  return{nodes,children,roots,stats,scopesUnder,pathTo};
}
// What every page filters by. Null scopes means the whole provider, or everything when the provider is 'all'.
export type Focus={provider:string;scopes:Set<string>|null;inherits:(nativeId:string)=>boolean};
export const ALL_FOCUS:Focus={provider:'all',scopes:null,inherits:()=>true};
export function focusFor(index:ScopeIndex|null,tab:string):Focus{
  if(tab.startsWith('provider:'))return{...ALL_FOCUS,provider:tab.slice(9)};
  const node=index?.nodes.get(tab);if(!index||!node)return ALL_FOCUS;
  const under=(id:string):HierarchyNode[]=>(index.children.get(id)??[]).flatMap(c=>[c,...under(c.id)]);
  const related=new Set([...index.pathTo(tab),...under(tab)].map(n=>n.nativeId)),known=new Set([...index.nodes.values()].map(n=>n.nativeId));
  // A group we cannot place in the tree stays visible: hiding a privileged assignment is the worse mistake.
  return{provider:node.provider,scopes:new Set(index.scopesUnder(tab)),inherits:id=>related.has(id)||!known.has(id)};
}
export const inScope=(f:Focus,provider:string,scope?:string)=>(f.provider==='all'||provider===f.provider)&&(!f.scopes||(scope!==undefined&&f.scopes.has(scope)));
// Org and group assignments carry a group's id rather than a leaf scope, and they apply to everything beneath that group.
export const iamInScope=(f:Focus,a:Pick<IamAssignment,'provider'|'scope'|'level'>)=>a.level==='org'||a.level==='group'?(f.provider==='all'||a.provider===f.provider)&&(a.level==='org'||f.inherits(a.scope)):inScope(f,a.provider,a.scope);
export const hierarchyNouns:Record<HierarchyNode['kind'],string>={tenant:'테넌트',managementGroup:'관리 그룹',subscription:'구독',organization:'조직',ou:'OU',account:'계정',folder:'폴더',project:'프로젝트'};
