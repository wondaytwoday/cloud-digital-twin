import type { Activity, Coverage, Dataset } from '../shared/schema.js';
import { ResourceSchema, type CostRow, type HierarchyNode, type IamAssignment, type Resource, type Link, type Provider } from '../shared/schema.js';
import { azureSkus, gcpMachines, skuSpecs } from './skus.js';
// Disk sizes arrive per disk and sometimes as strings; an instance with none reported gets no disk entry rather than a zero.
const diskSpec=(sizes:unknown[]):Record<string,string>=>{const n=sizes.map(Number).filter(v=>v>0);return n.length?{'디스크':`${n.reduce((a,b)=>a+b,0)} GiB`}:{};};
type Raw = Record<string, any>;
export type Gap=Exclude<Coverage,'ok'>;
// gaps names the kinds of data that could not be read, set by the collector that knows how many scopes it tried.
export type Normalized={resources:Resource[];links:Link[];warnings:string[];scopeLabels:Record<string,string>;hierarchy?:HierarchyNode[];incomplete?:string[];cost?:CostRow[];iam?:IamAssignment[];activity?:Activity[];gaps?:Partial<Record<Dataset,Gap>>;crossRefs?:import('../shared/schema.js').CrossRef[];awsInventory?:{account:string;rows:Raw[]}}
// Several reads of one kind of data: all failed is a failure, some failed is partial. Undefined entries are reads that worked.
export function combineGaps(states:(Gap|undefined)[]):Gap|undefined{
  const tried=states.length,failed=states.filter(s=>s==='failed').length;
  if(tried&&failed===tried)return 'failed';
  return states.some(s=>s==='failed'||s==='partial')?'partial':states.find(s=>s==='unconfigured');
};
const leafKind:Record<string,HierarchyNode['kind']>={azure:'subscription',aws:'account',gcp:'project'};
export const scopeNodeId=(provider:string,scope:string)=>`${provider}:scope:${scope}`;
const base=(provider:Provider,id:string,name:string,kind:Resource['kind'],type:string,scope:string,region:string,source:string,extra:Partial<Resource>={}):Resource=>ResourceSchema.parse({id:`${provider}:${id}`,nativeId:id,name,provider,kind,type,scope,region,source,...extra});
const name=(r:Raw)=>r.Tags?.find((t:Raw)=>t.Key==='Name')?.Value;
// Every relation says where it came from. Collector links are configured unless the call says otherwise (an IP matched to a device is inferred).
const relation=(source:string,target:string,kind:Link['kind'],label:string,evidence:string,extra:boolean|Partial<Link>={}):Link=>({id:`${kind}:${source}:${target}`,source,target,kind,label,evidence,basis:'configured',...(typeof extra==='boolean'?(extra?{transit:true}:{}):extra)});
// Managed services reached through Private Link. They live outside any subnet; only their private endpoint has an address in one.
const azurePrivateServices:Record<string,[Resource['kind'],string]>={'microsoft.cache/redis':['database','Azure Cache for Redis'],'microsoft.documentdb/databaseaccounts':['database','Cosmos DB'],'microsoft.storage/storageaccounts':['bucket','Storage account (Blob·Files)'],'microsoft.sql/servers':['database','Azure SQL']};
// Rows folded into other resources, so they never appear as items of their own.
// IP groups and application security groups are folded into the rules and NICs that use them.
const AZURE_CONSUMED=new Set(['microsoft.network/routetables','microsoft.network/firewallpolicies','microsoft.network/ipgroups','microsoft.network/applicationsecuritygroups','microsoft.network/publicipaddresses','microsoft.network/connections']);
const pairKey=(l:Link)=>l.kind==='peering'?`peering:${[l.source,l.target].sort().join('|')}`:l.id;
const awsSharedKey=(id:string)=>id.match(/^aws:[^/]+\/([^/]+\/(?:tgw|dxgw)-[^/]+)$/)?.[1];
// Runs after all accounts/projects merge: a reference into another collected account is not dangling.
const awsListed=({account,rows}:{account:string;rows:Raw[]})=>rows.map(r=>base('aws',`${account}/${r.Region??'global'}/${r.Arn}`,String(r.Arn).split(/[:/]/).pop()??r.Arn,r.ResourceType==='s3:bucket'?'bucket':'service',r.ResourceType??'aws',r.OwningAccountId??account,r.Region||'global','AWS Resource Explorer',{group:r.Region||'global',specs:{'서비스':r.ResourceType??r.Service??'미확인'}}));
// Collectors already total their own reads, so merging parts keeps the worst they report.
const GAP_RANK:Record<Gap,number>={unconfigured:1,partial:2,failed:3};
function gapsOf(parts:Normalized[]):Pick<Normalized,'gaps'>{
  const out:NonNullable<Normalized['gaps']>={};
  for(const p of parts)for(const [k,v] of Object.entries(p.gaps??{}) as [Dataset,Gap|undefined][])if(v&&(!out[k]||GAP_RANK[v]>GAP_RANK[out[k]!]))out[k]=v;
  return Object.keys(out).length?{gaps:out}:{};
}
export function finish(input:Normalized[]):Normalized {
  const parts=input.map(p=>p.awsInventory?{...p,resources:[...p.resources,...awsListed(p.awsInventory)]}:p);
  const resources=[...new Map(parts.flatMap(p=>p.resources).map(r=>[r.id,r])).values()];
  const warnings=parts.flatMap(p=>p.warnings),ids=new Set(resources.map(r=>r.id));
  // A TGW shared through RAM appears in member accounts without its owner, so attachments resolve by region and ID.
  const shared=new Map(resources.flatMap(r=>{const key=awsSharedKey(r.id);return key?[[key,r.id] as const]:[];}));
  const canonical=(id:string)=>ids.has(id)?id:shared.get(awsSharedKey(id)??'')??id;
  const links=parts.flatMap(p=>p.links).map(l=>{const source=canonical(l.source),target=canonical(l.target);return source===l.source&&target===l.target?l:{...l,id:`${l.kind}:${source}:${target}`,source,target};});
  for(const r of resources) if(r.parent&&!ids.has(r.parent)){warnings.push(`${r.name}: 상위 리소스 미수집`);delete r.parent;}
  const resolved=links.filter(e=>{
    if(e.kind==='policy'&&!(ids.has(e.source)&&ids.has(e.target))){warnings.push(`${e.label}: 참조 대상 미수집 (${e.target})`);return false;}
    for(const end of [e.source,e.target])if(!ids.has(end)){
      const [provider,...rest]=end.split(':'),native=rest.join(':');ids.add(end);
      resources.push(base(provider as Provider,native,native.split('/').pop()??native,'external','Unresolved reference','external','미확인','리소스 참조로만 확인',{status:'조회 권한 없음'}));
      warnings.push(`${native.split('/').pop()}: 참조는 있으나 조회 권한이 없는 외부 리소스로 표시합니다.`);
    }
    return true;
  });
  const unique=new Map<string,Link>();for(const l of resolved){const key=pairKey(l),seen=unique.get(key);if(!seen)unique.set(key,l);else if(l.transit&&!seen.transit)unique.set(key,{...l,transit:true});}
  const scopeLabels=Object.assign({},...parts.map(p=>p.scopeLabels));if(resources.some(r=>r.scope==='external'))scopeLabels.external='외부 참조';
  // Any scope the org APIs did not explain still appears, directly under its provider, so nothing is unreachable from the tree.
  const hierarchy=new Map(parts.flatMap(p=>p.hierarchy??[]).map(n=>[n.id,n]));
  for(const r of resources)if(r.provider!=='onprem'&&r.scope!=='external'&&!hierarchy.has(scopeNodeId(r.provider,r.scope)))hierarchy.set(scopeNodeId(r.provider,r.scope),{id:scopeNodeId(r.provider,r.scope),name:scopeLabels[r.scope]??r.scope,provider:r.provider,kind:leafKind[r.provider],nativeId:r.scope,scope:r.scope});
  for(const n of hierarchy.values())if(n.scope&&!scopeLabels[n.scope])scopeLabels[n.scope]=n.name;
  return {resources,links:[...unique.values()],warnings,scopeLabels,hierarchy:[...hierarchy.values()],incomplete:[...new Set(parts.flatMap(p=>p.incomplete??[]))],cost:parts.flatMap(p=>p.cost??[]),activity:[...new Map(parts.flatMap(p=>p.activity??[]).map(a=>[a.id,a])).values()].sort((a,b)=>b.at.localeCompare(a.at)),iam:[...new Map(parts.flatMap(p=>p.iam??[]).map(a=>[a.id,a])).values()],...gapsOf(parts)};
}
// Azure Firewall rules, classic (on the firewall) or from a firewall policy's rule collection groups, as ordered device rules.
// direction carries the rule type (Network, Application, Nat) because the firewall processes them in that order; priority is group then collection.
export type FirewallPolicyRules={groups:Raw[];basePolicy?:string}|{error:string};
function azureFirewallRules(p:Raw,policy?:FirewallPolicyRules,ipGroups:Map<string,string[]>=new Map()):{rules:Resource['rules'];source:string}{
  const out:Resource['rules']=[];const ports=(x:Raw)=>(x.destinationPorts??[]).join(', ')||'*';
  // A collected IP group is replaced by its addresses; one that was not collected stays a peer the analyser cannot settle.
  const expand=(addrs:string[]=[],groups:string[]=[])=>({addrs:[...addrs,...groups.flatMap(g=>ipGroups.get(g.toLowerCase())??[])],unknown:groups.filter(g=>!ipGroups.has(g.toLowerCase()))});
  const one=(type:string,order:number,collection:string,action:string,raw:Raw)=>{
    const src=expand(raw.sourceAddresses,raw.sourceIpGroups),dst=expand(raw.destinationAddresses,raw.destinationIpGroups),r:Raw={...raw,sourceAddresses:src.addrs,destinationAddresses:dst.addrs,sourceIpGroups:src.unknown,destinationIpGroups:dst.unknown};
    const peers=[...(r.sourceIpGroups??[]).map((x:string)=>`ipgroup:${x}`),...(r.destinationIpGroups??[]).map((x:string)=>`ipgroup-dst:${x}`),...(r.destinationFqdns??[]).map((x:string)=>`fqdn:${x}`),...(r.targetFqdns??[]).map((x:string)=>`fqdn:${x}`),...(r.fqdnTags??[]).map((x:string)=>`fqdntag:${x}`),...(r.webCategories??[]).map((x:string)=>`category:${x}`)];
    const appProtocols=(r.protocols??[]).filter((x:Raw)=>typeof x==='object');
    out.push({name:`${collection}/${r.name}`,direction:type,action:action==='Deny'?'Deny':'Allow',protocol:type==='Application'?appProtocols.map((x:Raw)=>x.protocolType).join(', ')||'Http, Https':(r.ipProtocols??r.protocols??['Any']).join(', '),ports:type==='Application'?appProtocols.map((x:Raw)=>x.port).join(', ')||'80, 443':ports(r),source:(r.sourceAddresses??[]).join(', ')||(r.sourceIpGroups?.length?'':'*'),destination:(r.destinationAddresses??[]).join(', ')||(peers.length?'':'*'),priority:String(order),...(peers.length?{peers}:{})});
  };
  for(const c of p.networkRuleCollections??[])for(const r of c.properties?.rules??[])one('Network',c.properties?.priority??65000,c.name,c.properties?.action?.type,r);
  for(const c of p.applicationRuleCollections??[])for(const r of c.properties?.rules??[])one('Application',c.properties?.priority??65000,c.name,c.properties?.action?.type,r);
  if(policy&&'groups' in policy)for(const g of policy.groups)for(const c of g.properties?.ruleCollections??[])if(c.ruleCollectionType==='FirewallPolicyFilterRuleCollection')for(const r of c.rules??[])one(r.ruleType==='ApplicationRule'?'Application':'Network',(g.properties?.priority??65000)*100000+(c.priority??65000),`${g.name}/${c.name}`,c.action?.type,r);
  return{rules:out,source:policy&&'error' in policy?`정책 규칙 수집 실패 (${policy.error})`:p.firewallPolicy?.id?(policy?`방화벽 정책 ${String(p.firewallPolicy.id).split('/').pop()}`:'정책 규칙 미수집'):'클래식 규칙'};
}
export function normalizeAzure(rows:Raw[],scopeLabels:Record<string,string>={},policies:Map<string,FirewallPolicyRules>=new Map()):Normalized {
  const resources:Resource[]=[], links:Link[]=[];
  const id=(v:string)=>`azure:${v.toLowerCase()}`;
  const byId=new Map(rows.map(r=>[r.id.toLowerCase(),r]));
  const nicOwner=new Map<string,string>();
  for(const r of rows)if(r.type.toLowerCase()==='microsoft.compute/virtualmachines')for(const n of r.properties?.networkProfile?.networkInterfaces??[])nicOwner.set(n.id.toLowerCase(),r.id);
  const endpointsFor=new Map<string,number>();
  for(const r of rows)if(r.type.toLowerCase()==='microsoft.network/privateendpoints')for(const c of r.properties?.privateLinkServiceConnections??[])if(c.properties?.privateLinkServiceId)endpointsFor.set(c.properties.privateLinkServiceId.toLowerCase(),(endpointsFor.get(c.properties.privateLinkServiceId.toLowerCase())??0)+1);
  const ipGroups=new Map(rows.filter(r=>r.type.toLowerCase()==='microsoft.network/ipgroups').map(r=>[r.id.toLowerCase(),(r.properties?.ipAddresses??[]) as string[]]));
  const publicIpOf=(ref?:Raw)=>ref?.id?byId.get(ref.id.toLowerCase())?.properties?.ipAddress as string|undefined:undefined;
  // Each IP configuration of a NIC, in order with the primary first: a VM with two NICs or a NIC with secondary IPs keeps every address.
  const ipConfigs=(nic?:Raw)=>[...(nic?.properties?.ipConfigurations??[])].sort((a:Raw,b:Raw)=>Number(!!b.properties?.primary)-Number(!!a.properties?.primary));
  const primaryNic=(vm:Raw)=>{const list=vm.properties?.networkProfile?.networkInterfaces??[],pick=list.find((n:Raw)=>n.properties?.primary)??list[0];return pick?byId.get(pick.id.toLowerCase()):undefined;};
  for(const r of rows){
    const native=r.id.toLowerCase(),t=r.type.toLowerCase(),p=r.properties??{}, common=[r.subscriptionId,r.location??'global','Azure Resource Graph'] as const;
    const add=(kind:Resource['kind'],extra:Partial<Resource>={})=>resources.push(base('azure',native,r.name,kind,r.type,...common,{group:r.resourceGroup,tags:r.tags??{},...extra}));
    if(t==='microsoft.network/virtualnetworks'){
      add('network',{cidr:p.addressSpace?.addressPrefixes?.join(', ')});
      for(const sub of p.subnets??[]){resources.push(base('azure',sub.id.toLowerCase(),sub.name,'subnet','Microsoft.Network/virtualNetworks/subnets',...common,{group:r.resourceGroup,parent:id(r.id),cidr:sub.properties?.addressPrefix??sub.properties?.addressPrefixes?.join(', ')}));if(sub.properties?.networkSecurityGroup?.id)links.push(relation(id(sub.properties.networkSecurityGroup.id),id(sub.id),'policy','NSG 적용','subnet.properties.networkSecurityGroup.id'));}
      for(const peer of p.virtualNetworkPeerings??[])if(peer.properties?.remoteVirtualNetwork?.id)links.push(relation(id(r.id),id(peer.properties.remoteVirtualNetwork.id),'peering',peer.properties.allowGatewayTransit||peer.properties.useRemoteGateways?'Peering · transit':'Peering','virtualNetworkPeerings.remoteVirtualNetwork.id',!!(peer.properties.allowGatewayTransit||peer.properties.useRemoteGateways)));
    } else if(t==='microsoft.compute/virtualmachines'){
      // parent is where the map draws the VM: the subnet of its primary NIC. Connectivity is decided per NIC, never from this.
      const nic=primaryNic(r),ip=ipConfigs(nic)[0]?.properties,size=p.hardwareProfile?.vmSize,nics=(p.networkProfile?.networkInterfaces??[]).map((n:Raw)=>byId.get(n.id.toLowerCase())).filter(Boolean) as Raw[];
      const addresses=nics.flatMap((n,k)=>ipConfigs(n).flatMap((c:Raw,m:number)=>[{ip:c.properties?.privateIPAddress,primary:k===0&&m===0},...(publicIpOf(c.properties?.publicIPAddress)?[{ip:publicIpOf(c.properties?.publicIPAddress)!,public:true}]:[])])).filter((a:Raw)=>a.ip);
      add('compute',{parent:ip?.subnet?.id?id(ip.subnet.id):undefined,ip:ip?.privateIPAddress,publicIp:publicIpOf(ip?.publicIPAddress),addresses,status:p.extended?.instanceView?.powerState?.code?.split('/').pop()??p.provisioningState??'미확인',specs:{'인스턴스':size??'미확인','OS':p.storageProfile?.osDisk?.osType??'미확인',...skuSpecs(azureSkus[size]),...diskSpec([p.storageProfile?.osDisk?.diskSizeGB,...(p.storageProfile?.dataDisks??[]).map((d:Raw)=>d.diskSizeGB)]),...(nics.length>1?{'NIC':`${nics.length}개`}:{})}});
      (p.networkProfile?.networkInterfaces??[]).forEach((n:Raw,k:number)=>links.push(relation(id(r.id),id(n.id),'attachment',n.properties?.primary||(k===0&&!(p.networkProfile.networkInterfaces as Raw[]).some(x=>x.properties?.primary))?'기본 NIC':'NIC','virtualMachine.networkProfile.networkInterfaces',{ref:n.id})));
      const disks=[...(p.storageProfile?.osDisk?.managedDisk?.id?[[p.storageProfile.osDisk.managedDisk.id,'OS 디스크']]:[]),...(p.storageProfile?.dataDisks??[]).filter((d:Raw)=>d.managedDisk?.id).map((d:Raw)=>[d.managedDisk.id,`데이터 디스크 LUN ${d.lun??'?'}`])] as [string,string][];
      // Attached is what the Compute API says; whether the OS mounted it is not visible from here.
      for(const [disk,label] of disks)links.push(relation(id(r.id),id(disk),'attachment',label,'virtualMachine.storageProfile.*.managedDisk.id',{ref:disk,note:'OS 내부 마운트 여부는 클라우드 API로 확인할 수 없습니다.'}));
      // A system-assigned identity has no row of its own, so it is represented under the VM; user-assigned ones are rows of their own.
      if(p.identity?.principalId||r.identity?.principalId){const principalId=(r.identity??p.identity).principalId;resources.push(base('azure',`${native}/identity`,`${r.name} (시스템 할당 ID)`,'identity','Microsoft.ManagedIdentity/systemAssigned',...common,{group:r.resourceGroup,specs:{'종류':'시스템 할당 관리 ID','principalId':principalId}}));links.push(relation(id(r.id),id(`${native}/identity`),'uses_identity','시스템 할당 ID','virtualMachine.identity.principalId',{ref:principalId}));}
      for(const ua of Object.keys(r.identity?.userAssignedIdentities??{}))links.push(relation(id(r.id),id(ua),'uses_identity','사용자 할당 ID','virtualMachine.identity.userAssignedIdentities',{ref:ua}));
    } else if(t==='microsoft.network/networkinterfaces'){
      const configs=ipConfigs(r),first=configs[0]?.properties,owner=p.virtualMachine?.id??nicOwner.get(native);
      const addresses=configs.flatMap((c:Raw,m:number)=>[{ip:c.properties?.privateIPAddress,primary:m===0},...(publicIpOf(c.properties?.publicIPAddress)?[{ip:publicIpOf(c.properties?.publicIPAddress)!,public:true}]:[])]).filter((a:Raw)=>a.ip);
      // Application security group membership is per IP configuration; it is kept as matching keys, an empty list meaning "in none".
      const asgs=[...new Set(configs.flatMap((c:Raw)=>(c.properties?.applicationSecurityGroups??[]).map((g:Raw)=>`asg:${String(g.id).toLowerCase()}`)))] as string[];
      add('nic',{parent:first?.subnet?.id?id(first.subnet.id):undefined,ip:first?.privateIPAddress,publicIp:publicIpOf(first?.publicIPAddress),addresses,netTags:asgs,status:p.provisioningState??'구성 수집됨',specs:{'종류':'Network interface','IP 전달':String(p.enableIPForwarding??false),...(owner?{'연결 VM':owner.split('/').pop()}:{'연결':'VM 없음'})}});
      // Secondary IP configurations may sit in another subnet of the same network.
      for(const c of configs.slice(1))if(c.properties?.subnet?.id&&c.properties.subnet.id.toLowerCase()!==first?.subnet?.id?.toLowerCase())links.push(relation(id(r.id),id(c.properties.subnet.id),'attachment',`보조 IP ${c.properties.privateIPAddress}`,'networkInterface.ipConfigurations.subnet.id',{ref:c.id}));
      if(p.networkSecurityGroup?.id)links.push(relation(id(p.networkSecurityGroup.id),id(r.id),'policy','NIC NSG','networkInterface.networkSecurityGroup.id',{ref:p.networkSecurityGroup.id}));
    } else if(t==='microsoft.compute/disks'){
      add('disk',{status:p.diskState??p.provisioningState??'미확인',specs:{'종류':'Managed disk','크기':p.diskSizeGB?`${p.diskSizeGB} GiB`:'미확인','SKU':r.sku?.name??'미확인','상태':p.diskState??'미확인',...(r.managedBy?{'연결 VM':String(r.managedBy).split('/').pop()}:{})}});
    } else if(t==='microsoft.managedidentity/userassignedidentities'){
      add('identity',{specs:{'종류':'사용자 할당 관리 ID','principalId':p.principalId??'미확인','clientId':p.clientId??'미확인'}});
    } else if(t==='microsoft.network/privateendpoints'){
      // The endpoint is the address in the subnet; the service it fronts stays outside, joined by private_link.
      const nicRow=p.networkInterfaces?.[0]?.id?byId.get(p.networkInterfaces[0].id.toLowerCase()):undefined,ips=[...(p.customDnsConfigs??[]).flatMap((d:Raw)=>d.ipAddresses??[]),...ipConfigs(nicRow).map((c:Raw)=>c.properties?.privateIPAddress)].filter((v,i,a)=>v&&a.indexOf(v)===i) as string[];
      const conns=[...(p.privateLinkServiceConnections??[]),...(p.manualPrivateLinkServiceConnections??[])];
      add('endpoint',{parent:p.subnet?.id?id(p.subnet.id):undefined,ip:ips[0],addresses:ips.map((ip,i)=>({ip,primary:i===0})),status:p.provisioningState??'구성 수집됨',specs:{'종류':'Private Endpoint','하위 리소스':conns.flatMap((c:Raw)=>c.properties?.groupIds??[]).join(', ')||'미확인','DNS 이름':(p.customDnsConfigs??[]).map((d:Raw)=>d.fqdn).filter(Boolean).join(', ')||'미수집'}});
      for(const c of conns)if(c.properties?.privateLinkServiceId)links.push(relation(id(r.id),id(c.properties.privateLinkServiceId),'private_link',`Private Link ${c.properties?.groupIds?.join(', ')??''}`.trim(),'privateEndpoint.privateLinkServiceConnections.privateLinkServiceId',{ref:c.properties.privateLinkServiceId,note:c.properties?.privateLinkServiceConnectionState?.status?`연결 상태 ${c.properties.privateLinkServiceConnectionState.status}`:undefined}));
    } else if(t==='microsoft.network/networksecuritygroups')add('firewall',{specs:{'종류':'NSG','기본 규칙':(p.defaultSecurityRules??[]).length?'수집됨':'미수집'},rules:[...(p.securityRules??[]),...(p.defaultSecurityRules??[]).map((x:Raw)=>({...x,isDefault:true}))].map((rule:Raw)=>{const q=rule.properties??{};
      // Application security groups and a non-wildcard source port are conditions the analyser cannot settle from addresses alone; they are kept as peers.
      const peers=[...(q.sourceApplicationSecurityGroups??[]).map((x:Raw)=>`asg:${String(x.id).toLowerCase()}`),...(q.destinationApplicationSecurityGroups??[]).map((x:Raw)=>`asg-dst:${String(x.id).toLowerCase()}`),...(q.sourcePortRange&&q.sourcePortRange!=='*'?[`source-port:${q.sourcePortRange}`]:[]),...((q.sourcePortRanges??[]).length?[`source-port:${q.sourcePortRanges.join(',')}`]:[])];
      return{name:`${rule.name??'규칙'}${rule.isDefault?' (기본 규칙)':''}`,direction:q.direction??'Unknown',action:q.access??'Unknown',protocol:q.protocol??'*',ports:q.destinationPortRange??q.destinationPortRanges?.join(', ')??'*',source:q.sourceAddressPrefix??q.sourceAddressPrefixes?.join(', ')??(q.sourceApplicationSecurityGroups?.length?'ASG':'미확인'),destination:q.destinationAddressPrefix??q.destinationAddressPrefixes?.join(', ')??(q.destinationApplicationSecurityGroups?.length?'ASG':'미확인'),priority:String(q.priority??'-'),...(peers.length?{peers}:{})};})});
    else if(t==='microsoft.network/expressroutecircuits')add('gateway',{specs:{'종류':'ExpressRoute circuit','대역폭':`${p.serviceProviderProperties?.bandwidthInMbps??'?'} Mbps`,'공급자':p.serviceProviderProperties?.serviceProviderName??'미확인','피어링 위치':p.serviceProviderProperties?.peeringLocation??'미확인'},status:p.provisioningState??'미확인'});
    else if(t==='microsoft.network/virtualnetworkgateways'){
      const subnet=p.ipConfigurations?.[0]?.properties?.subnet?.id;
      add('gateway',{parent:subnet?id(subnet):undefined,status:p.provisioningState??'미확인',specs:{'종류':`${p.gatewayType??'미확인'} gateway`,'SKU':p.sku?.name??'미확인'}});
    } else if(t==='microsoft.network/connections'&&p.virtualNetworkGateway1?.id&&p.peer?.id)links.push(relation(id(p.peer.id),id(p.virtualNetworkGateway1.id),'attachment',p.connectionType??'연결','connection.peer.id / virtualNetworkGateway1.id'));
    else if(t==='microsoft.network/azurefirewalls'){
      const ip=p.ipConfigurations?.[0]?.properties,policy=p.firewallPolicy?.id?policies.get(String(p.firewallPolicy.id).toLowerCase()):undefined,{rules,source}=azureFirewallRules(p,policy,ipGroups);
      const collected=!p.firewallPolicy?.id||(!!policy&&'groups' in policy);
      add('appliance',{parent:ip?.subnet?.id?id(ip.subnet.id):undefined,ip:ip?.privateIPAddress,status:p.provisioningState??'미확인',rules,specs:{'종류':'Azure Firewall','SKU':p.sku?.tier??'미확인','정책 규칙':collected?'수집됨':'미수집','규칙 출처':source,'위협 인텔리전스':p.threatIntelMode??'미수집',...(policy&&'basePolicy' in policy&&policy.basePolicy?{'상위 정책':String(policy.basePolicy).split('/').pop()!+' (규칙 상속 미수집)'}:{})}});
    } else if(t==='microsoft.network/loadbalancers'){
      const front=p.frontendIPConfigurations?.[0]?.properties;
      add('loadbalancer',{parent:front?.subnet?.id?id(front.subnet.id):undefined,ip:front?.privateIPAddress,publicIp:front?.publicIPAddress?.id?byId.get(front.publicIPAddress.id.toLowerCase())?.properties?.ipAddress:undefined,status:p.provisioningState??'미확인',specs:{'종류':front?.subnet?'내부 Load Balancer':'공용 Load Balancer','SKU':r.sku?.name??'미확인'}});
      // A backend pool names NIC IP configurations; the VM is joined through the NIC that holds that configuration.
      for(const pool of p.backendAddressPools??[])for(const c of pool.properties?.backendIPConfigurations??[]){const nicId=c.id.toLowerCase().split('/ipconfigurations/')[0],vm=nicOwner.get(nicId);links.push(relation(id(r.id),id(vm??nicId),'forwards_to',`백엔드 풀 ${pool.name??''}`.trim(),'loadBalancer.backendAddressPools.backendIPConfigurations',{ref:c.id,note:vm?`NIC ${nicId.split('/').pop()} 경유`:undefined}));}
    } else if(t==='microsoft.network/applicationgateways'){
      add('loadbalancer',{parent:p.gatewayIPConfigurations?.[0]?.properties?.subnet?.id?id(p.gatewayIPConfigurations[0].properties.subnet.id):undefined,ip:p.frontendIPConfigurations?.[0]?.properties?.privateIPAddress,status:p.operationalState??p.provisioningState??'미확인',specs:{'종류':'Application Gateway','SKU':p.sku?.tier??'미확인'}});
      for(const pool of p.backendAddressPools??[])for(const c of pool.properties?.backendIPConfigurations??[]){const nicId=c.id.toLowerCase().split('/ipconfigurations/')[0],vm=nicOwner.get(nicId);links.push(relation(id(r.id),id(vm??nicId),'forwards_to','백엔드 풀','applicationGateway.backendAddressPools.backendIPConfigurations',{ref:c.id}));}
    } else if(t==='microsoft.network/bastionhosts')add('appliance',{parent:p.ipConfigurations?.[0]?.properties?.subnet?.id?id(p.ipConfigurations[0].properties.subnet.id):undefined,status:p.provisioningState??'미확인',specs:{'종류':'Azure Bastion'}});
    else if(azurePrivateServices[t]){
      const [kind,label]=azurePrivateServices[t],pes=endpointsFor.get(native)??0;
      add(kind,{status:p.provisioningState??p.state??'미확인',specs:{'종류':label,...(t==='microsoft.sql/servers'?{'버전':p.version??'미확인'}:{}),'Private Endpoint':pes?`${pes}개`:'없음','공용 네트워크 접근':p.publicNetworkAccess??'미수집',...(p.networkAcls?.defaultAction?{'기본 네트워크 규칙':p.networkAcls.defaultAction}:{})}});
    } else if(t==='microsoft.network/natgateways')add('nat',{parent:p.subnets?.[0]?.id?id(p.subnets[0].id):undefined,status:p.provisioningState??'미확인',specs:{'종류':'NAT Gateway'}});
    else if(t==='microsoft.containerservice/managedclusters'){
      const pools=p.agentPoolProfiles??[],subnet=pools[0]?.vnetSubnetID;
      add('cluster',{parent:subnet?id(subnet):undefined,status:p.powerState?.code??p.provisioningState??'미확인',specs:{'종류':'AKS','버전':p.kubernetesVersion??'미확인','노드':String(pools.reduce((s:number,x:Raw)=>s+(x.count??0),0)),'네트워크 플러그인':p.networkProfile?.networkPlugin??'미수집','NetworkPolicy 엔진':p.networkProfile?.networkPolicy??'없음 또는 미수집'}});
    }else if(!AZURE_CONSUMED.has(t))add('service',{status:p.provisioningState??p.state??'구성 수집됨',specs:{'서비스':r.type}});
  }
  // Routes attach after the pass above so a UDR can reference a firewall from any row order.
  const routeTables=rows.filter(r=>r.type.toLowerCase()==='microsoft.network/routetables'),byAddress=new Map(resources.filter(r=>r.kind==='appliance'&&r.ip).map(r=>[r.ip!,r]));
  for(const table of routeTables)for(const sub of table.properties?.subnets??[]){
    const subnet=resources.find(r=>r.id===id(sub.id));if(!subnet)continue;
    for(const route of table.properties?.routes??[]){
      const q=route.properties??{},appliance=byAddress.get(q.nextHopIpAddress);
      subnet.routes.push({destination:q.addressPrefix??'미확인',nextHop:appliance?.name??q.nextHopIpAddress??q.nextHopType??'미확인',via:q.nextHopType??'미확인',origin:'user',...(q.nextHopIpAddress?{nextHopIp:q.nextHopIpAddress}:{}),...(appliance?{target:appliance.id}:{})});
      // The route names an address, not a device: matching it to the firewall that holds that address is Atlas's inference.
      if(appliance)links.push(relation(subnet.id,appliance.id,'route',`UDR ${q.addressPrefix}`,'routeTable.routes.nextHopIpAddress',{basis:'inferred',ref:table.id,note:`다음 홉 IP ${q.nextHopIpAddress}가 ${appliance.name}의 사설 IP와 같아 연결했습니다.`}));
    }
  }
  return {resources,links,warnings:[],scopeLabels};
}
export function normalizeAws(data:Raw,scope:string,region:string,label?:string):Normalized {
  const resources:Resource[]=[],links:Link[]=[];
  // Deleted items linger in Describe responses for a while; drawing them would invent connections.
  const live=(rows:Raw[]|undefined)=>(rows??[]).filter(r=>!['deleted','deleting'].includes(String(r.State??'').toLowerCase()));
  const native=(id:string,account=scope,at=region)=>`${account}/${at}/${id}`,id=(v:string,account=scope,at=region)=>`aws:${native(v,account,at)}`;
  const add=(r:Raw,key:string,kind:Resource['kind'],type:string,extra:Partial<Resource>={})=>resources.push(base('aws',native(r[key]),name(r)??r[key],kind,type,scope,region,'AWS Describe APIs',{group:region,tags:Object.fromEntries((r.Tags??[]).map((t:Raw)=>[t.Key,t.Value??''])),...extra}));
  for(const r of data.Vpcs??[])add(r,'VpcId','network','AWS::EC2::VPC',{cidr:r.CidrBlock});
  for(const r of data.Subnets??[])add(r,'SubnetId','subnet','AWS::EC2::Subnet',{parent:id(r.VpcId),cidr:r.CidrBlock,specs:{'가용 영역':r.AvailabilityZone??'미확인','공개 IP 자동 할당':String(r.MapPublicIpOnLaunch??false)}});
  // Security groups allow only; a rule naming another group or a prefix list keeps that reference as a peer the analyser can resolve or report.
  const sgRules=(v:Raw,direction:string)=>{const cidrs=[...(v.IpRanges??[]).map((x:Raw)=>x.CidrIp),...(v.Ipv6Ranges??[]).map((x:Raw)=>x.CidrIpv6)],groups=(v.UserIdGroupPairs??[]).map((x:Raw)=>x.GroupId),lists=(v.PrefixListIds??[]).map((x:Raw)=>x.PrefixListId);
    const peers=[...groups.map((g:string)=>`sg:${g}`),...lists.map((x:string)=>`pl:${x}`)],text=[...cidrs,...groups,...lists].join(', ')||'미지정';
    return{direction,action:'Allow',protocol:v.IpProtocol==='-1'?'All':v.IpProtocol,ports:v.FromPort==null||v.IpProtocol==='-1'?'All':`${v.FromPort}${v.ToPort!==v.FromPort?`-${v.ToPort}`:''}`,source:direction==='Inbound'?text:'*',destination:direction==='Outbound'?text:'*',priority:'-',...(peers.length?{peers}:{})};};
  for(const r of data.SecurityGroups??[])add(r,'GroupId','firewall','AWS::EC2::SecurityGroup',{parent:id(r.VpcId),specs:{'종류':'Security Group','평가':'허용 규칙만, 상태 기반'},rules:[...(r.IpPermissions??[]).map((v:Raw)=>sgRules(v,'Inbound')),...(r.IpPermissionsEgress??[]).map((v:Raw)=>sgRules(v,'Outbound'))]});
  // NACLs are stateless and ordered by rule number; 32767 is AWS's catch-all deny and comes with every ACL.
  const NACL_PROTO:Record<string,string>={'-1':'All','6':'tcp','17':'udp','1':'icmp'};
  for(const r of data.NetworkAcls??[]){
    add(r,'NetworkAclId','firewall','AWS::EC2::NetworkAcl',{parent:id(r.VpcId),specs:{'종류':'Network ACL','평가':'번호 순서, 상태 비저장','기본 ACL':String(!!r.IsDefault)},rules:(r.Entries??[]).map((e:Raw)=>({name:`#${e.RuleNumber}`,direction:e.Egress?'Outbound':'Inbound',action:e.RuleAction==='allow'?'Allow':'Deny',protocol:NACL_PROTO[String(e.Protocol)]??String(e.Protocol),ports:e.PortRange?`${e.PortRange.From}${e.PortRange.To!==e.PortRange.From?`-${e.PortRange.To}`:''}`:'All',source:e.Egress?'*':e.CidrBlock??e.Ipv6CidrBlock??'*',destination:e.Egress?e.CidrBlock??e.Ipv6CidrBlock??'*':'*',priority:String(e.RuleNumber)}))});
    for(const a of r.Associations??[])if(a.SubnetId)links.push(relation(id(r.NetworkAclId),id(a.SubnetId),'policy','NACL 적용','networkAcl.Associations.SubnetId',{ref:a.NetworkAclAssociationId}));
  }
  for(const reservation of data.Reservations??[])for(const r of reservation.Instances??[]){
    if(r.State?.Name==='terminated')continue;
    const spec=data.InstanceTypes?.find((x:Raw)=>x.InstanceType===r.InstanceType);
    // Each ENI is its own resource with every private and public address it holds; security groups apply to the ENI, not the instance.
    const enis=[...(r.NetworkInterfaces??[])].sort((a:Raw,b:Raw)=>(a.Attachment?.DeviceIndex??0)-(b.Attachment?.DeviceIndex??0));
    const addrOf=(n:Raw)=>(n.PrivateIpAddresses??[{PrivateIpAddress:n.PrivateIpAddress,Primary:true,Association:n.Association}]).flatMap((x:Raw)=>[{ip:x.PrivateIpAddress,primary:!!x.Primary},...(x.Association?.PublicIp?[{ip:x.Association.PublicIp,public:true}]:[])]).filter((a:Raw)=>a.ip);
    for(const n of enis){
      add(n,'NetworkInterfaceId','nic','AWS::EC2::NetworkInterface',{parent:n.SubnetId?id(n.SubnetId):undefined,ip:n.PrivateIpAddress,publicIp:n.Association?.PublicIp,addresses:addrOf(n),status:n.Status??'구성 수집됨',specs:{'종류':'ENI','장치 번호':String(n.Attachment?.DeviceIndex??'?'),'원본/대상 확인':String(n.SourceDestCheck??true),'연결 인스턴스':r.InstanceId}});
      links.push(relation(id(r.InstanceId),id(n.NetworkInterfaceId),'attachment',(n.Attachment?.DeviceIndex??0)===0?'기본 NIC':`ENI ${n.Attachment?.DeviceIndex}`,'instance.NetworkInterfaces',{ref:n.Attachment?.AttachmentId}));
      for(const sg of n.Groups??[])links.push(relation(id(sg.GroupId),id(n.NetworkInterfaceId),'policy','Security Group 적용','instance.NetworkInterfaces.Groups',{ref:sg.GroupId}));
    }
    if(r.IamInstanceProfile?.Arn){const profile=String(r.IamInstanceProfile.Arn);resources.push(base('aws',native(profile.split('/').pop()!,scope,'global'),`${profile.split('/').pop()} (인스턴스 프로파일)`,'identity','AWS::IAM::InstanceProfile',scope,'global','AWS Describe APIs',{specs:{'종류':'인스턴스 프로파일','ARN':profile,'역할':'역할 연결 미수집 (iam:GetInstanceProfile 필요)'}}));links.push(relation(id(r.InstanceId),id(profile.split('/').pop()!,scope,'global'),'uses_identity','인스턴스 프로파일','instance.IamInstanceProfile.Arn',{ref:profile}));}
    add(r,'InstanceId','compute','AWS::EC2::Instance',{parent:r.SubnetId?id(r.SubnetId):undefined,ip:r.PrivateIpAddress,publicIp:r.PublicIpAddress,addresses:enis.flatMap((n,k)=>addrOf(n).map((a:Raw)=>({...a,primary:k===0&&a.primary}))),status:r.State?.Name??'미확인',specs:{'인스턴스':r.InstanceType??'미확인','vCPU':String(spec?.VCpuInfo?.DefaultVCpus??'미수집'),'메모리':spec?.MemoryInfo?.SizeInMiB?`${spec.MemoryInfo.SizeInMiB/1024} GiB`:'미수집','GPU':spec?String(spec.GpuInfo?.Gpus?.map((g:Raw)=>`${g.Count} × ${g.Name}`).join(', ')||'없음'):'미수집'}});
    // Without ENI detail (older collections), the groups are recorded on the instance as before.
    if(!enis.length)for(const sg of r.SecurityGroups??[])links.push(relation(id(sg.GroupId),id(r.InstanceId),'policy','Security Group 적용','instance.SecurityGroups'));
  }
  // EBS: attached by the EC2 API; mounted inside the OS is not visible from here.
  for(const v of data.Volumes??[]){
    add(v,'VolumeId','disk','AWS::EC2::Volume',{status:v.State??'미확인',specs:{'종류':'EBS','크기':v.Size?`${v.Size} GiB`:'미확인','유형':v.VolumeType??'미확인','암호화':String(v.Encrypted??false),'가용 영역':v.AvailabilityZone??'미확인'}});
    for(const a of v.Attachments??[])if(a.InstanceId)links.push(relation(id(a.InstanceId),id(v.VolumeId),'attachment',`EBS ${a.Device??''}`.trim(),'volume.Attachments.InstanceId',{ref:v.VolumeId,note:'OS 내부 마운트 여부는 클라우드 API로 확인할 수 없습니다.'}));
  }
  // A gateway endpoint has no address and no ENI: it is a route-table target. An interface endpoint has ENIs in subnets.
  for(const e of data.VpcEndpoints??[]){
    const gateway=e.VpcEndpointType==='Gateway',service=String(e.ServiceName??'');
    add(e,'VpcEndpointId','endpoint','AWS::EC2::VPCEndpoint',{parent:gateway?id(e.VpcId):e.SubnetIds?.[0]?id(e.SubnetIds[0]):id(e.VpcId),status:e.State??'미확인',specs:{'종류':gateway?'Gateway Endpoint':`${e.VpcEndpointType??'Interface'} Endpoint`,'서비스':service,'정책':e.PolicyDocument?'엔드포인트 정책 있음 (평가하지 않음)':'없음','DNS 이름':(e.DnsEntries??[]).map((d:Raw)=>d.DnsName).filter(Boolean).slice(0,3).join(', ')||'미수집'}});
    for(const rt of e.RouteTableIds??[])for(const t of data.RouteTables??[])if(t.RouteTableId===rt)for(const a of t.Associations??[])if(a.SubnetId)links.push(relation(id(a.SubnetId),id(e.VpcEndpointId),'route',`접두사 목록 → ${service.split('.').pop()}`,'vpcEndpoint.RouteTableIds',{ref:rt}));
    for(const sg of e.Groups??[])links.push(relation(id(sg.GroupId),id(e.VpcEndpointId),'policy','Security Group 적용','vpcEndpoint.Groups',{ref:sg.GroupId}));
  }
  for(const r of live(data.VpnGateways)){add(r,'VpnGatewayId','gateway','AWS::EC2::VPNGateway',{status:r.State??'미확인',specs:{'종류':'Virtual Private Gateway'}});for(const a of r.VpcAttachments??[])links.push(relation(id(r.VpnGatewayId),id(a.VpcId),'attachment','VPN Gateway 연결','vpnGateway.VpcAttachments'));}
  for(const r of data.InternetGateways??[]){const vpc=r.Attachments?.[0]?.VpcId;add(r,'InternetGatewayId','gateway','AWS::EC2::InternetGateway',{parent:vpc?id(vpc):undefined,status:r.Attachments?.[0]?.State??'미확인',specs:{'종류':'Internet Gateway'}});}
  for(const r of live(data.NatGateways))add(r,'NatGatewayId','nat','AWS::EC2::NatGateway',{parent:r.SubnetId?id(r.SubnetId):undefined,ip:r.NatGatewayAddresses?.[0]?.PrivateIp,status:r.State??'미확인',specs:{'종류':'NAT Gateway','연결':r.ConnectivityType??'public'}});
  for(const r of live(data.TransitGateways)){
    // Each attachment (a VPC, a VPN) is associated with one route table; each route names the attachment it sends to, or is a blackhole.
    const tables=(data.TransitGatewayRouteTables??[]).filter((t:Raw)=>t.TransitGatewayId===r.TransitGatewayId),associations:Record<string,string>={},routes:Resource['routes']=[];
    for(const t of tables){for(const a of t.associations??[])if(a.ResourceId)associations[a.ResourceId]=t.TransitGatewayRouteTableId;
      for(const x of t.routes??[]){const hop=x.TransitGatewayAttachments?.[0];routes.push({destination:x.DestinationCidrBlock??x.PrefixListId??'미확인',nextHop:x.State==='blackhole'?'blackhole':hop?.ResourceId??'미확인',via:x.State==='blackhole'?'blackhole':hop?.ResourceType??'미확인',origin:x.Type==='propagated'?'propagated':'user',tags:[t.TransitGatewayRouteTableId]});}}
    const truncated=tables.some((t:Raw)=>t.truncated);
    add(r,'TransitGatewayId','gateway','AWS::EC2::TransitGateway',{status:r.State??'미확인',routes,...(tables.length?{associations}:{}),specs:{'종류':'Transit Gateway','ASN':String(r.Options?.AmazonSideAsn??'미확인'),'라우트 테이블':tables.length?`${tables.length}개${truncated?' (일부 경로 누락: 1,000개 초과)':''}`:'미수집'}});
  }
  for(const r of live(data.TransitGatewayVpcAttachments))links.push(relation(id(r.TransitGatewayId),id(r.VpcId,r.VpcOwnerId??scope),'attachment','TGW attachment','transitGatewayVpcAttachment.VpcId / VpcOwnerId'));
  for(const r of data.TransitGatewayPeeringAttachments??[])if(r.State==='available')links.push(relation(id(r.RequesterTgwInfo.TransitGatewayId,r.RequesterTgwInfo.OwnerId??scope,r.RequesterTgwInfo.Region??region),id(r.AccepterTgwInfo.TransitGatewayId,r.AccepterTgwInfo.OwnerId??scope,r.AccepterTgwInfo.Region??region),'peering','TGW peering','transitGatewayPeeringAttachment'));
  for(const r of data.DirectConnectGateways??[]){
    // Global resource: one identity no matter how many regions are collected.
    resources.push(base('aws',native(r.directConnectGatewayId,scope,'global'),r.directConnectGatewayName??r.directConnectGatewayId,'gateway','AWS::DirectConnect::DirectConnectGateway',scope,'global','AWS Describe APIs',{group:'global',status:r.directConnectGatewayState??'미확인',specs:{'종류':'Direct Connect gateway','ASN':String(r.amazonSideAsn??'미확인')}}));
    for(const a of r.associations??[])if(a.associatedGateway?.id)links.push(relation(id(r.directConnectGatewayId,scope,'global'),id(a.associatedGateway.id,a.associatedGateway.ownerAccount??scope,a.associatedGateway.region??region),'attachment','DX 연결','directConnectGatewayAssociation.associatedGateway'));
  }
  for(const r of data.Clusters??[])resources.push(base('aws',native(r.name),r.name,'cluster','AWS::EKS::Cluster',scope,region,'AWS Describe APIs',{group:region,parent:r.resourcesVpcConfig?.subnetIds?.[0]?id(r.resourcesVpcConfig.subnetIds[0]):undefined,status:r.status??'미확인',specs:{'종류':'EKS','버전':r.version??'미확인'}}));
  for(const r of live(data.VpnConnections)){
    const tunnels=r.VgwTelemetry??[],up=tunnels.filter((t:Raw)=>t.Status==='UP').length;
    add(r,'VpnConnectionId','gateway','AWS::EC2::VPNConnection',{status:r.State==='available'&&tunnels.length&&up<tunnels.length?'degraded':r.State??'미확인',specs:{'종류':'Site-to-Site VPN','터널':`${up}/${tunnels.length} UP`,'고객 게이트웨이':r.CustomerGatewayId??'미확인'}});
    const target=r.TransitGatewayId??r.VpnGatewayId;if(target)links.push(relation(id(r.VpnConnectionId),id(target),'attachment','VPN 연결','vpnConnection.TransitGatewayId'));
  }
  for(const r of data.VpcPeeringConnections??[])if(r.Status?.Code==='active')links.push(relation(id(r.RequesterVpcInfo.VpcId,r.RequesterVpcInfo.OwnerId??scope),id(r.AccepterVpcInfo.VpcId,r.AccepterVpcInfo.OwnerId??scope),'peering','Peering','vpcPeeringConnection'));
  for(const r of data.LoadBalancers??[]){
    add(r,'LoadBalancerName','loadbalancer','AWS::ElasticLoadBalancingV2::LoadBalancer',{parent:r.AvailabilityZones?.[0]?.SubnetId?id(r.AvailabilityZones[0].SubnetId):undefined,status:r.State?.Code??'미확인',specs:{'종류':`${r.Type??'application'} LB`,'공개 범위':r.Scheme??'미확인'}});
    for(const sg of r.SecurityGroups??[])links.push(relation(id(sg),id(r.LoadBalancerName),'policy','Security Group 적용','loadBalancer.SecurityGroups'));
    for(const target of r.Targets??[])links.push(relation(id(r.LoadBalancerName),id(target),'attachment','대상 그룹','describeTargetHealth.Target.Id'));
  }
  for(const r of data.DBInstances??[]){
    add(r,'DBInstanceIdentifier','database','AWS::RDS::DBInstance',{parent:r.DBSubnetGroup?.Subnets?.[0]?.SubnetIdentifier?id(r.DBSubnetGroup.Subnets[0].SubnetIdentifier):undefined,status:r.DBInstanceStatus??'미확인',specs:{'종류':r.Engine??'RDS','인스턴스':r.DBInstanceClass??'미확인','Multi-AZ':String(r.MultiAZ??false)}});
    for(const sg of r.VpcSecurityGroups??[])links.push(relation(id(sg.VpcSecurityGroupId),id(r.DBInstanceIdentifier),'policy','Security Group 적용','dbInstance.VpcSecurityGroups'));
  }
  for(const table of data.RouteTables??[]){
    const subnets=(table.Associations??[]).map((a:Raw)=>a.SubnetId).filter(Boolean),explicit=new Set((data.RouteTables??[]).flatMap((t:Raw)=>(t.Associations??[]).map((a:Raw)=>a.SubnetId).filter(Boolean)));
    const targets=resources.filter(r=>r.kind==='subnet'&&(subnets.includes(r.nativeId.split('/').pop())||((table.Associations??[]).some((a:Raw)=>a.Main)&&r.parent===id(table.VpcId)&&!explicit.has(r.nativeId.split('/').pop()))));
    for(const subnet of targets)for(const route of table.Routes??[]){if(route.State==='blackhole')continue;const hop=route.TransitGatewayId??route.NatGatewayId??route.VpcPeeringConnectionId??route.GatewayId??'미확인';subnet.routes.push({destination:route.DestinationCidrBlock??route.DestinationPrefixListId??'미확인',nextHop:hop,via:route.TransitGatewayId?'Transit Gateway':route.NatGatewayId?'NAT':route.VpcPeeringConnectionId?'Peering':hop==='local'?'VPC 내부':String(hop).startsWith('vpce-')?'Endpoint':String(hop).startsWith('igw-')?'Internet Gateway':String(hop).startsWith('vgw-')?'VPN Gateway':'Gateway',origin:route.Origin==='EnableVgwRoutePropagation'?'propagated':route.Origin==='CreateRouteTable'?'system':'user',target:hop==='local'?undefined:id(hop)});}
  }
  return {resources,links,warnings:[],scopeLabels:label?{[scope]:label}:{}};
}
export function normalizeGcp(assets:Raw[]):Normalized {
  const resources:Resource[]=[],links:Link[]=[],diskAssets=new Set(assets.filter(a=>a.assetType==='compute.googleapis.com/Disk').map(a=>a.name));
  // Cluster and Cloud SQL report partial or leading-slash references; Compute assets use full URLs.
  const canonical=(v:string)=>v.replace('https://www.googleapis.com/compute/v1/','//compute.googleapis.com/').replace(/^\/?projects\//,'//compute.googleapis.com/projects/');
  const id=(v:string)=>`gcp:${canonical(v)}`;
  for(const a of assets){
    const p=a.resource?.data??{}, t=a.assetType, scope=a.name.match(/projects\/([^/]+)/)?.[1]??'unknown',region=a.resource?.location??p.region?.split('/').pop()??p.zone?.split('/').pop()??'global';
    const add=(kind:Resource['kind'],extra:Partial<Resource>={})=>resources.push(base('gcp',a.name,p.name??a.name.split('/').pop(),kind,t,scope,region,'Cloud Asset Inventory · RESOURCE',{group:region,tags:p.labels??{},...extra}));
    if(t==='compute.googleapis.com/Network'){
      add('network',{specs:{'라우팅 모드':p.routingConfig?.routingMode??'미확인'}});
      for(const peer of p.peerings??[])if(peer.network&&peer.state!=='INACTIVE')links.push(relation(id(a.name),id(peer.network),'peering',peer.exportCustomRoutes||peer.importCustomRoutes?'Peering · transit':'Peering','network.peerings.network',!!(peer.exportCustomRoutes||peer.importCustomRoutes)));
    }
    else if(t==='compute.googleapis.com/Subnetwork')add('subnet',{parent:p.network?id(p.network):undefined,cidr:p.ipCidrRange});
    else if(t==='compute.googleapis.com/Instance'){
      const machine=p.machineType?.split('/').pop(),nics=(p.networkInterfaces??[]) as Raw[],first=nics[0];
      const addrOf=(n:Raw,k:number)=>[{ip:n.networkIP,primary:k===0},...(n.aliasIpRanges??[]).map((a:Raw)=>({ip:a.ipCidrRange})),...(n.accessConfigs??[]).filter((x:Raw)=>x.natIP).map((x:Raw)=>({ip:x.natIP,public:true}))].filter((a:Raw)=>a.ip);
      // Network tags decide which firewall rules and routes apply to this instance, so they are kept as matching keys.
      add('compute',{parent:first?.subnetwork?id(first.subnetwork):undefined,ip:first?.networkIP,publicIp:first?.accessConfigs?.[0]?.natIP,addresses:nics.flatMap(addrOf),netTags:p.tags?.items??[],status:p.status??'미확인',specs:{'인스턴스':machine??'미확인',...skuSpecs(gcpMachines[machine]),...diskSpec((p.disks??[]).map((d:Raw)=>d.diskSizeGb)),'GPU':p.guestAccelerators?.map((g:Raw)=>`${g.acceleratorCount} × ${g.acceleratorType.split('/').pop()}`).join(', ')||'없음',...(nics.length>1?{'NIC':`${nics.length}개`}:{}),...(p.tags?.items?.length?{'네트워크 태그':p.tags.items.join(', ')}:{})}});
      nics.forEach((n:Raw,k:number)=>{const nicId=`${a.name}/networkInterfaces/${n.name??`nic${k}`}`;resources.push(base('gcp',nicId,`${p.name} ${n.name??`nic${k}`}`,'nic','compute.googleapis.com/NetworkInterface',scope,region,'Cloud Asset Inventory · RESOURCE',{parent:n.subnetwork?id(n.subnetwork):undefined,ip:n.networkIP,publicIp:n.accessConfigs?.[0]?.natIP,addresses:addrOf(n,0),netTags:p.tags?.items??[],specs:{'종류':'Network interface','네트워크':String(n.network??'').split('/').pop()??'미확인'}}));links.push(relation(id(a.name),id(nicId),'attachment',k===0?'기본 NIC':`NIC ${k}`,'instance.networkInterfaces'));});
      for(const sa of p.serviceAccounts??[])if(sa.email){const saId=`//iam.googleapis.com/projects/${scope}/serviceAccounts/${sa.email}`;if(!resources.some(r=>r.id===id(saId)))resources.push(base('gcp',saId,sa.email.split('@')[0],'identity','iam.googleapis.com/ServiceAccount',scope,'global','Cloud Asset Inventory · RESOURCE',{specs:{'종류':'서비스 계정','이메일':sa.email,'접근 범위':(sa.scopes??[]).map((x:string)=>x.split('/').pop()).join(', ')||'미수집'}}));links.push(relation(id(a.name),id(saId),'uses_identity','서비스 계정','instance.serviceAccounts.email',{ref:sa.email}));}
      // A disk is joined only when its own asset was collected; an unreadable disk is not invented.
      for(const d of p.disks??[]){const src=d.source?String(d.source).replace('https://www.googleapis.com/compute/v1/','//compute.googleapis.com/'):undefined;if(src&&diskAssets.has(src))links.push(relation(id(a.name),id(src),'attachment',d.boot?'부팅 디스크':'데이터 디스크','instance.disks.source',{ref:d.source,note:'OS 내부 마운트 여부는 클라우드 API로 확인할 수 없습니다.'}));}
    }
    else if(t==='compute.googleapis.com/Disk')add('disk',{status:p.status??'미확인',specs:{'종류':'Persistent Disk','크기':p.sizeGb?`${p.sizeGb} GiB`:'미확인','유형':String(p.type??'').split('/').pop()||'미확인','사용 인스턴스':(p.users??[]).map((u:string)=>u.split('/').pop()).join(', ')||'없음'}});
    else if(t==='storage.googleapis.com/Bucket')add('bucket',{status:'구성 수집됨',specs:{'종류':'Cloud Storage 버킷','위치':p.location??a.resource?.location??'미확인','균일한 버킷 수준 액세스':String(p.iamConfiguration?.uniformBucketLevelAccess?.enabled??'미수집')}});
    else if(t==='compute.googleapis.com/Firewall'){
      // Which instances a rule applies to (target tags or service accounts, none means all) and which senders it names beyond ranges.
      const peers=[...(p.sourceTags??[]).map((x:string)=>`tag:${x}`),...(p.sourceServiceAccounts??[]).map((x:string)=>`sa:${x}`)];
      add('firewall',{appliesTo:{...(p.targetTags?.length?{tags:p.targetTags}:{}),...(p.targetServiceAccounts?.length?{serviceAccounts:p.targetServiceAccounts}:{})},parent:p.network?id(p.network):undefined,status:p.disabled?'disabled':'enabled',specs:{'대상 태그':p.targetTags?.join(', ')||'전체 대상 (태그 제한 없음)','비활성':String(p.disabled??false)},rules:[...(p.allowed??[]).map((r:Raw)=>({...r,action:'Allow'})),...(p.denied??[]).map((r:Raw)=>({...r,action:'Deny'}))].map((r:Raw)=>({name:p.name,direction:p.direction??'INGRESS',action:r.action,protocol:r.IPProtocol,ports:r.ports?.join(', ')||'All',source:p.sourceRanges?.join(', ')||(peers.length?'':'*'),destination:p.destinationRanges?.join(', ')||'*',priority:String(p.priority??1000),...(peers.length?{peers}:{})}))});
      if(p.network)links.push(relation(id(a.name),id(p.network),'policy','VPC 방화벽 정책','firewall.network (대상 태그·서비스 계정 별도 평가 필요)'));
    } else if(t==='compute.googleapis.com/Router'){
      add('gateway',{parent:p.network?id(p.network):undefined,specs:{'종류':'Cloud Router','ASN':String(p.bgp?.asn??'미확인'),'동적 경로':'미수집','Cloud NAT':(p.nats??[]).length?`${p.nats.length}개`:'없음'}});
      // Cloud NAT lives on the router; which subnets it serves is part of its configuration.
      for(const n of p.nats??[]){const natId=`${a.name}/nats/${n.name}`,all=n.sourceSubnetworkIpRangesToNat!=='LIST_OF_SUBNETWORKS';
        add('nat',{parent:p.network?id(p.network):undefined,status:'구성 수집됨',specs:{'종류':'Cloud NAT','라우터':p.name,'적용 서브넷':all?'전체 서브넷':(n.subnetworks??[]).map((x:Raw)=>String(x.name).split('/').pop()).join(', ')||'없음'}});
        resources[resources.length-1]={...resources[resources.length-1],id:id(natId),nativeId:natId,name:n.name};
        if(!all)for(const sn of n.subnetworks??[])links.push(relation(id(natId),id(sn.name),'attachment','Cloud NAT 적용','router.nats.subnetworks'));}
    }
    else if(t==='compute.googleapis.com/InterconnectAttachment'){
      add('gateway',{status:p.state??'미확인',specs:{'종류':'Interconnect VLAN','대역폭':p.bandwidth??'미확인','유형':p.type??'미확인'}});
      if(p.router)links.push(relation(id(a.name),id(p.router),'attachment','Interconnect BGP','interconnectAttachment.router'));
    } else if(t==='compute.googleapis.com/ForwardingRule')add('loadbalancer',{parent:p.subnetwork?id(p.subnetwork):undefined,ip:p.loadBalancingScheme==='INTERNAL'?p.IPAddress:undefined,publicIp:p.loadBalancingScheme==='INTERNAL'?undefined:p.IPAddress,status:'구성 수집됨',specs:{'종류':'Forwarding rule','스킴':p.loadBalancingScheme??'미확인','포트':p.ports?.join(', ')??'미확인'}});
    else if(t==='container.googleapis.com/Cluster')add('cluster',{parent:p.networkConfig?.subnetwork?id(p.networkConfig.subnetwork):undefined,status:p.status??'미확인',specs:{'종류':'GKE','버전':p.currentMasterVersion??'미확인','노드':String(p.currentNodeCount??'미확인')}});
    else if(t==='compute.googleapis.com/VpnTunnel'){
      add('gateway',{status:p.status==='ESTABLISHED'?'available':p.status??'미확인',specs:{'종류':'Cloud VPN tunnel','상태':p.status??'미확인'}});
      if(p.router)links.push(relation(id(a.name),id(p.router),'attachment','VPN BGP','vpnTunnel.router'));
    } else if(t==='redis.googleapis.com/Instance')add('database',{parent:p.authorizedNetwork?id(p.authorizedNetwork):undefined,ip:p.host,status:p.state==='READY'?'available':p.state??'미확인',specs:{'종류':'Memorystore','티어':p.tier??'미확인'}});
    else if(t==='sqladmin.googleapis.com/Instance')add('database',{parent:p.settings?.ipConfiguration?.privateNetwork?id(p.settings.ipConfiguration.privateNetwork):undefined,ip:p.ipAddresses?.[0]?.ipAddress,status:p.state??'미확인',specs:{'종류':'Cloud SQL','버전':p.databaseVersion??'미확인','티어':p.settings?.tier??'미확인'}});
    else if(t!=='compute.googleapis.com/Route'&&!t.startsWith('cloudresourcemanager.'))add('service',{status:p.state??p.status??'구성 수집됨',specs:{'서비스':t}});
  }
  for(const a of assets)if(a.assetType==='compute.googleapis.com/Route'){
    const p=a.resource?.data??{},network=resources.find(r=>r.id===id(p.network??''));if(!network)continue;
    const hop=p.nextHopIlb??p.nextHopPeering??p.nextHopGateway??p.nextHopIp??p.nextHopVpnTunnel??'미확인';
    // GCP routes belong to the network, carry a priority, and with tags apply only to instances that carry them.
    network.routes.push({destination:p.destRange??'미확인',nextHop:String(hop).split('/').pop()??'미확인',via:p.nextHopPeering?'Peering':p.nextHopIlb?'Load Balancer':p.nextHopGateway?'Gateway':p.nextHopVpnTunnel?'VPN':p.nextHopInstance?'Instance':'IP',priority:Number(p.priority??1000),...(p.tags?.length?{tags:p.tags}:{}),...(p.nextHopIp?{nextHopIp:p.nextHopIp}:{}),origin:String(a.name).includes('/default-route')||p.routeType==='SUBNET'?'system':'user'});
  }
  return {resources,links,warnings:[],scopeLabels:{}};
}

const PRIVILEGED=new Set(['owner','contributor','user access administrator','administratoraccess','iamfullaccess','poweruseraccess','roles/owner','roles/editor','roles/iam.securityadmin','roles/resourcemanager.organizationadmin']);
export const isPrivileged=(role:string)=>PRIVILEGED.has(role.toLowerCase());
const guidOf=(id:string)=>id.split('/').pop()?.toLowerCase()??id;
const azurePrincipalType=(t?:string)=>t==='User'?'user' as const:t==='Group'?'group' as const:t==='ServicePrincipal'?'serviceAccount' as const:'unknown' as const;
export function normalizeAzureIam(rows:Raw[],names:Map<string,string>=new Map()):IamAssignment[]{
  const roleNames=new Map(rows.filter(r=>r.type.toLowerCase().endsWith('roledefinitions')).map(r=>[guidOf(r.id),r.properties?.roleName]));
  return rows.filter(r=>r.type.toLowerCase().endsWith('roleassignments')).map(r=>{
    const p=r.properties??{},scope=String(p.scope??''),sub=scope.match(/\/subscriptions\/([^/]+)/i)?.[1],mg=scope.match(/managementGroups\/([^/]+)/i)?.[1],role=roleNames.get(guidOf(p.roleDefinitionId??''))??guidOf(p.roleDefinitionId??'미확인');
    return{id:`azure:${r.id}`,provider:'azure',principal:names.get(String(p.principalId).toLowerCase())??p.principalId,principalId:p.principalId,resourceScope:scope.toLowerCase(),principalType:azurePrincipalType(p.principalType),role,scope:sub??mg??'tenant',level:sub?(scope.toLowerCase().includes('/resourcegroups/')?'resource':'scope'):mg?'group':'org',privileged:isPrivileged(role),external:false,source:'Azure Resource Graph · authorizationresources'};
  });
}
const DAY=86_400_000;
export function normalizeAwsIam(data:Raw,account:string,now=Date.now()):IamAssignment[]{
  const out:IamAssignment[]=[],source='AWS IAM';
  for(const u of data.users??[]){
    const oldest=(u.keys??[]).filter((k:Raw)=>k.Status==='Active').map((k:Raw)=>Date.parse(k.CreateDate)).sort()[0];
    for(const [role,via] of [...(u.policies??[]).map((x:Raw)=>[x.PolicyName,'직접']),...(u.groupPolicies??[]).map((x:Raw)=>[x.PolicyName,x.group])] as [string,string][])
      out.push({id:`aws:${account}:user:${u.UserName}:${role}`,provider:'aws',principal:u.UserName,principalType:'user',role,scope:account,level:'scope',privileged:isPrivileged(role),external:false,mfa:u.mfa,keyAgeDays:oldest?Math.floor((now-oldest)/DAY):undefined,source:via==='직접'?source:`${source} · 그룹 ${via}`});
  }
  for(const r of data.roles??[]){
    let trust:Raw={};try{trust=typeof r.AssumeRolePolicyDocument==='string'?JSON.parse(decodeURIComponent(r.AssumeRolePolicyDocument)):r.AssumeRolePolicyDocument??{};}catch{/* an unreadable trust policy simply is not flagged */}
    const principals=(Array.isArray(trust.Statement)?trust.Statement:[trust.Statement]).filter(Boolean).flatMap((x:Raw)=>x.Principal?.AWS?[x.Principal.AWS].flat():[]) as string[];
    // Trust from outside the known accounts is what deserves a second look; which accounts are "known" is settled when snapshots merge.
    const external=principals.filter(a=>{const owner=a.match(/::(\d{12}):/)?.[1];return owner&&owner!==account;});
    for(const x of r.policies??[])out.push({id:`aws:${account}:role:${r.RoleName}:${x.PolicyName}`,provider:'aws',principal:r.RoleName,principalType:'role',role:x.PolicyName,scope:account,level:'scope',privileged:isPrivileged(x.PolicyName),external:external.length>0,source:external.length?`${source} · 신뢰: ${external.join(', ')}`:source});
  }
  return out;
}
export function normalizeGcpIam(assets:Raw[],projectNumbers:Map<string,string>=new Map(),fallbackProject?:string,orgDomain?:string):IamAssignment[]{
  const out:IamAssignment[]=[];
  for(const a of assets)for(const b of a.iamPolicy?.bindings??[])for(const member of b.members??[]){
    const [kind,value=kind]=String(member).split(/:(.*)/s),type=kind==='user'?'user' as const:kind==='group'?'group' as const:kind==='serviceAccount'?'serviceAccount' as const:kind==='allUsers'||kind==='allAuthenticatedUsers'?'public' as const:'unknown' as const;
    const tail=String(a.name).split('/').pop()!,level=a.assetType.endsWith('/Organization')?'org' as const:a.assetType.endsWith('/Folder')?'group' as const:'scope' as const,scope=level==='scope'?projectNumbers.get(tail)??fallbackProject??tail:tail,domain=value.split('@')[1];
    const external=type==='public'||(type==='user'&&!!orgDomain&&!!domain&&domain!==orgDomain);
    out.push({id:`gcp:${a.name}:${b.role}:${member}`,provider:'gcp',principal:value,principalType:type,role:b.role,scope,level,privileged:isPrivileged(b.role),external,source:'Cloud Asset Inventory · IAM_POLICY'});
  }
  return out;
}
