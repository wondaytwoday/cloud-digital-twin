import { ResourceSchema, type HierarchyNode, type Resource, type Link, type Provider } from '../shared/schema.js';
import { azureSkus, gcpMachines, skuSpecs } from './skus.js';
type Raw = Record<string, any>;
export type Normalized={resources:Resource[];links:Link[];warnings:string[];scopeLabels:Record<string,string>;hierarchy?:HierarchyNode[]};
const leafKind:Record<string,HierarchyNode['kind']>={azure:'subscription',aws:'account',gcp:'project'};
export const scopeNodeId=(provider:string,scope:string)=>`${provider}:scope:${scope}`;
const base=(provider:Provider,id:string,name:string,kind:Resource['kind'],type:string,scope:string,region:string,source:string,extra:Partial<Resource>={}):Resource=>ResourceSchema.parse({id:`${provider}:${id}`,nativeId:id,name,provider,kind,type,scope,region,source,...extra});
const name=(r:Raw)=>r.Tags?.find((t:Raw)=>t.Key==='Name')?.Value;
const relation=(source:string,target:string,kind:Link['kind'],label:string,evidence:string):Link=>({id:`${kind}:${source}:${target}`,source,target,kind,label,evidence});
const azurePrivateServices:Record<string,[Resource['kind'],string]>={'microsoft.cache/redis':['database','Azure Cache for Redis'],'microsoft.documentdb/databaseaccounts':['database','Cosmos DB'],'microsoft.storage/storageaccounts':['storage','Storage account']};
const pairKey=(l:Link)=>l.kind==='peering'?`peering:${[l.source,l.target].sort().join('|')}`:l.id;
// Runs after all accounts/projects merge: a reference into another collected account is not dangling.
export function finish(parts:Normalized[]):Normalized {
  const resources=[...new Map(parts.flatMap(p=>p.resources).map(r=>[r.id,r])).values()];
  const links=parts.flatMap(p=>p.links),warnings=parts.flatMap(p=>p.warnings),ids=new Set(resources.map(r=>r.id));
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
  const unique=new Map<string,Link>();for(const l of resolved){const key=pairKey(l),seen=unique.get(key);if(!seen||l.label.length>seen.label.length)unique.set(key,l);}
  const scopeLabels=Object.assign({},...parts.map(p=>p.scopeLabels));if(resources.some(r=>r.scope==='external'))scopeLabels.external='외부 참조';
  // Any scope the org APIs did not explain still appears, directly under its provider, so nothing is unreachable from the tree.
  const hierarchy=new Map(parts.flatMap(p=>p.hierarchy??[]).map(n=>[n.id,n]));
  for(const r of resources)if(r.provider!=='onprem'&&r.scope!=='external'&&!hierarchy.has(scopeNodeId(r.provider,r.scope)))hierarchy.set(scopeNodeId(r.provider,r.scope),{id:scopeNodeId(r.provider,r.scope),name:scopeLabels[r.scope]??r.scope,provider:r.provider,kind:leafKind[r.provider],nativeId:r.scope,scope:r.scope});
  for(const n of hierarchy.values())if(n.scope&&!scopeLabels[n.scope])scopeLabels[n.scope]=n.name;
  return {resources,links:[...unique.values()],warnings,scopeLabels,hierarchy:[...hierarchy.values()]};
}
export function normalizeAzure(rows:Raw[],scopeLabels:Record<string,string>={}):Normalized {
  const resources:Resource[]=[], links:Link[]=[];
  const id=(v:string)=>`azure:${v.toLowerCase()}`;
  const byId=new Map(rows.map(r=>[r.id.toLowerCase(),r]));
  const nicOwner=new Map<string,string>();
  for(const r of rows)if(r.type.toLowerCase()==='microsoft.compute/virtualmachines')for(const n of r.properties?.networkProfile?.networkInterfaces??[])nicOwner.set(n.id.toLowerCase(),r.id);
  const privateEndpoints=new Map<string,Raw>();
  for(const r of rows)if(r.type.toLowerCase()==='microsoft.network/privateendpoints')for(const c of r.properties?.privateLinkServiceConnections??[])if(c.properties?.privateLinkServiceId)privateEndpoints.set(c.properties.privateLinkServiceId.toLowerCase(),r.properties);
  for(const r of rows){
    const native=r.id.toLowerCase(),t=r.type.toLowerCase(),p=r.properties??{}, common=[r.subscriptionId,r.location??'global','Azure Resource Graph'] as const;
    const add=(kind:Resource['kind'],extra:Partial<Resource>={})=>resources.push(base('azure',native,r.name,kind,r.type,...common,{group:r.resourceGroup,tags:r.tags??{},...extra}));
    if(t==='microsoft.network/virtualnetworks'){
      add('network',{cidr:p.addressSpace?.addressPrefixes?.join(', ')});
      for(const sub of p.subnets??[]){resources.push(base('azure',sub.id.toLowerCase(),sub.name,'subnet','Microsoft.Network/virtualNetworks/subnets',...common,{group:r.resourceGroup,parent:id(r.id),cidr:sub.properties?.addressPrefix??sub.properties?.addressPrefixes?.join(', ')}));if(sub.properties?.networkSecurityGroup?.id)links.push(relation(id(sub.properties.networkSecurityGroup.id),id(sub.id),'policy','NSG 적용','subnet.properties.networkSecurityGroup.id'));}
      for(const peer of p.virtualNetworkPeerings??[])if(peer.properties?.remoteVirtualNetwork?.id)links.push(relation(id(r.id),id(peer.properties.remoteVirtualNetwork.id),'peering',peer.properties.allowGatewayTransit||peer.properties.useRemoteGateways?'Peering · transit':'Peering','virtualNetworkPeerings.remoteVirtualNetwork.id'));
    } else if(t==='microsoft.compute/virtualmachines'){
      const nic=byId.get(p.networkProfile?.networkInterfaces?.[0]?.id?.toLowerCase()), ip=nic?.properties?.ipConfigurations?.[0]?.properties,size=p.hardwareProfile?.vmSize;
      add('compute',{parent:ip?.subnet?.id?id(ip.subnet.id):undefined,ip:ip?.privateIPAddress,status:p.extended?.instanceView?.powerState?.code?.split('/').pop()??p.provisioningState??'미확인',specs:{'인스턴스':size??'미확인','OS':p.storageProfile?.osDisk?.osType??'미확인',...skuSpecs(azureSkus[size])}});
      if(nic?.properties?.networkSecurityGroup?.id)links.push(relation(id(nic.properties.networkSecurityGroup.id),id(r.id),'policy','NIC 보안 정책','networkInterface.networkSecurityGroup.id'));
    } else if(t==='microsoft.network/networksecuritygroups')add('firewall',{rules:[...(p.securityRules??[]),...(p.defaultSecurityRules??[])].map((rule:Raw)=>{const q=rule.properties??{};return{direction:q.direction??'Unknown',action:q.access??'Unknown',protocol:q.protocol??'*',ports:q.destinationPortRange??q.destinationPortRanges?.join(', ')??'*',source:q.sourceAddressPrefix??q.sourceAddressPrefixes?.join(', ')??q.sourceApplicationSecurityGroups?.map((x:Raw)=>x.id).join(', ')??'미확인',destination:q.destinationAddressPrefix??q.destinationAddressPrefixes?.join(', ')??'미확인',priority:String(q.priority??'-')};})});
    else if(t==='microsoft.network/expressroutecircuits')add('gateway',{specs:{'종류':'ExpressRoute circuit','대역폭':`${p.serviceProviderProperties?.bandwidthInMbps??'?'} Mbps`,'공급자':p.serviceProviderProperties?.serviceProviderName??'미확인','피어링 위치':p.serviceProviderProperties?.peeringLocation??'미확인'},status:p.provisioningState??'미확인'});
    else if(t==='microsoft.network/virtualnetworkgateways'){
      const subnet=p.ipConfigurations?.[0]?.properties?.subnet?.id;
      add('gateway',{parent:subnet?id(subnet):undefined,status:p.provisioningState??'미확인',specs:{'종류':`${p.gatewayType??'미확인'} gateway`,'SKU':p.sku?.name??'미확인'}});
    } else if(t==='microsoft.network/connections'&&p.virtualNetworkGateway1?.id&&p.peer?.id)links.push(relation(id(p.peer.id),id(p.virtualNetworkGateway1.id),'attachment',p.connectionType??'연결','connection.peer.id / virtualNetworkGateway1.id'));
    else if(t==='microsoft.network/azurefirewalls'){
      const ip=p.ipConfigurations?.[0]?.properties;
      add('appliance',{parent:ip?.subnet?.id?id(ip.subnet.id):undefined,ip:ip?.privateIPAddress,status:p.provisioningState??'미확인',specs:{'종류':'Azure Firewall','SKU':p.sku?.tier??'미확인'}});
    } else if(t==='microsoft.network/loadbalancers'){
      const front=p.frontendIPConfigurations?.[0]?.properties;
      add('loadbalancer',{parent:front?.subnet?.id?id(front.subnet.id):undefined,ip:front?.privateIPAddress,status:p.provisioningState??'미확인',specs:{'종류':front?.subnet?'내부 Load Balancer':'공용 Load Balancer','SKU':r.sku?.name??'미확인'}});
      for(const pool of p.backendAddressPools??[])for(const c of pool.properties?.backendIPConfigurations??[]){const vm=nicOwner.get(c.id.toLowerCase().split('/ipconfigurations/')[0]);if(vm)links.push(relation(id(r.id),id(vm),'attachment','백엔드 풀','loadBalancer.backendAddressPools.backendIPConfigurations'));}
    } else if(t==='microsoft.network/applicationgateways'){
      add('loadbalancer',{parent:p.gatewayIPConfigurations?.[0]?.properties?.subnet?.id?id(p.gatewayIPConfigurations[0].properties.subnet.id):undefined,ip:p.frontendIPConfigurations?.[0]?.properties?.privateIPAddress,status:p.operationalState??p.provisioningState??'미확인',specs:{'종류':'Application Gateway','SKU':p.sku?.tier??'미확인'}});
      for(const pool of p.backendAddressPools??[])for(const c of pool.properties?.backendIPConfigurations??[]){const vm=nicOwner.get(c.id.toLowerCase().split('/ipconfigurations/')[0]);if(vm)links.push(relation(id(r.id),id(vm),'attachment','백엔드 풀','applicationGateway.backendAddressPools.backendIPConfigurations'));}
    } else if(t==='microsoft.network/bastionhosts')add('appliance',{parent:p.ipConfigurations?.[0]?.properties?.subnet?.id?id(p.ipConfigurations[0].properties.subnet.id):undefined,status:p.provisioningState??'미확인',specs:{'종류':'Azure Bastion'}});
    else if(azurePrivateServices[t]){
      const pe=privateEndpoints.get(native),[kind,label]=azurePrivateServices[t];
      add(kind,{parent:pe?.subnet?.id?id(pe.subnet.id):undefined,ip:pe?.customDnsConfigs?.[0]?.ipAddresses?.[0],status:p.provisioningState??'미확인',specs:{'종류':label,'연결':pe?'Private Endpoint':'공용 엔드포인트'}});
    } else if(t==='microsoft.network/natgateways')add('nat',{parent:p.subnets?.[0]?.id?id(p.subnets[0].id):undefined,status:p.provisioningState??'미확인',specs:{'종류':'NAT Gateway'}});
    else if(t==='microsoft.containerservice/managedclusters'){
      const pools=p.agentPoolProfiles??[],subnet=pools[0]?.vnetSubnetID;
      add('cluster',{parent:subnet?id(subnet):undefined,status:p.powerState?.code??p.provisioningState??'미확인',specs:{'종류':'AKS','버전':p.kubernetesVersion??'미확인','노드':String(pools.reduce((s:number,x:Raw)=>s+(x.count??0),0))}});
    } else if(t==='microsoft.sql/servers'){
      const pe=privateEndpoints.get(native);
      add('database',{parent:pe?.subnet?.id?id(pe.subnet.id):undefined,ip:pe?.customDnsConfigs?.[0]?.ipAddresses?.[0],status:p.state??'미확인',specs:{'종류':'Azure SQL','버전':p.version??'미확인','연결':pe?'Private Endpoint':'공용 엔드포인트'}});
    }
  }
  return {resources,links,warnings:[],scopeLabels};
}
export function normalizeAws(data:Raw,scope:string,region:string,label?:string):Normalized {
  const resources:Resource[]=[],links:Link[]=[];
  const native=(id:string,account=scope,at=region)=>`${account}/${at}/${id}`,id=(v:string,account=scope,at=region)=>`aws:${native(v,account,at)}`;
  const add=(r:Raw,key:string,kind:Resource['kind'],type:string,extra:Partial<Resource>={})=>resources.push(base('aws',native(r[key]),name(r)??r[key],kind,type,scope,region,'AWS Describe APIs',{group:region,tags:Object.fromEntries((r.Tags??[]).map((t:Raw)=>[t.Key,t.Value??''])),...extra}));
  for(const r of data.Vpcs??[])add(r,'VpcId','network','AWS::EC2::VPC',{cidr:r.CidrBlock});
  for(const r of data.Subnets??[])add(r,'SubnetId','subnet','AWS::EC2::Subnet',{parent:id(r.VpcId),cidr:r.CidrBlock,specs:{'가용 영역':r.AvailabilityZone??'미확인','공개 IP 자동 할당':String(r.MapPublicIpOnLaunch??false)}});
  for(const r of data.SecurityGroups??[])add(r,'GroupId','firewall','AWS::EC2::SecurityGroup',{parent:id(r.VpcId),rules:[...(r.IpPermissions??[]).map((v:Raw)=>({...v,direction:'Inbound'})),...(r.IpPermissionsEgress??[]).map((v:Raw)=>({...v,direction:'Outbound'}))].map((v:Raw)=>({direction:v.direction,action:'Allow',protocol:v.IpProtocol==='-1'?'All':v.IpProtocol,ports:v.FromPort==null?'All':`${v.FromPort}${v.ToPort!==v.FromPort?`–${v.ToPort}`:''}`,source:v.direction==='Inbound'?[...(v.IpRanges??[]).map((x:Raw)=>x.CidrIp),...(v.Ipv6Ranges??[]).map((x:Raw)=>x.CidrIpv6),...(v.UserIdGroupPairs??[]).map((x:Raw)=>x.GroupId),...(v.PrefixListIds??[]).map((x:Raw)=>x.PrefixListId)].join(', ')||'미확인':'attached resources',destination:v.direction==='Outbound'?[...(v.IpRanges??[]).map((x:Raw)=>x.CidrIp),...(v.Ipv6Ranges??[]).map((x:Raw)=>x.CidrIpv6),...(v.UserIdGroupPairs??[]).map((x:Raw)=>x.GroupId),...(v.PrefixListIds??[]).map((x:Raw)=>x.PrefixListId)].join(', ')||'미확인':'attached resources',priority:'동일 평가'}))});
  for(const reservation of data.Reservations??[])for(const r of reservation.Instances??[]){
    const spec=data.InstanceTypes?.find((x:Raw)=>x.InstanceType===r.InstanceType);
    add(r,'InstanceId','compute','AWS::EC2::Instance',{parent:r.SubnetId?id(r.SubnetId):undefined,ip:r.PrivateIpAddress,status:r.State?.Name??'미확인',specs:{'인스턴스':r.InstanceType??'미확인','vCPU':String(spec?.VCpuInfo?.DefaultVCpus??'미수집'),'메모리':spec?.MemoryInfo?.SizeInMiB?`${spec.MemoryInfo.SizeInMiB/1024} GiB`:'미수집','GPU':spec?String(spec.GpuInfo?.Gpus?.map((g:Raw)=>`${g.Count} × ${g.Name}`).join(', ')||'없음'):'미수집'}});
    for(const sg of r.SecurityGroups??[])links.push(relation(id(sg.GroupId),id(r.InstanceId),'policy','Security Group 적용','instance.SecurityGroups'));
  }
  for(const r of data.VpnGateways??[]){add(r,'VpnGatewayId','gateway','AWS::EC2::VPNGateway',{status:r.State??'미확인',specs:{'종류':'Virtual Private Gateway'}});for(const a of r.VpcAttachments??[])links.push(relation(id(r.VpnGatewayId),id(a.VpcId),'attachment','VPN Gateway 연결','vpnGateway.VpcAttachments'));}
  for(const r of data.InternetGateways??[]){const vpc=r.Attachments?.[0]?.VpcId;add(r,'InternetGatewayId','gateway','AWS::EC2::InternetGateway',{parent:vpc?id(vpc):undefined,status:r.Attachments?.[0]?.State??'미확인',specs:{'종류':'Internet Gateway'}});}
  for(const r of data.NatGateways??[])add(r,'NatGatewayId','nat','AWS::EC2::NatGateway',{parent:r.SubnetId?id(r.SubnetId):undefined,ip:r.NatGatewayAddresses?.[0]?.PrivateIp,status:r.State??'미확인',specs:{'종류':'NAT Gateway','연결':r.ConnectivityType??'public'}});
  for(const r of data.TransitGateways??[])add(r,'TransitGatewayId','gateway','AWS::EC2::TransitGateway',{status:r.State??'미확인',specs:{'종류':'Transit Gateway','ASN':String(r.Options?.AmazonSideAsn??'미확인')}});
  for(const r of data.TransitGatewayVpcAttachments??[])links.push(relation(id(r.TransitGatewayId,r.TransitGatewayOwnerId??scope),id(r.VpcId,r.VpcOwnerId??scope),'attachment','TGW attachment','transitGatewayVpcAttachment.VpcId / VpcOwnerId'));
  for(const r of data.TransitGatewayPeeringAttachments??[])if(r.State==='available')links.push(relation(id(r.RequesterTgwInfo.TransitGatewayId,r.RequesterTgwInfo.OwnerId??scope,r.RequesterTgwInfo.Region??region),id(r.AccepterTgwInfo.TransitGatewayId,r.AccepterTgwInfo.OwnerId??scope,r.AccepterTgwInfo.Region??region),'peering','TGW peering','transitGatewayPeeringAttachment'));
  for(const r of data.DirectConnectGateways??[]){
    resources.push(base('aws',native(r.directConnectGatewayId),r.directConnectGatewayName??r.directConnectGatewayId,'gateway','AWS::DirectConnect::DirectConnectGateway',scope,region,'AWS Describe APIs',{group:region,status:r.directConnectGatewayState??'미확인',specs:{'종류':'Direct Connect gateway','ASN':String(r.amazonSideAsn??'미확인')}}));
    for(const a of r.associations??[])if(a.associatedGateway?.id)links.push(relation(id(r.directConnectGatewayId),id(a.associatedGateway.id,a.associatedGateway.ownerAccount??scope,a.associatedGateway.region??region),'attachment','DX 연결','directConnectGatewayAssociation.associatedGateway'));
  }
  for(const r of data.Clusters??[])resources.push(base('aws',native(r.name),r.name,'cluster','AWS::EKS::Cluster',scope,region,'AWS Describe APIs',{group:region,parent:r.resourcesVpcConfig?.subnetIds?.[0]?id(r.resourcesVpcConfig.subnetIds[0]):undefined,status:r.status??'미확인',specs:{'종류':'EKS','버전':r.version??'미확인'}}));
  for(const r of data.VpnConnections??[]){
    const tunnels=r.VgwTelemetry??[],up=tunnels.filter((t:Raw)=>t.Status==='UP').length;
    add(r,'VpnConnectionId','gateway','AWS::EC2::VPNConnection',{status:r.State==='available'&&tunnels.length&&up<tunnels.length?'degraded':r.State??'미확인',specs:{'종류':'Site-to-Site VPN','터널':`${up}/${tunnels.length} UP`,'고객 게이트웨이':r.CustomerGatewayId??'미확인'}});
    const target=r.TransitGatewayId??r.VpnGatewayId;if(target)links.push(relation(id(r.VpnConnectionId),id(target),'attachment','VPN 연결','vpnConnection.TransitGatewayId'));
  }
  for(const r of data.VpcPeeringConnections??[])if(r.Status?.Code==='active')links.push(relation(id(r.RequesterVpcInfo.VpcId,r.RequesterVpcInfo.OwnerId??scope),id(r.AccepterVpcInfo.VpcId,r.AccepterVpcInfo.OwnerId??scope),'peering','Peering','vpcPeeringConnection'));
  for(const r of data.LoadBalancers??[]){
    add(r,'LoadBalancerName','loadbalancer','AWS::ElasticLoadBalancingV2::LoadBalancer',{parent:r.AvailabilityZones?.[0]?.SubnetId?id(r.AvailabilityZones[0].SubnetId):undefined,status:r.State?.Code??'미확인',specs:{'종류':`${r.Type??'application'} LB`,'공개 범위':r.Scheme??'미확인'}});
    for(const target of r.Targets??[])links.push(relation(id(r.LoadBalancerName),id(target),'attachment','대상 그룹','describeTargetHealth.Target.Id'));
  }
  for(const r of data.DBInstances??[]){
    add(r,'DBInstanceIdentifier','database','AWS::RDS::DBInstance',{parent:r.DBSubnetGroup?.Subnets?.[0]?.SubnetIdentifier?id(r.DBSubnetGroup.Subnets[0].SubnetIdentifier):undefined,status:r.DBInstanceStatus??'미확인',specs:{'종류':r.Engine??'RDS','인스턴스':r.DBInstanceClass??'미확인','Multi-AZ':String(r.MultiAZ??false)}});
    for(const sg of r.VpcSecurityGroups??[])links.push(relation(id(sg.VpcSecurityGroupId),id(r.DBInstanceIdentifier),'policy','Security Group 적용','dbInstance.VpcSecurityGroups'));
  }
  return {resources,links,warnings:[],scopeLabels:label?{[scope]:label}:{}};
}
export function normalizeGcp(assets:Raw[]):Normalized {
  const resources:Resource[]=[],links:Link[]=[];
  // Cluster and Cloud SQL report partial or leading-slash references; Compute assets use full URLs.
  const canonical=(v:string)=>v.replace('https://www.googleapis.com/compute/v1/','//compute.googleapis.com/').replace(/^\/?projects\//,'//compute.googleapis.com/projects/');
  const id=(v:string)=>`gcp:${canonical(v)}`;
  for(const a of assets){
    const p=a.resource?.data??{}, t=a.assetType, scope=a.name.match(/projects\/([^/]+)/)?.[1]??'unknown',region=a.resource?.location??p.region?.split('/').pop()??p.zone?.split('/').pop()??'global';
    const add=(kind:Resource['kind'],extra:Partial<Resource>={})=>resources.push(base('gcp',a.name,p.name??a.name.split('/').pop(),kind,t,scope,region,'Cloud Asset Inventory · RESOURCE',{group:region,tags:p.labels??{},...extra}));
    if(t==='compute.googleapis.com/Network'){
      add('network',{specs:{'라우팅 모드':p.routingConfig?.routingMode??'미확인'}});
      for(const peer of p.peerings??[])if(peer.network&&peer.state!=='INACTIVE')links.push(relation(id(a.name),id(peer.network),'peering','Peering','network.peerings.network'));
    }
    else if(t==='compute.googleapis.com/Subnetwork')add('subnet',{parent:p.network?id(p.network):undefined,cidr:p.ipCidrRange});
    else if(t==='compute.googleapis.com/Instance'){const machine=p.machineType?.split('/').pop();add('compute',{parent:p.networkInterfaces?.[0]?.subnetwork?id(p.networkInterfaces[0].subnetwork):undefined,ip:p.networkInterfaces?.[0]?.networkIP,status:p.status??'미확인',specs:{'인스턴스':machine??'미확인',...skuSpecs(gcpMachines[machine]),'GPU':p.guestAccelerators?.map((g:Raw)=>`${g.acceleratorCount} × ${g.acceleratorType.split('/').pop()}`).join(', ')||'없음'}});}
    else if(t==='compute.googleapis.com/Firewall'){
      add('firewall',{parent:p.network?id(p.network):undefined,status:p.disabled?'disabled':'enabled',specs:{'대상 태그':p.targetTags?.join(', ')||'전체 대상 (태그 제한 없음)','비활성':String(p.disabled??false)},rules:[...(p.allowed??[]).map((r:Raw)=>({...r,action:'Allow'})),...(p.denied??[]).map((r:Raw)=>({...r,action:'Deny'}))].map((r:Raw)=>({direction:p.direction??'INGRESS',action:r.action,protocol:r.IPProtocol,ports:r.ports?.join(', ')||'All',source:p.sourceRanges?.join(', ')||p.sourceTags?.join(', ')||'미지정',destination:p.destinationRanges?.join(', ')||p.targetTags?.join(', ')||'network targets',priority:String(p.priority??1000)}))});
      if(p.network)links.push(relation(id(a.name),id(p.network),'policy','VPC 방화벽 정책','firewall.network (대상 태그·서비스 계정 별도 평가 필요)'));
    } else if(t==='compute.googleapis.com/Router')add('gateway',{parent:p.network?id(p.network):undefined,specs:{'종류':'Cloud Router','ASN':String(p.bgp?.asn??'미확인')}});
    else if(t==='compute.googleapis.com/InterconnectAttachment'){
      add('gateway',{status:p.state??'미확인',specs:{'종류':'Interconnect VLAN','대역폭':p.bandwidth??'미확인','유형':p.type??'미확인'}});
      if(p.router)links.push(relation(id(a.name),id(p.router),'attachment','Interconnect BGP','interconnectAttachment.router'));
    } else if(t==='compute.googleapis.com/ForwardingRule')add('loadbalancer',{parent:p.subnetwork?id(p.subnetwork):undefined,ip:p.IPAddress,status:'구성 수집됨',specs:{'종류':'Forwarding rule','스킴':p.loadBalancingScheme??'미확인','포트':p.ports?.join(', ')??'미확인'}});
    else if(t==='container.googleapis.com/Cluster')add('cluster',{parent:p.networkConfig?.subnetwork?id(p.networkConfig.subnetwork):undefined,status:p.status??'미확인',specs:{'종류':'GKE','버전':p.currentMasterVersion??'미확인','노드':String(p.currentNodeCount??'미확인')}});
    else if(t==='compute.googleapis.com/VpnTunnel'){
      add('gateway',{status:p.status==='ESTABLISHED'?'available':p.status??'미확인',specs:{'종류':'Cloud VPN tunnel','상태':p.status??'미확인'}});
      if(p.router)links.push(relation(id(a.name),id(p.router),'attachment','VPN BGP','vpnTunnel.router'));
    } else if(t==='redis.googleapis.com/Instance')add('database',{parent:p.authorizedNetwork?id(p.authorizedNetwork):undefined,ip:p.host,status:p.state==='READY'?'available':p.state??'미확인',specs:{'종류':'Memorystore','티어':p.tier??'미확인'}});
    else if(t==='sqladmin.googleapis.com/Instance')add('database',{parent:p.settings?.ipConfiguration?.privateNetwork?id(p.settings.ipConfiguration.privateNetwork):undefined,ip:p.ipAddresses?.[0]?.ipAddress,status:p.state??'미확인',specs:{'종류':'Cloud SQL','버전':p.databaseVersion??'미확인','티어':p.settings?.tier??'미확인'}});
  }
  return {resources,links,warnings:[],scopeLabels:{}};
}
