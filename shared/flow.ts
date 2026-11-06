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
    return{ref,label:r.name,resource:r,nic:r.kind==='nic'?r:undefined,ip:r.ip,cidr:r.kind==='subnet'?r.cidr:undefined,subnet,network:networkOf(c,subnet??r),provider:r.provider,zone:'cloud'};
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

export function analyzeFlow(s:Snapshot,q:FlowQuery,now=new Date()):FlowResult{
  const c=index(s),from=resolveEndpoint(s,q.from,c),to=resolveEndpoint(s,q.to,c);
  const res:FlowResult={query:q,status:'allowed',summary:'',from,to,path:[{id:from.resource?.id,label:from.label,kind:'source',evidence:from.nic?`${from.nic.name} · ${from.ip}`:from.ip??from.cidr??''}],policies:[],returnPath:{status:'unknown',notes:[]},gaps:[],conditions:[],observed:'not-integrated',dataAt:Object.fromEntries(s.connections.map(x=>[x.provider,x.collectedAt])),analyzedAt:now.toISOString(),completeness:'full'};
  if(s.mode==='mock')res.conditions.push('예시 데이터에 대한 분석입니다.');
  if(from.zone==='unknown'||to.zone==='unknown')undecided(res,`${from.zone==='unknown'?from.label:to.label}을(를) 수집된 자원이나 주소로 찾지 못했습니다.`);
  else if(from.zone!=='cloud')undecided(res,'출발지가 클라우드 밖이면 그쪽 라우팅을 알 수 없어 분석하지 않습니다. 클라우드 쪽에서 출발하는 방향으로 분석하세요.');
  else if((to.provider&&to.provider!==from.provider&&to.provider!=='onprem')||(to.zone==='internet'&&to.service))undecided(res,to.service&&to.zone==='internet'?`${to.service.name}에 Private Endpoint가 없어 공용 엔드포인트로만 접근합니다. 공용 경로와 서비스 방화벽은 평가하지 않습니다.`:'클라우드 사이 경로(전용선·VPN 상호 연결)는 아직 분석하지 않습니다.');
  else if(from.provider==='azure')analyzeAzure(c,q,from,to,res);
  else undecided(res,`${from.provider} 경로 분석은 아직 지원하지 않습니다.`);
  if(to.zone!=='cloud'&&res.returnPath.notes.length===0)res.returnPath={status:'unknown',notes:['목적지가 수집 범위 밖이라 응답 경로를 확인하지 않습니다.']};
  if(res.status!=='blocked'&&res.path[res.path.length-1]?.kind!=='destination'&&!['onprem','internet'].includes(res.path[res.path.length-1]?.kind))res.path.push({id:to.resource?.id,label:to.label,kind:to.resource?.kind==='endpoint'?'endpoint':'destination',evidence:to.nic?`${to.nic.name} · ${to.ip}`:to.ip??to.cidr??''});
  if(to.service&&to.resource?.kind==='endpoint')res.path.push({id:to.service.id,label:to.service.name,kind:'service',evidence:'Private Link 연결',basis:'configured'});
  // A verdict is only as strong as its weakest part: one definite deny blocks, anything undecided makes the whole undecided.
  const denied=res.policies.find(p=>p.verdict==='deny');
  if(res.status!=='blocked'){
    if(denied){res.status='blocked';res.summary=`${denied.name}의 ${denied.rule?.name??'규칙'}이(가) ${denied.direction==='inbound'?'들어오는':'나가는'} 트래픽을 차단합니다.`;}
    // A reply path only counts where the destination is collected; the far side of a gateway or the internet is out of reach either way.
    else if(res.status==='unknown'||res.policies.some(p=>p.verdict==='unknown')||(to.zone==='cloud'&&res.returnPath.status==='unknown')){res.status='unknown';res.summary=res.summary||'판단에 필요한 정보 일부를 수집하지 않았거나 해석할 수 없습니다. 아래 미확인 항목을 보세요.';}
    else res.summary=res.summary||`구성상 허용${res.completeness==='partial'?' (부분 평가)':''}: 경로와 정책 ${res.policies.length}개가 이 트래픽을 허용합니다.`;
  }
  if(!res.summary)res.summary='구성상 차단';
  return res;
}
