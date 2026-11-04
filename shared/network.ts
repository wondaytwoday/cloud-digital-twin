import type {Link,Resource} from './schema.js';
export type Range={from:number;to:number};
export function parseCidr(cidr:string):Range|null{
  const m=cidr.trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);if(!m)return null;
  const [a,b,c,d,bits]=m.slice(1).map(Number);if([a,b,c,d].some(x=>x>255)||bits>32)return null;
  const ip=(a*2**24)+(b<<16)+(c<<8)+d,size=2**(32-bits),from=Math.floor(ip/size)*size;
  return{from,to:from+size-1};
}
export type Overlap={a:Resource;b:Resource;cidrA:string;cidrB:string};
// Overlaps block peering and hybrid routing later, so they matter even before anything connects the two networks.
export function cidrOverlaps(resources:Resource[]):Overlap[]{
  const byId=new Map(resources.map(r=>[r.id,r])),networkOf=(r:Resource)=>r.kind==='network'?r.id:r.parent??r.id;
  // GCP VPCs have no range of their own, so their subnets stand in.
  const ranges=resources.filter(r=>r.cidr&&(r.kind==='network'||(r.kind==='subnet'&&r.parent&&!byId.get(r.parent)?.cidr))).flatMap(r=>r.cidr!.split(/,\s*/).flatMap(c=>{const range=parseCidr(c);return range?[{r,c,range}]:[];}));
  const out:Overlap[]=[];
  for(let i=0;i<ranges.length;i++)for(let j=i+1;j<ranges.length;j++){const x=ranges[i],y=ranges[j];if(networkOf(x.r)!==networkOf(y.r)&&x.range.from<=y.range.to&&y.range.from<=x.range.to)out.push({a:x.r,b:y.r,cidrA:x.c,cidrB:y.c});}
  return out;
}
export type HybridLink={site:Resource;target:Resource;label:string};
export const hybridLinks=(resources:Resource[],links:Link[]):HybridLink[]=>{const byId=new Map(resources.map(r=>[r.id,r]));return links.filter(l=>l.kind==='attachment'&&byId.get(l.source)?.kind==='onprem').map(l=>({site:byId.get(l.source)!,target:byId.get(l.target)!,label:l.label}));};
export type RuleRow={policy:Resource;rule:Resource['rules'][number]};
export const allRules=(resources:Resource[]):RuleRow[]=>resources.flatMap(policy=>policy.rules.map(rule=>({policy,rule})));
export function portMatches(ports:string,port:number){
  if(/^(\*|all)$/i.test(ports.trim()))return true;
  return ports.split(/,\s*/).some(p=>{const [from,to=from]=p.split(/[–-]/).map(Number);return port>=from&&port<=to;});
}
