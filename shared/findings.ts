import type {Snapshot} from './schema.js';
import {costSpikes,money} from './cost.js';
import {cidrOverlaps,hybridLinks} from './network.js';
import {exposures,health} from './topology.js';
import {ALL_FOCUS,iamInScope,inScope,type Focus} from './hierarchy.js';
export type Severity='critical'|'high'|'medium'|'info';
export type Category='infra'|'network'|'iam'|'cost';
export type Finding={id:string;severity:Severity;category:Category;title:string;detail:string;provider?:string;scope?:string;target?:{view:'map'|'iam'|'cost'|'network'|'security'|'inventory';id?:string}};
const ORDER:Severity[]=['critical','high','medium','info'];
const KEY_MAX_DAYS=90;
// Everything the portal thinks an operator should look at, in one list. Each entry names its evidence and stays a candidate rather than a verdict.
export function findings(s:Snapshot,now=new Date(),focus:Focus=ALL_FOCUS):Finding[]{
  const out:Finding[]=[],label=(scope:string)=>s.scopeLabels[scope]??scope;
  for(const r of s.resources){
    if(r.kind==='firewall'||r.kind==='subnet'||!inScope(focus,r.provider,r.scope))continue;
    if(health(r.status)==='warn')out.push({id:`status:${r.id}`,severity:r.kind==='gateway'?'high':'medium',category:r.kind==='gateway'?'network':'infra',title:`${r.name} 상태 이상`,detail:`${r.status} · ${label(r.scope)}`,provider:r.provider,scope:r.scope,target:{view:'map',id:r.id}});
    if(r.kind==='external')out.push({id:`external:${r.id}`,severity:'info',category:'network',title:`${r.name} 조회 권한 없음`,detail:'연결 참조는 있지만 읽을 수 없는 외부 자원입니다.',provider:r.provider,target:{view:'map',id:r.id}});
  }
  const stopped=s.resources.filter(r=>r.kind==='compute'&&health(r.status)==='stopped'&&inScope(focus,r.provider,r.scope));
  if(stopped.length)out.push({id:'stopped',severity:'info',category:'cost',title:`중지된 VM ${stopped.length}대`,detail:'디스크 등 연결 자원 비용이 계속 나올 수 있습니다.',target:{view:'inventory'}});
  // A public load balancer on 443 is usually the design; remote admin ports open to the world rarely are.
  for(const e of exposures(s.resources,s.links).filter(e=>inScope(focus,e.resource.provider,e.resource.scope))){const admin=e.rules.find(x=>/(^|,\s*)(22|3389|all|\*)(,|$)/i.test(x.rule.ports)),first=admin??e.rules[0],isLb=e.resource.kind==='loadbalancer';out.push({id:`exposed:${e.resource.id}`,severity:admin?'critical':isLb?'info':'high',category:'network',title:isLb&&!admin?`${e.resource.name} 공개 로드밸런서`:`${e.resource.name} 공인 노출 후보`,detail:`${first.policy} · ${first.rule.protocol}/${first.rule.ports} · ${first.rule.source}`,provider:e.resource.provider,scope:e.resource.scope,target:{view:'map',id:e.resource.id}});}
  // An overlap with a network outside the selection is still this scope's problem.
  for(const o of cidrOverlaps(s.resources).filter(o=>inScope(focus,o.a.provider,o.a.scope)||inScope(focus,o.b.provider,o.b.scope)))out.push({id:`overlap:${o.a.id}:${o.b.id}`,severity:'medium',category:'network',title:`주소 대역 중복: ${o.a.name} · ${o.b.name}`,detail:`${o.cidrA} / ${o.cidrB}`,target:{view:'network'}});
  const sites=hybridLinks(s.resources,s.links),perCloud=new Map<string,number>();for(const h of sites)perCloud.set(h.target.provider,(perCloud.get(h.target.provider)??0)+1);
  for(const [provider,n] of perCloud)if(n===1&&sites.some(h=>h.target.provider===provider&&inScope(focus,provider,h.target.scope)))out.push({id:`single-link:${provider}`,severity:'info',category:'network',title:`${provider.toUpperCase()} 사내망 연결 1개`,detail:'이중화된 경로가 구성에 보이지 않습니다.',provider,target:{view:'network'}});
  for(const scope of s.incomplete.filter(x=>inScope(focus,s.hierarchy.find(n=>n.scope===x)?.provider??focus.provider,x)))out.push({id:`incomplete:${scope}`,severity:'medium',category:'infra',title:`${label(scope)} 일부 미수집`,detail:'권한이나 설정 때문에 읽지 못한 항목이 있습니다.',scope});
  for(const a of s.iam.filter(a=>iamInScope(focus,a))){
    if(a.principalType==='public')out.push({id:`public:${a.id}`,severity:'critical',category:'iam',title:`${label(a.scope)} 공개 권한`,detail:`${a.principal} → ${a.role}`,provider:a.provider,scope:a.scope,target:{view:'iam'}});
    else if(a.external)out.push({id:`ext:${a.id}`,severity:a.privileged?'critical':'high',category:'iam',title:`외부 주체 ${a.principal}`,detail:`${a.role} · ${label(a.scope)}`,provider:a.provider,scope:a.scope,target:{view:'iam'}});
    if(a.principalType==='user'&&a.privileged&&a.mfa===false)out.push({id:`mfa:${a.id}`,severity:'high',category:'iam',title:`${a.principal} 특권 사용자 MFA 없음`,detail:`${a.role} · ${label(a.scope)}`,provider:a.provider,scope:a.scope,target:{view:'iam'}});
    if(a.keyAgeDays!==undefined&&a.keyAgeDays>KEY_MAX_DAYS&&a.privileged)out.push({id:`key:${a.id}`,severity:'medium',category:'iam',title:`${a.principal} 오래된 액세스 키`,detail:`${a.keyAgeDays}일 경과 · ${label(a.scope)}`,provider:a.provider,scope:a.scope,target:{view:'iam'}});
  }
  for(const x of costSpikes(s.cost.filter(c=>inScope(focus,c.provider,c.scope)),now,undefined,undefined,s.fx).slice(0,8))out.push({id:`spike:${x.provider}:${x.scope}:${x.service}`,severity:'medium',category:'cost',title:`${label(x.scope)} ${x.service} 비용 증가`,detail:`${money(x.previous,x.currency)} → ${money(x.amount,x.currency)} (+${Math.round(x.change*100)}%)`,provider:x.provider,scope:x.scope,target:{view:'cost'}});
  // The same issue across twenty accounts is one thing to fix, not twenty lines to read.
  const grouped=new Map<string,Finding&{scopes:string[]}>();
  for(const f of out){const key=f.category==='iam'?`${f.severity}|${f.title}`:f.id,seen=grouped.get(key);if(!seen)grouped.set(key,{...f,scopes:f.scope?[f.scope]:[]});else if(f.scope&&!seen.scopes.includes(f.scope))seen.scopes.push(f.scope);}
  const unique=[...grouped.values()].map(({scopes,...f})=>scopes.length>1?{...f,detail:`${f.detail.split(' · ')[0]} · 범위 ${scopes.length}개: ${scopes.slice(0,2).map(label).join(', ')}${scopes.length>2?' 외':''}`}:f);
  return unique.sort((a,b)=>ORDER.indexOf(a.severity)-ORDER.indexOf(b.severity));
}
