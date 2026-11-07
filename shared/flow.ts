import type {Link,Resource,Snapshot} from './schema.js';
import {parseCidr,portMatches} from './network.js';
// Can traffic from A reach B on a protocol and port, according to the collected configuration?
// It follows route tables hop by hop (longest prefix, then the provider's tie-break), evaluates each policy the way its provider does,
// and puts a device in the path only where a route sends traffic to it. Containment never connects anything here.
// Every result is a configuration verdict for the snapshot it read, not an observation: no flow log is connected.
export type Verdict='allowed'|'blocked'|'unknown';
export type Protocol='tcp'|'udp'|'icmp'|'any';
export type FlowQuery={from:string;to:string;protocol:Protocol;port?:number};
export type Hop={id?:string;label:string;kind:'source'|'nic'|'subnet'|'route'|'appliance'|'peering'|'gateway'|'endpoint'|'service'|'destination'|'internet'|'onprem'|'loadbalancer';evidence:string;basis?:'configured'|'inferred'|'declared'};
export type RuleRef={name?:string;priority?:string;action:string;protocol:string;ports:string;source:string;destination:string};
export type PolicyCheck={policy?:string;name:string;at:string;direction:'inbound'|'outbound'|'through';verdict:'allow'|'deny'|'unknown';rule?:RuleRef;reason:string;unevaluated?:string[]};
export type Endpoint={ref:string;label:string;resource?:Resource;nic?:Resource;ip?:string;cidr?:string;subnet?:Resource;network?:Resource;provider?:string;zone:'cloud'|'onprem'|'internet'|'unknown';service?:Resource;fqdn?:string};
// gaps lists what was not checked. undecided ones make the verdict unknown; the rest (the far side of a gateway, a service's own firewall) only mark it partial.
export type Gap={text:string;undecided:boolean};
export type FlowResult={query:FlowQuery;status:Verdict;summary:string;from:Endpoint;to:Endpoint;path:Hop[];policies:PolicyCheck[];returnPath:{status:Verdict;notes:string[]};gaps:Gap[];conditions:string[];observed:'not-integrated';dataAt:Record<string,string|undefined>;analyzedAt:string;completeness:'full'|'partial'};

// ---- addresses
const ipNum=(ip:string)=>{const m=ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);return m?m.slice(1).map(Number).reduce((a,b)=>a*256+b,0):NaN;};
export const isIp=(v:string)=>!Number.isNaN(ipNum(v.trim()));
const rangeOf=(v:string)=>isIp(v)?{from:ipNum(v),to:ipNum(v)}:parseCidr(v);
const within=(inner:{from:number;to:number},outer:{from:number;to:number})=>inner.from>=outer.from&&inner.to<=outer.to;
const disjoint=(a:{from:number;to:number},b:{from:number;to:number})=>a.to<b.from||b.to<a.from;
const prefixLen=(cidr:string)=>Number(cidr.split('/')[1]??32);
const PRIVATE=['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10','169.254.0.0/16'].map(c=>parseCidr(c)!);
export const isPrivate=(v:string)=>{const r=rangeOf(v);return!!r&&PRIVATE.some(p=>within(r,p));};
const spaces=(r?:Resource)=>(r?.cidr??'').split(/,\s*/).filter(c=>parseCidr(c));
// An address is the endpoint's IP, or for an on-prem site its whole range; a rule matches only if it covers all of it.
type Addr={ip?:string;cidr?:string};
const addrRange=(a:Addr)=>a.ip?rangeOf(a.ip):a.cidr?rangeOf(a.cidr):null;
type Tri=true|false|'unknown';
function cidrMatch(token:string,a:Addr):Tri{const t=rangeOf(token),r=addrRange(a);if(!t||!r)return 'unknown';if(within(r,t))return true;if(disjoint(r,t))return false;return 'unknown';}

// ---- snapshot index
type Ctx={s:Snapshot;byId:Map<string,Resource>;out:Map<string,Link[]>;into:Map<string,Link[]>};
const index=(s:Snapshot):Ctx=>{const out=new Map<string,Link[]>(),into=new Map<string,Link[]>();for(const l of s.links){(out.get(l.source)??out.set(l.source,[]).get(l.source)!).push(l);(into.get(l.target)??into.set(l.target,[]).get(l.target)!).push(l);}return{s,byId:new Map(s.resources.map(r=>[r.id,r])),out,into};};
const networkOf=(c:Ctx,r?:Resource)=>{for(let x=r;x;x=x.parent?c.byId.get(x.parent):undefined)if(x.kind==='network')return x;return undefined;};
const subnetOf=(c:Ctx,r?:Resource)=>{for(let x=r;x;x=x.parent?c.byId.get(x.parent):undefined)if(x.kind==='subnet')return x;return undefined;};
const policiesOn=(c:Ctx,id?:string)=>id?(c.into.get(id)??[]).filter(l=>l.kind==='policy').map(l=>c.byId.get(l.source)).filter((p):p is Resource=>!!p):[];
const nicsOf=(c:Ctx,r:Resource)=>(c.out.get(r.id)??[]).filter(l=>l.kind==='attachment'&&c.byId.get(l.target)?.kind==='nic').sort((a,b)=>Number(b.label==='기본 NIC')-Number(a.label==='기본 NIC')).map(l=>c.byId.get(l.target)!);
const peersOf=(c:Ctx,network:Resource)=>c.s.links.filter(l=>l.kind==='peering'&&(l.source===network.id||l.target===network.id)).map(l=>({link:l,peer:c.byId.get(l.source===network.id?l.target:l.source)})).filter((x):x is {link:Link;peer:Resource}=>!!x.peer);
const holding=(c:Ctx,ip:string)=>{
  // A NIC or endpoint names the address it holds; a VM only through its NICs, so the NIC that holds the address wins.
  const order:Resource['kind'][]=['nic','endpoint','appliance','loadbalancer','nat','gateway','compute','database'];
  for(const k of order){const r=c.s.resources.find(x=>x.kind===k&&(x.ip===ip||x.addresses?.some(a=>a.ip===ip)));if(r)return r;}
  return undefined;
};
const vmOfNic=(c:Ctx,nic:Resource)=>(c.into.get(nic.id)??[]).filter(l=>l.kind==='attachment').map(l=>c.byId.get(l.source)).find(r=>r?.kind==='compute');

export function resolveEndpoint(s:Snapshot,ref:string,c:Ctx=index(s)):Endpoint{
  const r=c.byId.get(ref);
  if(r){
    if(r.provider==='onprem')return{ref,label:r.name,resource:r,cidr:r.cidr,zone:'onprem',provider:'onprem'};
    if(r.kind==='compute'){const nic=nicsOf(c,r)[0],subnet=subnetOf(c,nic)??subnetOf(c,r);return{ref,label:r.name,resource:r,nic,ip:nic?.ip??r.ip,subnet,network:networkOf(c,subnet),provider:r.provider,zone:'cloud'};}
    // A managed service has no address in a subnet. Through a private endpoint it has the endpoint's; otherwise only its public one.
    if(['database','bucket','storage','fileshare','service'].includes(r.kind)&&!r.parent){
      const pe=(c.into.get(r.id)??[]).filter(l=>l.kind==='private_link').map(l=>c.byId.get(l.source)).find(x=>x?.kind==='endpoint');
      if(pe){const subnet=subnetOf(c,pe);return{ref,label:r.name,resource:pe,ip:pe.ip,subnet,network:networkOf(c,subnet),provider:r.provider,zone:'cloud',service:r};}
      return{ref,label:r.name,resource:r,provider:r.provider,zone:'internet',service:r};
    }
    const subnet=r.kind==='subnet'?r:subnetOf(c,r);
    // A managed database placed in a subnet without a collected address (RDS reports a DNS name) is located by its subnet's range.
    return{ref,label:r.name,resource:r,nic:r.kind==='nic'?r:undefined,ip:r.ip,cidr:r.kind==='subnet'||!r.ip?subnet?.cidr:undefined,subnet,network:networkOf(c,subnet??r),provider:r.provider,zone:'cloud'};
  }
  if(isIp(ref)){
    const h=holding(c,ref);
    if(h){const vm=h.kind==='nic'?vmOfNic(c,h):undefined,subnet=subnetOf(c,h);return{ref,label:vm?`${vm.name} (${h.name})`:h.name,resource:vm??h,nic:h.kind==='nic'?h:undefined,ip:ref,subnet,network:networkOf(c,subnet),provider:h.provider,zone:'cloud'};}
    const subnet=c.s.resources.filter(x=>x.kind==='subnet'&&x.cidr&&cidrMatch(x.cidr,{ip:ref})===true).sort((a,b)=>prefixLen(b.cidr!)-prefixLen(a.cidr!))[0];
    if(subnet)return{ref,label:`${ref} (${subnet.name})`,ip:ref,subnet,network:networkOf(c,subnet),provider:subnet.provider,zone:'cloud'};
    const site=c.s.resources.find(x=>x.kind==='onprem'&&x.cidr&&cidrMatch(x.cidr,{ip:ref})===true);
    if(site)return{ref,label:`${ref} (${site.name})`,resource:site,ip:ref,zone:'onprem',provider:'onprem'};
    return{ref,label:ref,ip:ref,zone:isPrivate(ref)?'unknown':'internet'};
  }
  // A configured DNS record (a private endpoint's FQDN) is evidence that the name exists, not that a given client resolves it there.
  const pe=c.s.resources.find(x=>x.kind==='endpoint'&&x.specs['DNS 이름']?.split(/,\s*/).includes(ref));
  if(pe){const svc=(c.out.get(pe.id)??[]).find(l=>l.kind==='private_link'),subnet=subnetOf(c,pe);return{ref,label:ref,resource:pe,ip:pe.ip,subnet,network:networkOf(c,subnet),provider:pe.provider,zone:'cloud',service:svc?c.byId.get(svc.target):undefined,fqdn:ref};}
  return{ref,label:ref,zone:'unknown',fqdn:ref};
}

// ---- Azure NSG: priority order, first match wins; inbound subnet then NIC, outbound NIC then subnet.
const AZURE_DEFAULTS:RuleRef[]=[
  {name:'AllowVnetInBound (기본 규칙, 문서 기준)',priority:'65000',action:'Allow',protocol:'*',ports:'*',source:'VirtualNetwork',destination:'VirtualNetwork'},{name:'AllowAzureLoadBalancerInBound (기본 규칙, 문서 기준)',priority:'65001',action:'Allow',protocol:'*',ports:'*',source:'AzureLoadBalancer',destination:'*'},{name:'DenyAllInBound (기본 규칙, 문서 기준)',priority:'65500',action:'Deny',protocol:'*',ports:'*',source:'*',destination:'*'}];
const AZURE_DEFAULTS_OUT:RuleRef[]=[{name:'AllowVnetOutBound (기본 규칙, 문서 기준)',priority:'65000',action:'Allow',protocol:'*',ports:'*',source:'VirtualNetwork',destination:'VirtualNetwork'},{name:'AllowInternetOutBound (기본 규칙, 문서 기준)',priority:'65001',action:'Allow',protocol:'*',ports:'*',source:'*',destination:'Internet'},{name:'DenyAllOutBound (기본 규칙, 문서 기준)',priority:'65500',action:'Deny',protocol:'*',ports:'*',source:'*',destination:'*'}];
type TagCtx={vnet:string[]};
function azureAddr(token:string,a:Addr,tags:TagCtx):Tri{
  const t=token.trim();
  if(/^(\*|any|0\.0\.0\.0\/0)$/i.test(t))return true;
  if(/^virtualnetwork$/i.test(t)){const hits=tags.vnet.map(c=>cidrMatch(c,a));return hits.includes(true)?true:hits.includes('unknown')?'unknown':false;}
  if(/^internet$/i.test(t)){const r=addrRange(a);if(!r)return 'unknown';const inVnet=tags.vnet.some(c=>cidrMatch(c,a)!==false);return inVnet?false:a.ip?!isPrivate(a.ip):'unknown';}
  if(/^azureloadbalancer$/i.test(t))return a.ip==='168.63.129.16';
  if(rangeOf(t))return cidrMatch(t,a);
  return 'unknown';
}
const protoMatch=(rule:string,q:Protocol):Tri=>/^(\*|all|any|-1)$/i.test(rule)?true:q==='any'?'unknown':rule.toLowerCase()===q;
const portMatch=(ports:string,q:FlowQuery):Tri=>/^(\*|all)$/i.test(ports.trim())?true:q.protocol==='icmp'?true:q.port===undefined?'unknown':portMatches(ports,q.port);
const and=(...v:Tri[]):Tri=>v.includes(false)?false:v.includes('unknown')?'unknown':true;
function evaluateNsg(nsg:Resource,direction:'Inbound'|'Outbound',src:Addr,dst:Addr,q:FlowQuery,tags:TagCtx,at:string):PolicyCheck{
  const own=nsg.rules.filter(r=>r.direction.toLowerCase()===direction.toLowerCase()).map(r=>({...r,priorityN:Number(r.priority)}));
  const hasDefaults=own.some(r=>r.priorityN>=65000);
  const rules=[...own,...(hasDefaults?[]:(direction==='Inbound'?AZURE_DEFAULTS:AZURE_DEFAULTS_OUT).map(r=>({...r,direction,priority:r.priority!,priorityN:Number(r.priority)})))].sort((a,b)=>a.priorityN-b.priorityN);
  const unevaluated:string[]=[],undecidedActions=new Set<string>();
  for(const rule of rules){
    const peers=(rule as {peers?:string[]}).peers??[],hard=peers.filter((p:string)=>p.startsWith('asg')||p.startsWith('source-port'));
    const m=and(protoMatch(rule.protocol,q.protocol),portMatch(rule.ports,q),anyOf(rule.source,src,tags),anyOf(rule.destination,dst,tags),...(hard.length?['unknown' as const]:[]));
    const ref:RuleRef={name:rule.name,priority:rule.priority,action:rule.action,protocol:rule.protocol,ports:rule.ports,source:rule.source,destination:rule.destination};
    if(m===false)continue;
    if(m==='unknown'){undecidedActions.add(rule.action.toLowerCase());unevaluated.push(`${rule.name??rule.priority} (${hard.length?hard.join(', '):`${rule.source} → ${rule.destination}`})`);continue;}
    // A definitive match after an undecided rule is only the answer if that rule would have decided the same way.
    const verdict=rule.action.toLowerCase()==='allow'?'allow' as const:'deny' as const;
    // If every undecided rule above would act the same way as this one, whichever of them matches gives the same answer.
    if(unevaluated.length&&[...undecidedActions].every(a=>a===rule.action.toLowerCase()))return{policy:nsg.id,name:nsg.name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict,rule:ref,reason:`우선순위가 더 높은 규칙(${unevaluated.join('; ')})은 해석하지 못했지만 모두 ${rule.action}이라 결과는 같습니다. 확정 일치 규칙: ${rule.name}.`,unevaluated};
    if(unevaluated.length)return{policy:nsg.id,name:nsg.name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict:'unknown',rule:ref,reason:`우선순위가 더 높은 규칙을 해석하지 못했습니다: ${unevaluated.join('; ')}. 그 다음으로 일치하는 규칙은 ${rule.name} (${rule.action})입니다.`,unevaluated};
    return{policy:nsg.id,name:nsg.name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict,rule:ref,reason:`우선순위 ${rule.priority} 규칙 ${rule.name??''}이(가) 먼저 일치합니다.${hasDefaults?'':' 기본 규칙은 수집 데이터에 없어 Azure 문서 기준으로 적용했습니다.'}`};
  }
  return{policy:nsg.id,name:nsg.name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict:'unknown',reason:`일치 여부를 확정할 수 있는 규칙이 없습니다: ${unevaluated.join('; ')}`,unevaluated};
}
function anyOf(list:string,a:Addr,tags:TagCtx):Tri{const v=list.split(/,\s*/).filter(Boolean).map(t=>azureAddr(t,a,tags));return v.includes(true)?true:v.includes('unknown')?'unknown':false;}

// ---- Azure routing: user routes win over system routes of the same prefix length; the longest prefix wins first.
type Route={prefix:string;type:string;nextHopIp?:string;origin:'user'|'system';evidence:string;peer?:Resource};
function azureRoutes(c:Ctx,subnet:Resource|undefined,network:Resource|undefined):Route[]{
  const out:Route[]=[];
  for(const r of subnet?.routes??[])out.push({prefix:r.destination,type:r.via,nextHopIp:r.nextHopIp??(isIp(r.nextHop)?r.nextHop:undefined),origin:'user',evidence:`${subnet!.name}의 사용자 정의 경로 ${r.destination} → ${r.via}${r.nextHopIp?` ${r.nextHopIp}`:''}`});
  if(network){
    for(const p of spaces(network))out.push({prefix:p,type:'VnetLocal',origin:'system',evidence:`${network.name} 주소 공간 ${p} (시스템 경로)`});
    for(const {link,peer} of peersOf(c,network))for(const p of spaces(peer))out.push({prefix:p,type:'VNetPeering',origin:'system',peer,evidence:`${network.name} ↔ ${peer.name} 피어링 (${link.evidence})`});
    // On-prem prefixes arrive through a gateway in this network, or through a hub's gateway when the peering allows gateway transit.
    const gateways=[{via:network,gw:gatewayIn(c,network)},...peersOf(c,network).filter(p=>p.link.transit).map(p=>({via:p.peer,gw:gatewayIn(c,p.peer)}))].filter(g=>g.gw);
    for(const g of gateways)for(const site of sitesBehind(c,g.gw!))for(const p of spaces(site))out.push({prefix:p,type:'VirtualNetworkGateway',origin:'system',peer:g.via,evidence:`${g.gw!.name}가 ${site.name} 대역 ${p}을(를) 알림 (게이트웨이 전파는 수집 데이터로 확인하지 않음)`});
  }
  out.push({prefix:'0.0.0.0/0',type:'Internet',origin:'system',evidence:'기본 시스템 경로 0.0.0.0/0 → Internet'});
  return out;
}
const gatewayIn=(c:Ctx,network:Resource)=>c.s.resources.find(r=>r.kind==='gateway'&&networkOf(c,r)?.id===network.id&&/gateway/i.test(r.specs['종류']??''));
function sitesBehind(c:Ctx,gw:Resource){
  const out=new Set<Resource>(),seen=new Set([gw.id]),queue=[gw.id];
  while(queue.length){const id=queue.shift()!;for(const l of [...(c.out.get(id)??[]),...(c.into.get(id)??[])]){if(l.kind!=='attachment')continue;const other=c.byId.get(l.source===id?l.target:l.source);if(!other||seen.has(other.id))continue;seen.add(other.id);if(other.kind==='onprem')out.add(other);else if(other.kind==='gateway')queue.push(other.id);}}
  return[...out];
}
function pickRoute(routes:Route[],to:Addr):{route?:Route;ambiguous?:string}{
  const target=addrRange(to);if(!target)return{};
  const hits=routes.filter(r=>{const p=parseCidr(r.prefix);return p&&within(target,p);}).sort((a,b)=>prefixLen(b.prefix)-prefixLen(a.prefix)||Number(a.origin!=='user')-Number(b.origin!=='user'));
  // A site range split across routes cannot be routed as one; the analysis says so rather than picking one half.
  const partial=to.cidr&&routes.find(r=>{const p=parseCidr(r.prefix);return p&&!within(target,p)&&!disjoint(target,p)&&prefixLen(r.prefix)>prefixLen(hits[0]?.prefix??'0.0.0.0/0');});
  return{route:hits[0],ambiguous:partial?`${to.cidr} 일부는 ${partial.prefix} 경로를 따릅니다.`:undefined};
}

const undecided=(res:FlowResult,text:string)=>{res.gaps.push({text,undecided:true});if(res.status!=='blocked')res.status='unknown';};
const note=(res:FlowResult,text:string)=>{res.gaps.push({text,undecided:false});res.completeness='partial';};
function analyzeAzure(c:Ctx,q:FlowQuery,from:Endpoint,to:Endpoint,res:FlowResult){
  const tagsFor=(network?:Resource):TagCtx=>{if(!network)return{vnet:[]};const vnet=[...spaces(network),...peersOf(c,network).flatMap(p=>spaces(p.peer))];const gws=[gatewayIn(c,network),...peersOf(c,network).filter(p=>p.link.transit).map(p=>gatewayIn(c,p.peer))].filter(Boolean) as Resource[];for(const g of gws)for(const s of sitesBehind(c,g))vnet.push(...spaces(s));return{vnet};};
  const src:Addr={ip:from.ip,cidr:from.ip?undefined:from.cidr},dst:Addr={ip:to.ip,cidr:to.ip?undefined:to.cidr};
  const check=(holder:Resource|undefined,direction:'Inbound'|'Outbound',at:string,network?:Resource)=>{for(const p of policiesOn(c,holder?.id))if(p.provider==='azure'&&p.kind==='firewall')res.policies.push(evaluateNsg(p,direction,src,dst,q,tagsFor(network),at));};
  // Outbound at the source: NIC first, then subnet (also a VM-level link from snapshots written before NICs existed).
  if(from.zone==='cloud'){check(from.nic,'Outbound',`출발 NIC ${from.nic?.name??''}`,from.network);if(!from.nic&&from.resource)check(from.resource,'Outbound',`출발 ${from.resource.name}`,from.network);check(from.subnet,'Outbound',`출발 서브넷 ${from.subnet?.name??''}`,from.network);}
  let subnet=from.subnet,network=from.network;const appliances:Resource[]=[];
  for(let step=0;step<6;step++){
    if(to.network&&network&&to.network.id===network.id&&step>0){res.path.push({label:`${network.name} 내부`,kind:'subnet',evidence:'목적지가 같은 VNet에 있어 VnetLocal로 전달'});break;}
    const {route,ambiguous}=pickRoute(azureRoutes(c,subnet,network),dst);
    if(ambiguous)undecided(res,ambiguous);
    if(!route){undecided(res,`${subnet?.name??network?.name??'출발지'}에서 ${to.label}(으)로 가는 경로를 정할 수 없습니다.`);return;}
    res.path.push({label:`경로 ${route.prefix} → ${route.type}${route.nextHopIp?` ${route.nextHopIp}`:''}`,kind:'route',evidence:route.evidence,basis:'configured'});
    if(route.type==='VnetLocal'){if(to.network?.id!==network?.id&&to.zone==='cloud'&&to.network){undecided(res,'목적지가 이 VNet 주소 공간에 있지만 다른 네트워크로 수집됐습니다.');}break;}
    if(route.type==='VNetPeering'){res.path.push({id:route.peer!.id,label:`${network!.name} ↔ ${route.peer!.name} 피어링`,kind:'peering',evidence:'피어링은 직접 연결된 VNet 사이에서만 전달합니다 (비전이).'});network=route.peer;subnet=undefined;if(to.network?.id!==network?.id){res.gaps.push({text:`${route.peer!.name}에 도착했지만 목적지는 그 VNet에 없습니다.`,undecided:false});res.status='blocked';return;}break;}
    if(route.type==='VirtualAppliance'){
      const device=c.s.resources.find(r=>(r.kind==='appliance'||r.kind==='compute'||r.kind==='nic')&&(r.ip===route.nextHopIp||r.addresses?.some(a=>a.ip===route.nextHopIp)));
      if(!device){undecided(res,`다음 홉 ${route.nextHopIp}을(를) 가진 장비를 수집 결과에서 찾지 못했습니다.`);return;}
      const devNet=networkOf(c,device);
      if(devNet&&network&&devNet.id!==network.id){if(!peersOf(c,network).some(p=>p.peer.id===devNet.id)){undecided(res,`${device.name}이(가) 있는 ${devNet.name}과(와) 직접 피어링이 없어 다음 홉에 닿는지 확인할 수 없습니다.`);return;}res.path.push({id:devNet.id,label:`${network.name} ↔ ${devNet.name} 피어링`,kind:'peering',evidence:'사용자 정의 경로의 다음 홉이 피어링된 VNet에 있습니다.'});}
      if(appliances.includes(device)){undecided(res,`${device.name}을(를) 다시 거치는 경로 순환이 있습니다.`);return;}
      appliances.push(device);res.path.push({id:device.id,label:device.name,kind:'appliance',evidence:`${route.nextHopIp}은(는) ${device.name}의 주소 (UDR 다음 홉)`,basis:'inferred'});
      // The device decides with rules this collector does not read: Azure Firewall policy, or whatever runs inside an NVA.
      res.policies.push({policy:device.id,name:device.name,at:'경유 장비',direction:'through',verdict:'unknown',reason:device.specs['종류']==='Azure Firewall'?'Azure Firewall 정책(규칙 컬렉션)을 수집하지 않아 이 장비가 허용하는지 판정하지 않습니다.':'NVA 내부 정책은 클라우드 API로 확인할 수 없습니다.'});
      subnet=subnetOf(c,device);network=devNet;continue;
    }
    if(route.type==='VirtualNetworkGateway'){
      const gw=gatewayIn(c,route.peer??network!);res.path.push({id:gw?.id,label:gw?.name??'가상 네트워크 게이트웨이',kind:'gateway',evidence:route.evidence});
      if(route.peer&&route.peer.id!==network?.id)res.conditions.push(`${network?.name}이(가) ${route.peer.name}의 게이트웨이를 쓰는 것은 피어링의 게이트웨이 전송 설정에 따른 것입니다.`);
      if(to.zone!=='onprem'){undecided(res,'게이트웨이 너머의 목적지는 사내망으로 수집되지 않았습니다.');return;}
      res.path.push({id:to.resource?.id,label:to.resource?.name??'사내망',kind:'onprem',evidence:'수동 등록한 사내망 연결 (CSP API로 확인할 수 없음)',basis:'declared'});
      note(res,'사내망 쪽 라우팅과 방화벽은 수집 범위 밖입니다.');return;
    }
    if(route.type==='Internet'){
      if(to.ip&&isPrivate(to.ip)||to.zone==='onprem'){res.path.push({label:'사설 주소를 Internet 다음 홉으로 보냄',kind:'internet',evidence:'Azure는 사설 대역을 인터넷으로 내보내지 않습니다.'});res.gaps.push({text:`${network?.name??'출발 VNet'}에는 ${to.label}(으)로 가는 피어링·게이트웨이 경로가 없습니다. 피어링은 전이되지 않습니다.`,undecided:false});res.status='blocked';res.summary=`경로 없음: ${to.label}은(는) 직접 피어링된 VNet이나 게이트웨이 뒤에 없습니다.`;return;}
      // Egress: a NAT gateway on the subnet takes precedence over an instance public IP; without either, only Azure's default outbound access remains, which new networks no longer get.
      const nat=subnet?c.s.resources.find(r=>r.kind==='nat'&&r.parent===subnet!.id):undefined,pip=appliances.length?undefined:from.nic?.publicIp??from.resource?.publicIp;
      res.path.push({id:nat?.id,label:nat?nat.name:pip?`공인 IP ${pip}`:appliances.length?`${appliances[appliances.length-1].name}의 출구`:'기본 아웃바운드 접근',kind:'internet',evidence:nat?'서브넷에 연결된 NAT Gateway':pip?'NIC에 연결된 공인 IP':appliances.length?'경유 장비의 공인 IP 구성은 수집하지 않았습니다.':'NAT·공인 IP가 없어 기본 아웃바운드 접근에 기대는 경로입니다.'});
      if(!nat&&!pip&&!appliances.length)undecided(res,'NAT Gateway도 공인 IP도 없습니다. 기본 아웃바운드 접근은 2025년 9월 이후 만든 VNet에는 없고 수집 데이터로 확인할 수 없습니다.');
      note(res,'인터넷 쪽 목적지와 그 앞의 방화벽은 수집 범위 밖입니다.');return;
    }
    if(/^none$/i.test(route.type)){res.status='blocked';res.summary=`경로 ${route.prefix}이(가) 다음 홉 None(버림)으로 설정돼 있습니다.`;return;}
    undecided(res,`지원하지 않는 다음 홉 유형 ${route.type}`);return;
  }
  // Inbound at the destination: subnet first, then NIC.
  if(to.zone==='cloud'){
    if(to.service&&to.resource?.kind==='endpoint')res.conditions.push(`${to.service.name}은(는) 서브넷 밖의 서비스입니다. ${to.resource.name}(${to.ip})을 거칠 때의 결과이며, 클라이언트가 이 이름을 이 주소로 해석하는지는 확인하지 않았습니다.`);
    const before=res.policies.length;
    check(to.subnet,'Inbound',`도착 서브넷 ${to.subnet?.name??''}`,to.network);check(to.nic,'Inbound',`도착 NIC ${to.nic?.name??''}`,to.network);if(!to.nic&&to.resource&&to.resource.kind==='compute')check(to.resource,'Inbound',`도착 ${to.resource.name}`,to.network);
    // NSGs on a private endpoint's subnet apply only when the subnet enables network policies for endpoints, which is not collected.
    if(to.resource?.kind==='endpoint')for(const p of res.policies.slice(before))if(p.verdict==='deny'){p.verdict='unknown';p.reason+=' Private Endpoint 서브넷의 네트워크 정책 적용 여부를 수집하지 않아 이 차단이 적용되는지 확정할 수 없습니다.';}
    if(to.service)note(res,`${to.service.name}의 서비스 자체 방화벽(공용 네트워크 접근·네트워크 규칙)은 평가하지 않았습니다. Private Endpoint 경유 트래픽에는 보통 적용되지 않습니다.`);
  }
  // Return path: NSGs are stateful, but a reply routed around the device the request went through is dropped by a stateful firewall.
  if(to.zone==='cloud'&&from.ip){
    const {route}=pickRoute(azureRoutes(c,to.subnet,to.network),{ip:from.ip}),viaDevice=route?.type==='VirtualAppliance';
    const forwardDevice=appliances[0];
    if(forwardDevice&&!viaDevice)res.returnPath={status:'unknown',notes:[`요청은 ${forwardDevice.name}을(를) 거치지만 응답 경로(${route?.prefix??'?'} → ${route?.type??'?'})는 거치지 않습니다. 상태 기반 방화벽에서는 비대칭 경로로 차단될 수 있습니다.`]};
    else if(!forwardDevice&&viaDevice)res.returnPath={status:'unknown',notes:[`응답은 ${route!.nextHopIp}(으)로 보내지지만 요청은 그 장비를 거치지 않습니다. 비대칭 경로입니다.`]};
    else res.returnPath={status:'allowed',notes:['NSG는 상태 기반이라 허용된 요청의 응답을 따로 평가하지 않습니다.',...(route?[`응답 경로: ${route.prefix} → ${route.type}`]:[])]};
  }
}

// ---- AWS: security groups are stateful allow-lists unioned across an ENI's groups; NACLs are stateless and ordered by rule number.
const isType=(r:Resource,t:string)=>r.type===t;
const awsId=(c:Ctx,ref:Resource,raw:string)=>`aws:${ref.nativeId.split('/').slice(0,2).join('/')}/${raw}`;
type RangeQ={from:number;to:number};
// Whether a rule's port list covers a whole range (the reply's ephemeral ports), or the single destination port.
function portsCover(ports:string,want:RangeQ):Tri{
  if(/^(\*|all)$/i.test(ports.trim()))return true;
  const parts=ports.split(/,\s*/).map(p=>{const [a,b=a]=p.split(/[–-]/).map(Number);return{from:a,to:b};});
  if(parts.some(p=>p.from<=want.from&&p.to>=want.to))return true;
  return parts.every(p=>p.to<want.from||p.from>want.to)?false:'unknown';
}
const EPHEMERAL={from:1024,to:65535};
function sgCheck(c:Ctx,holder:Resource|undefined,direction:'Inbound'|'Outbound',peer:Addr&{nic?:Resource;service?:boolean},q:FlowQuery,at:string):PolicyCheck|undefined{
  const eni=holder,groups=policiesOn(c,eni?.id).filter(p=>isType(p,'AWS::EC2::SecurityGroup'));if(!eni||!groups.length)return undefined;
  const peerGroups=new Set(policiesOn(c,peer.nic?.id).filter(p=>isType(p,'AWS::EC2::SecurityGroup')).map(p=>p.nativeId.split('/').pop()));
  const unevaluated:string[]=[];
  for(const g of groups)for(const rule of g.rules.filter(r=>r.direction===direction)){
    const tokens=(direction==='Inbound'?rule.source:rule.destination).split(/,\s*/).filter(Boolean),peers=(rule as {peers?:string[]}).peers??[];
    const addr:Tri[]=tokens.filter(t=>!t.startsWith('sg-')&&!t.startsWith('pl-')).map(t=>peer.service?(t==='0.0.0.0/0'?true:'unknown'):cidrMatch(t,peer));
    const refs:Tri[]=peers.map(p=>p.startsWith('sg:')?peerGroups.has(p.slice(3)):'unknown');
    const m=and(protoMatch(rule.protocol,q.protocol),portMatch(rule.ports,q),[...addr,...refs].includes(true)?true:[...addr,...refs].includes('unknown')?'unknown':false);
    if(m===true)return{policy:g.id,name:groups.length>1?`보안 그룹 ${groups.length}개 (${groups.map(x=>x.name).join(', ')})`:g.name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict:'allow',rule:{name:g.name,action:'Allow',protocol:rule.protocol,ports:rule.ports,source:rule.source,destination:rule.destination},reason:`${g.name}의 허용 규칙이 일치합니다. 보안 그룹은 ENI에 붙은 모든 그룹의 허용 규칙을 합쳐 평가합니다.`};
    if(m==='unknown')unevaluated.push(`${g.name}: ${tokens.join(', ')||peers.join(', ')}`);
  }
  const name=groups.map(x=>x.name).join(', ');
  return unevaluated.length?{policy:groups[0].id,name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict:'unknown',reason:`확정적으로 일치하는 허용 규칙이 없고, 해석하지 못한 규칙이 있습니다: ${unevaluated.join('; ')}`,unevaluated}
    :{policy:groups[0].id,name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict:'deny',reason:'일치하는 허용 규칙이 없습니다. 보안 그룹은 허용 규칙만 있으며 나머지는 거부됩니다.'};
}
function naclCheck(c:Ctx,subnet:Resource|undefined,direction:'Inbound'|'Outbound',peer:Addr&{service?:boolean},protocol:Protocol,ports:RangeQ,at:string):PolicyCheck|undefined{
  const acl=policiesOn(c,subnet?.id).find(p=>isType(p,'AWS::EC2::NetworkAcl'));if(!acl)return undefined;
  const rules=acl.rules.filter(r=>r.direction===direction).sort((a,b)=>Number(a.priority)-Number(b.priority));const skipped:string[]=[];
  for(const rule of rules){
    const token=direction==='Inbound'?rule.source:rule.destination,addr:Tri=peer.service?(token==='0.0.0.0/0'?true:'unknown'):cidrMatch(token,peer);
    const m=and(protoMatch(rule.protocol,protocol),protocol==='icmp'?true:portsCover(rule.ports,ports),addr);
    if(m===false)continue;
    if(m==='unknown'){skipped.push(`${rule.name} (${token} ${rule.ports})`);continue;}
    const verdict=rule.action==='Allow'?'allow' as const:'deny' as const,ref={name:rule.name,priority:rule.priority,action:rule.action,protocol:rule.protocol,ports:rule.ports,source:rule.source,destination:rule.destination};
    if(skipped.length)return{policy:acl.id,name:acl.name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict:'unknown',rule:ref,reason:`번호가 더 앞선 규칙의 일치 여부를 확정하지 못했습니다: ${skipped.join('; ')}`,unevaluated:skipped};
    return{policy:acl.id,name:acl.name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict,rule:ref,reason:`규칙 ${rule.name}이(가) 먼저 일치합니다 (NACL은 상태 비저장).`};
  }
  return{policy:acl.id,name:acl.name,at,direction:direction==='Inbound'?'inbound':'outbound',verdict:'unknown',reason:`일치하는 규칙을 확정하지 못했습니다: ${skipped.join('; ')||'규칙 없음'}`};
}
function awsRoutes(c:Ctx,subnet?:Resource,network?:Resource){
  // The local route always covers the VPC's own ranges; a table's 'local' entry is read as that, whatever prefix it lists.
  const out:{prefix:string;type:string;target?:string;hop:string;origin:string}[]=spaces(network).map(p=>({prefix:p,type:'local',hop:'local',origin:'system'}));
  for(const r of subnet?.routes??[])if(r.nextHop!=='local')out.push({prefix:r.destination,type:r.via,target:r.target,hop:r.nextHop,origin:r.origin??'user'});
  return out;
}
function analyzeAws(c:Ctx,q:FlowQuery,from:Endpoint,to:Endpoint,res:FlowResult){
  const push=(p?:PolicyCheck)=>{if(p)res.policies.push(p);};
  const service=!!to.service&&!to.ip,src:Addr&{nic?:Resource}={ip:from.ip,nic:from.nic},dst:Addr&{nic?:Resource;service?:boolean}={ip:to.ip,cidr:to.ip?undefined:to.cidr,nic:to.nic,service};
  const qPort=q.port===undefined?undefined:{from:q.port,to:q.port};
  push(sgCheck(c,from.nic,'Outbound',dst,q,`출발 ENI ${from.nic?.name??''}`));
  const sameSubnet=!!to.subnet&&to.subnet.id===from.subnet?.id;
  // NACLs sit on subnet boundaries: traffic within one subnet never meets them.
  if(!sameSubnet&&qPort)push(naclCheck(c,from.subnet,'Outbound',dst,q.protocol,qPort,`출발 서브넷 ${from.subnet?.name??''} NACL`));
  // Pick the route: longest prefix; a prefix-list route serves the AWS service it names.
  const routes=awsRoutes(c,from.subnet,from.network);
  let route;
  if(service){route=routes.find(r=>r.prefix.startsWith('pl-')&&r.hop.startsWith('vpce-'));if(!route){undecided(res,`${to.label}에 대한 게이트웨이 엔드포인트 경로가 없어 인터넷(NAT·IGW)을 거치는 공용 경로로만 접근합니다. 그 경로와 서비스 쪽 정책은 평가하지 않습니다.`);return;}}
  else{const target=addrRange(dst);route=routes.filter(r=>{const p=parseCidr(r.prefix);return p&&target&&within(target,p);}).sort((a,b)=>prefixLen(b.prefix)-prefixLen(a.prefix))[0];}
  if(!route){undecided(res,`${from.subnet?.name??'출발 서브넷'}의 라우트 테이블에 ${to.label}(으)로 가는 경로가 없습니다.`);return;}
  res.path.push({label:`경로 ${route.prefix} → ${route.hop}`,kind:'route',evidence:route.type==='local'?`${from.network?.name} VPC 로컬 경로`:`${from.subnet?.name}의 라우트 테이블`,basis:'configured'});
  const hop=route.hop;
  if(route.type==='local'){if(to.network&&to.network.id!==from.network?.id)undecided(res,'목적지가 VPC 대역에 있지만 다른 VPC로 수집됐습니다.');}
  else if(hop.startsWith('vpce-')){const ep=c.byId.get(awsId(c,from.subnet!,hop));res.path.push({id:ep?.id,label:ep?.name??hop,kind:'endpoint',evidence:'게이트웨이 엔드포인트 (ENI·주소 없음, 라우트 테이블 대상)'});note(res,'엔드포인트 정책과 버킷 정책은 평가하지 않았습니다.');}
  else if(hop.startsWith('pcx-')){
    const peer=peersOf(c,from.network!).find(p=>to.network&&p.peer.id===to.network.id);
    if(!peer){res.gaps.push({text:'피어링은 직접 연결된 VPC 사이에서만 전달합니다. 목적지는 이 피어링의 상대 VPC가 아닙니다.',undecided:false});res.status='blocked';res.summary='비전이 피어링: 목적지 VPC로 직접 피어링되어 있지 않습니다.';return;}
    res.path.push({id:peer.peer.id,label:`${from.network!.name} ↔ ${peer.peer.name} 피어링`,kind:'peering',evidence:peer.link.evidence});
  }else if(hop.startsWith('tgw-')){
    const tgw=c.s.resources.find(r=>r.kind==='gateway'&&r.nativeId.endsWith(`/${hop}`));res.path.push({id:tgw?.id,label:tgw?.name??hop,kind:'gateway',evidence:'Transit Gateway 연결'});
    const attached=tgw?c.s.links.filter(l=>l.source===tgw.id&&l.kind==='attachment').map(l=>l.target):[];
    if(to.zone==='onprem'){const sites=tgw?sitesBehind(c,tgw):[];if(!sites.some(x=>x.id===to.resource?.id)){undecided(res,'이 Transit Gateway 뒤에 목적지 사내망이 연결된 것을 확인하지 못했습니다.');return;}res.path.push({id:to.resource?.id,label:to.resource?.name??'사내망',kind:'onprem',evidence:'VPN·DX 연결 너머 (수동 등록한 사내망)',basis:'declared'});undecided(res,'Transit Gateway 라우트 테이블을 수집하지 않아 사내망으로 전달하는지 확정할 수 없습니다.');note(res,'사내망 쪽 라우팅과 방화벽은 수집 범위 밖입니다.');return;}
    if(to.network&&!attached.includes(to.network.id)){undecided(res,`${to.network.name}이(가) 이 Transit Gateway에 연결된 것을 확인하지 못했습니다.`);return;}
    undecided(res,'Transit Gateway 라우트 테이블(연결·전파)을 수집하지 않아 TGW가 이 대상으로 전달하는지 확정할 수 없습니다.');
  }else if(hop.startsWith('igw-')||hop.startsWith('nat-')){
    if(to.ip&&isPrivate(to.ip)){res.status='blocked';res.summary=`사설 주소 ${to.ip}을(를) ${hop}(으)로 보내는 경로뿐입니다.`;return;}
    if(hop.startsWith('igw-')&&!(from.nic?.publicIp??from.resource?.publicIp)){res.status='blocked';res.summary='인터넷 게이트웨이로 가는 경로지만 출발 ENI에 공인 IP가 없습니다.';return;}
    res.path.push({label:hop.startsWith('nat-')?`NAT ${hop}`:`인터넷 게이트웨이 ${hop}`,kind:'internet',evidence:'라우트 테이블 대상'});note(res,'인터넷 쪽 목적지는 수집 범위 밖입니다.');return;
  }else{undecided(res,`지원하지 않는 다음 홉 ${hop}`);return;}
  if(to.zone!=='cloud'||service){if(service)res.path.push({id:to.service!.id,label:to.service!.name,kind:'service',evidence:'S3 서비스 (리전 엔드포인트)'});return;}
  if(!sameSubnet&&qPort)push(naclCheck(c,to.subnet,'Inbound',src,q.protocol,qPort,`도착 서브넷 ${to.subnet?.name??''} NACL`));
  // An RDS instance or load balancer carries its groups itself rather than on an ENI the collector sees.
  push(sgCheck(c,to.nic??to.resource,'Inbound',src,q,`도착 ${to.nic?`ENI ${to.nic.name}`:to.resource?.name??''}`));
  if(!to.ip&&to.cidr)res.conditions.push(`${to.label}의 주소를 수집하지 않아 ${to.cidr} 범위 전체로 판정했습니다. 범위 일부에만 맞는 규칙은 판단 불가로 남습니다.`);
  // Replies: security groups are stateful, NACLs are not, so the reply's ephemeral ports must pass both subnets' ACLs.
  if(!sameSubnet&&q.protocol!=='icmp'){
    const back=[naclCheck(c,to.subnet,'Outbound',src,q.protocol,EPHEMERAL,`응답: 도착 서브넷 NACL`),naclCheck(c,from.subnet,'Inbound',dst,q.protocol,EPHEMERAL,`응답: 출발 서브넷 NACL`)].filter(Boolean) as PolicyCheck[];
    const bad=back.find(b=>b.verdict!=='allow');
    res.returnPath={status:bad?(bad.verdict==='deny'?'blocked':'unknown'):'allowed',notes:bad?[`${bad.at}: ${bad.reason} (임시 포트 1024-65535)`]:['보안 그룹은 상태 기반이고, NACL은 응답의 임시 포트(1024-65535)를 허용합니다.']};
    if(bad?.verdict==='deny'){res.status='blocked';res.summary=`요청은 통과하지만 응답이 ${bad.name}에서 차단됩니다 (NACL은 상태 비저장).`;}
  }else res.returnPath={status:'allowed',notes:['같은 서브넷 안이라 NACL을 거치지 않고, 보안 그룹은 상태 기반입니다.']};
}
// ---- GCP
const gcpIdentity=(c:Ctx,instance?:Resource)=>instance?(c.out.get(instance.id)??[]).filter(l=>l.kind==='uses_identity').map(l=>c.byId.get(l.target)?.specs['이메일']).filter((x):x is string=>!!x):[];
function gcpFirewall(c:Ctx,network:Resource|undefined,direction:'INGRESS'|'EGRESS',target:Resource|undefined,peer:Addr&{instance?:Resource},q:FlowQuery,at:string):PolicyCheck{
  const tags=new Set(target?.netTags??[]),sas=new Set(gcpIdentity(c,target)),peerTags=new Set(peer.instance?.netTags??[]),peerSas=new Set(gcpIdentity(c,peer.instance));
  const applies=(fw:Resource)=>{const t=fw.appliesTo;if(!t?.tags?.length&&!t?.serviceAccounts?.length)return true;return!!(t.tags?.some(x=>tags.has(x))||t.serviceAccounts?.some(x=>sas.has(x)));};
  const firewalls=policiesOn(c,network?.id).filter(p=>p.type==='compute.googleapis.com/Firewall'&&p.status!=='disabled'&&applies(p));
  const rules=firewalls.flatMap(fw=>fw.rules.filter(r=>r.direction.toUpperCase()===direction).map(r=>({fw,r,n:Number(r.priority)}))).sort((a,b)=>a.n-b.n||Number(a.r.action==='Allow')-Number(b.r.action==='Allow'));
  const unevaluated:string[]=[],actions=new Set<string>();
  for(const {fw,r} of rules){
    const ranges=(direction==='INGRESS'?r.source:r.destination).split(/,\s*/).filter(Boolean),peers=(r as {peers?:string[]}).peers??[];
    const byRange:Tri[]=ranges.map(t=>t==='*'?true:cidrMatch(t,peer)),byPeer:Tri[]=direction==='INGRESS'?peers.map(p=>p.startsWith('tag:')?peerTags.has(p.slice(4)):p.startsWith('sa:')?peerSas.has(p.slice(3)):'unknown'):[];
    const all=[...byRange,...byPeer],who:Tri=all.includes(true)?true:all.includes('unknown')?'unknown':false;
    const m=and(protoMatch(r.protocol,q.protocol),portMatch(r.ports,q),who);
    if(m===false)continue;
    if(m==='unknown'){unevaluated.push(`${fw.name}`);actions.add(r.action);continue;}
    const verdict=r.action==='Allow'?'allow' as const:'deny' as const,ref={name:fw.name,priority:r.priority,action:r.action,protocol:r.protocol,ports:r.ports,source:r.source||peers.join(', '),destination:r.destination};
    if(unevaluated.length&&![...actions].every(a=>a===r.action))return{policy:fw.id,name:fw.name,at,direction:direction==='INGRESS'?'inbound':'outbound',verdict:'unknown',rule:ref,reason:`우선순위가 더 높은 규칙을 확정하지 못했습니다: ${unevaluated.join(', ')}`,unevaluated};
    return{policy:fw.id,name:fw.name,at,direction:direction==='INGRESS'?'inbound':'outbound',verdict,rule:ref,reason:`${target?.name??'대상'}에 적용되는 규칙 중 우선순위 ${r.priority} ${fw.name}이(가) 먼저 일치합니다${fw.appliesTo?.tags?` (대상 태그 ${fw.appliesTo.tags.join(', ')})`:''}.`};
  }
  // The implied rules close every VPC: ingress is denied, egress allowed, at the lowest priority.
  const implied=direction==='INGRESS'?'deny' as const:'allow' as const;
  if(unevaluated.length&&!actions.has(implied==='deny'?'Deny':'Allow')&&actions.size)return{name:'VPC 방화벽',at,direction:direction==='INGRESS'?'inbound':'outbound',verdict:'unknown',reason:`확정하지 못한 규칙이 있습니다: ${unevaluated.join(', ')}`,unevaluated};
  return{name:`암묵적 ${direction==='INGRESS'?'인그레스 거부':'이그레스 허용'}`,at,direction:direction==='INGRESS'?'inbound':'outbound',verdict:implied,reason:`${target?.name??'대상'}에 적용되면서 일치하는 방화벽 규칙이 없어 GCP의 암묵적 규칙(우선순위 65535)이 적용됩니다.${firewalls.length?'':' 이 인스턴스에 적용되는 규칙 자체가 없습니다.'}`};
}
function analyzeGcp(c:Ctx,q:FlowQuery,from:Endpoint,to:Endpoint,res:FlowResult){
  const instance=from.resource?.kind==='compute'?from.resource:undefined,tags=new Set(instance?.netTags??[]);
  const dst:Addr={ip:to.ip,cidr:to.ip?undefined:to.cidr};
  res.policies.push(gcpFirewall(c,from.network,'EGRESS',instance,{...dst,instance:to.resource?.kind==='compute'?to.resource:undefined},q,`출발 ${instance?.name??''} 이그레스`));
  note(res,'계층형 방화벽 정책과 네트워크 방화벽 정책은 수집하지 않았습니다. VPC 방화벽 규칙보다 먼저 평가될 수 있습니다.');
  const network=from.network;if(!network){undecided(res,'출발 인스턴스의 VPC를 찾지 못했습니다.');return;}
  const subnetsOf=(n:Resource)=>c.s.resources.filter(r=>r.kind==='subnet'&&r.parent===n.id&&r.cidr);
  const candidates=[...subnetsOf(network).map(sn=>({prefix:sn.cidr!,type:'subnet',priority:0,label:`${sn.name} 서브넷 경로`,peer:undefined as Resource|undefined})),
    ...peersOf(c,network).flatMap(p=>subnetsOf(p.peer).map(sn=>({prefix:sn.cidr!,type:'peering',priority:0,label:`${p.peer.name} 피어링 (서브넷 경로 교환)`,peer:p.peer}))),
    ...network.routes.filter(r=>!r.tags?.length||r.tags.some(t=>tags.has(t))).map(r=>({prefix:r.destination,type:r.via,priority:r.priority??1000,label:`경로 ${r.destination} → ${r.nextHop}`,peer:undefined}))];
  const target=addrRange(dst),route=candidates.filter(r=>{const p=parseCidr(r.prefix);return p&&target&&within(target,p);}).sort((a,b)=>prefixLen(b.prefix)-prefixLen(a.prefix)||a.priority-b.priority)[0];
  // Routes learnt over BGP by a Cloud Router are not in Asset Inventory, so a private destination that only the default route covers is undecided, not unroutable, wherever a router exists.
  const router=c.s.resources.find(r=>r.kind==='gateway'&&r.parent===network.id&&/Cloud Router/.test(r.specs['종류']??''));
  if((!route||(route.type==='Gateway'&&(to.zone==='onprem'||(to.ip&&isPrivate(to.ip)))))&&router){res.path.push({id:router.id,label:router.name,kind:'gateway',evidence:'Cloud Router (BGP 동적 경로)'});undecided(res,'Cloud Router가 BGP로 받는 동적 경로는 Asset Inventory에 없어 이 목적지로 가는 경로를 확정할 수 없습니다.');return;}
  if(!route){undecided(res,`${network.name}에 ${to.label}(으)로 가는 경로가 없습니다.`);return;}
  res.path.push({label:route.label,kind:'route',evidence:`최장 접두사 ${route.prefix}, 우선순위 ${route.priority}`,basis:'configured'});
  if(route.type==='peering'){if(to.network?.id!==route.peer?.id){res.status='blocked';res.summary='피어링은 전이되지 않습니다.';return;}res.path.push({id:route.peer!.id,label:`${network.name} ↔ ${route.peer!.name} 피어링`,kind:'peering',evidence:'VPC 피어링은 직접 연결된 네트워크의 서브넷 경로만 교환합니다.'});}
  else if(route.type==='Gateway'){
    if(to.ip&&isPrivate(to.ip)){res.status='blocked';res.summary=`사설 주소 ${to.ip}(으)로 가는 경로가 인터넷 게이트웨이뿐입니다.`;return;}
    res.path.push({label:from.nic?.publicIp?`외부 IP ${from.nic.publicIp}`:'인터넷 게이트웨이',kind:'internet',evidence:'기본 인터넷 경로'});
    if(!from.nic?.publicIp)undecided(res,'외부 IP가 없어 Cloud NAT가 필요하지만 Cloud NAT 구성은 수집하지 않았습니다.');
    note(res,'인터넷 쪽 목적지는 수집 범위 밖입니다.');return;
  }
  else if(route.type!=='subnet'){undecided(res,`다음 홉 유형 ${route.type}은(는) 아직 분석하지 않습니다.`);return;}
  if(to.zone!=='cloud')return;
  res.policies.push(gcpFirewall(c,to.network,'INGRESS',to.resource?.kind==='compute'?to.resource:undefined,{ip:from.ip,instance},q,`도착 ${to.resource?.name??''} 인그레스`));
  res.returnPath={status:'allowed',notes:['VPC 방화벽 규칙은 상태 기반이라 허용된 연결의 응답을 따로 평가하지 않습니다.']};
}
// ---- Kubernetes: NetworkPolicy isolates a pod only once some policy selects it; then the union of their rules is what is allowed.
const nsOfPod=(c:Ctx,pod:Resource)=>c.s.resources.find(r=>r.kind==='namespace'&&r.name===pod.specs['네임스페이스']&&r.nativeId.split('/')[1]===pod.nativeId.split('/')[1]);
const labelsMatch=(sel:Record<string,string>,labels:Record<string,string>)=>Object.entries(sel).every(([k,v])=>labels[k]===v);
function peerMatches(c:Ctx,peer:string,policyNs:string,other:Resource|undefined,otherIp?:string):Tri{
  if(peer==='any')return true;
  let pod:Tri=true,ns:Tri=true,cidr:Tri=true;
  for(const part of peer.split('&')){
    if(part.startsWith('cidr:')){const [range,except]=part.slice(5).split('!');cidr=otherIp?(cidrMatch(range,{ip:otherIp})===true&&!(except??'').split('|').filter(Boolean).some(e=>cidrMatch(e,{ip:otherIp})===true)):'unknown';}
    else if(part.startsWith('pod:')){const sel=JSON.parse(part.slice(4));pod=other?.kind==='pod'?labelsMatch(sel,other.tags)&&(peer.includes('ns:')||other.specs['네임스페이스']===policyNs):false;}
    else if(part.startsWith('ns:')){const sel=JSON.parse(part.slice(3)),n=other?.kind==='pod'?nsOfPod(c,other):undefined;ns=n?labelsMatch(sel,n.tags):other?.kind==='pod'?'unknown':false;}
  }
  return and(pod,ns,cidr);
}
function networkPolicies(c:Ctx,pod:Resource,direction:'Ingress'|'Egress',other:Resource|undefined,otherIp:string|undefined,port:number|undefined,enforced:boolean,at:string):PolicyCheck{
  const selecting=policiesOn(c,pod.id).filter(p=>p.type==='k8s/NetworkPolicy'&&(p.appliesTo?.policyTypes??['Ingress']).includes(direction));
  if(!selecting.length)return{name:`NetworkPolicy (${direction==='Ingress'?'인그레스':'이그레스'})`,at,direction:direction==='Ingress'?'inbound':'outbound',verdict:'allow',reason:`${pod.name}을(를) 선택한 ${direction} NetworkPolicy가 없어 격리되지 않습니다.`};
  const unevaluated:string[]=[];
  for(const p of selecting)for(const rule of p.rules.filter(r=>r.direction===direction)){
    const who=(rule.peers??['any']).map(x=>peerMatches(c,x,p.appliesTo?.namespace??'',other,otherIp)),ports:Tri=rule.ports==='*'?true:port===undefined?'unknown':rule.ports.split(/,\s*/).some(x=>{const n=x.split('/')[0];return n==='*'||Number(n)===port;});
    const m=and(who.includes(true)?true:who.includes('unknown')?'unknown':false,ports);
    if(m===true)return{policy:p.id,name:p.name,at,direction:direction==='Ingress'?'inbound':'outbound',verdict:'allow',rule:{name:p.name,action:'Allow',protocol:rule.protocol,ports:rule.ports,source:rule.source,destination:rule.destination},reason:`${p.name}의 ${direction} 규칙이 허용합니다. 선택된 Pod에는 이를 선택한 모든 정책의 규칙 합집합이 적용됩니다.`};
    if(m==='unknown')unevaluated.push(p.name);
  }
  const names=selecting.map(p=>p.name).join(', ');
  if(unevaluated.length)return{policy:selecting[0].id,name:names,at,direction:direction==='Ingress'?'inbound':'outbound',verdict:'unknown',reason:`확정하지 못한 규칙이 있습니다: ${unevaluated.join(', ')}`,unevaluated};
  // A policy that exists is only enforced if the cluster runs a policy engine; that is not assumed.
  if(!enforced)return{policy:selecting[0].id,name:names,at,direction:direction==='Ingress'?'inbound':'outbound',verdict:'unknown',reason:`${names}이(가) 허용하지 않지만, 클러스터의 NetworkPolicy 엔진이 확인되지 않아 실제로 차단되는지 확정하지 않습니다.`};
  return{policy:selecting[0].id,name:names,at,direction:direction==='Ingress'?'inbound':'outbound',verdict:'deny',reason:`${pod.name}을(를) 선택한 정책(${names}) 어느 것도 이 ${direction==='Ingress'?'출발지':'목적지'}와 포트를 허용하지 않습니다.`};
}
function analyzeKubernetes(c:Ctx,q:FlowQuery,from:Endpoint,res:FlowResult){
  const src=from.resource!,target=c.byId.get(q.to),cluster=src.nativeId.split('/')[1];
  if(!target||!['pod','k8sservice'].includes(target.kind)||target.nativeId.split('/')[1]!==cluster){undecided(res,'Pod에서 같은 클러스터 밖으로 가는 경로(노드 서브넷·NAT·클라우드 정책)는 아직 분석하지 않습니다.');return;}
  const engine=c.s.resources.find(r=>r.kind==='cluster'&&(c.s.links.some(l=>l.kind==='contains'&&l.source===r.id&&c.byId.get(l.target)?.nativeId.split('/')[1]===cluster)))?.specs['NetworkPolicy 엔진'];
  const enforced=!!engine&&!/없음|미수집/.test(engine);
  let backends=[target],port=q.port;
  if(target.kind==='k8sservice'){
    backends=(c.out.get(target.id)??[]).filter(l=>l.kind==='forwards_to').map(l=>c.byId.get(l.target)).filter((p):p is Resource=>p?.kind==='pod');
    // The Service port is translated to the pod's targetPort before any policy sees it.
    const map=(target.specs['포트']??'').split(/,\s*/).map(x=>x.match(/^(\d+)\/\w+→(\d+)/)).find(m=>m&&Number(m[1])===q.port);if(map)port=Number(map[2]);
    res.path.push({id:target.id,label:target.name,kind:'service',evidence:`EndpointSlice 백엔드 ${backends.length}개 · 논리적 전달 (kube-proxy·CNI가 DNAT, 패킷 홉 아님)${map?` · 포트 ${q.port}→${port}`:''}`,basis:'configured'});
    if(!backends.length){res.status='blocked';res.summary=`${target.name}의 EndpointSlice에 준비된 백엔드가 없습니다.`;return;}
  }
  const dst=backends[0];
  res.policies.push(networkPolicies(c,src,'Egress',dst,dst.ip,port,enforced,`출발 Pod ${src.name} 이그레스`));
  res.policies.push(networkPolicies(c,dst,'Ingress',src,src.ip,port,enforced,`도착 Pod ${dst.name} 인그레스`));
  if(backends.length>1)res.conditions.push(`백엔드 ${backends.length}개 중 ${dst.name} 기준으로 평가했습니다. 같은 워크로드라면 같은 정책이 적용됩니다.`);
  res.path.push({id:dst.id,label:dst.name,kind:'destination',evidence:`${dst.ip??'IP 미수집'} · 노드 ${dst.specs['노드']??'?'}`});
  note(res,'노드 사이의 CNI 데이터 경로와 노드 서브넷 NSG·보안 그룹은 이 분석에 포함하지 않았습니다.');
  if(!enforced)note(res,`클러스터의 NetworkPolicy 엔진: ${engine??'미확인'}. 정책이 있어도 강제되는지 확인되지 않았습니다.`);
  res.returnPath={status:'allowed',notes:['NetworkPolicy는 허용된 연결의 응답을 따로 평가하지 않습니다.']};
}
export function analyzeFlow(s:Snapshot,q:FlowQuery,now=new Date()):FlowResult{
  const c=index(s),from=resolveEndpoint(s,q.from,c),to=resolveEndpoint(s,q.to,c);
  const res:FlowResult={query:q,status:'allowed',summary:'',from,to,path:[{id:from.resource?.id,label:from.label,kind:'source',evidence:from.nic?`${from.nic.name} · ${from.ip}`:from.ip??from.cidr??''}],policies:[],returnPath:{status:'unknown',notes:[]},gaps:[],conditions:[],observed:'not-integrated',dataAt:Object.fromEntries(s.connections.map(x=>[x.provider,x.collectedAt])),analyzedAt:now.toISOString(),completeness:'full'};
  if(s.mode==='mock')res.conditions.push('예시 데이터에 대한 분석입니다.');
  if(from.zone==='unknown'||to.zone==='unknown')undecided(res,`${from.zone==='unknown'?from.label:to.label}을(를) 수집된 자원이나 주소로 찾지 못했습니다.`);
  else if(from.resource?.kind==='pod')analyzeKubernetes(c,q,from,res);
  else if(from.zone!=='cloud')undecided(res,'출발지가 클라우드 밖이면 그쪽 라우팅을 알 수 없어 분석하지 않습니다. 클라우드 쪽에서 출발하는 방향으로 분석하세요.');
  else if(from.provider==='aws'&&(to.provider==='aws'||to.zone==='internet'||to.zone==='onprem'))analyzeAws(c,q,from,to,res);
  else if(from.provider==='gcp'&&(to.provider==='gcp'||to.zone==='internet'||to.zone==='onprem'))analyzeGcp(c,q,from,to,res);
  else if((to.provider&&to.provider!==from.provider&&to.provider!=='onprem')||(to.zone==='internet'&&to.service))undecided(res,to.service&&to.zone==='internet'?`${to.service.name}에 Private Endpoint가 없어 공용 엔드포인트로만 접근합니다. 공용 경로와 서비스 방화벽은 평가하지 않습니다.`:'클라우드 사이 경로(전용선·VPN 상호 연결)는 아직 분석하지 않습니다.');
  else if(from.provider==='azure')analyzeAzure(c,q,from,to,res);
  else undecided(res,`${from.provider} 경로 분석은 아직 지원하지 않습니다.`);
  if(to.zone!=='cloud'&&res.returnPath.notes.length===0)res.returnPath={status:'unknown',notes:['목적지가 수집 범위 밖이라 응답 경로를 확인하지 않습니다.']};
  if(res.status!=='blocked'&&from.resource?.kind!=='pod'&&res.path[res.path.length-1]?.kind!=='destination'&&!['onprem','internet'].includes(res.path[res.path.length-1]?.kind))res.path.push({id:to.resource?.id,label:to.label,kind:to.resource?.kind==='endpoint'?'endpoint':'destination',evidence:to.nic?`${to.nic.name} · ${to.ip}`:to.ip??to.cidr??''});
  if(to.service&&to.resource?.kind==='endpoint')res.path.push({id:to.service.id,label:to.service.name,kind:'service',evidence:'Private Link 연결',basis:'configured'});
  // A verdict is only as strong as its weakest part: one definite deny blocks, anything undecided makes the whole undecided.
  const denied=res.policies.find(p=>p.verdict==='deny');
  if(res.status!=='blocked'){
    if(denied){res.status='blocked';res.summary=denied.rule?`${denied.name}의 ${denied.rule.name??'규칙'}이(가) ${denied.direction==='inbound'?'들어오는':'나가는'} 트래픽을 차단합니다.`:`${denied.name}: ${denied.direction==='inbound'?'들어오는':'나가는'} 트래픽을 허용하는 규칙이 없습니다.`;}
    // A reply path only counts where the destination is collected; the far side of a gateway or the internet is out of reach either way.
    else if(res.status==='unknown'||res.policies.some(p=>p.verdict==='unknown')||(to.zone==='cloud'&&res.returnPath.status==='unknown')){res.status='unknown';res.summary=res.summary||'판단에 필요한 정보 일부를 수집하지 않았거나 해석할 수 없습니다. 아래 미확인 항목을 보세요.';}
    else res.summary=res.summary||`구성상 허용${res.completeness==='partial'?' (부분 평가)':''}: 경로와 정책 ${res.policies.length}개가 이 트래픽을 허용합니다.`;
  }
  if(!res.summary)res.summary='구성상 차단';
  return res;
}
