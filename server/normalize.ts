import { ResourceSchema, type Resource, type Link, type Provider } from '../shared/schema.js';
type Raw = Record<string, any>;
export type Normalized={resources:Resource[];links:Link[];warnings:string[]};
const base=(provider:Provider,id:string,name:string,kind:Resource['kind'],type:string,scope:string,region:string,source:string,extra:Partial<Resource>={}):Resource=>ResourceSchema.parse({id:`${provider}:${id}`,nativeId:id,name,provider,kind,type,scope,region,source,...extra});
const name=(r:Raw)=>r.Tags?.find((t:Raw)=>t.Key==='Name')?.Value;
const relation=(source:string,target:string,kind:Link['kind'],label:string,evidence:string):Link=>({id:`${kind}:${source}:${target}`,source,target,kind,label,evidence});
function finish(resources:Resource[],links:Link[]):Normalized {
  const ids=new Set(resources.map(r=>r.id)), warnings:string[]=[];
  for(const r of resources) if(r.parent&&!ids.has(r.parent)){warnings.push(`${r.name}: 상위 리소스 미수집`);delete r.parent;}
  const resolved=links.filter(e=>{if(ids.has(e.source)&&ids.has(e.target))return true;warnings.push(`${e.label}: 참조 대상 미수집 (${e.target})`);return false;});
  return {resources,links:[...new Map(resolved.map(e=>[e.id,e])).values()],warnings};
}
export function normalizeAzure(rows:Raw[]):Normalized {
  const resources:Resource[]=[], links:Link[]=[];
  const id=(v:string)=>`azure:${v.toLowerCase()}`;
  const byId=new Map(rows.map(r=>[r.id.toLowerCase(),r]));
  for(const r of rows){
    const native=r.id.toLowerCase(),t=r.type.toLowerCase(),p=r.properties??{}, common=[r.subscriptionId,r.location??'global','Azure Resource Graph'] as const;
    const add=(kind:Resource['kind'],extra:Partial<Resource>={})=>resources.push(base('azure',native,r.name,kind,r.type,...common,{tags:r.tags??{},...extra}));
    if(t==='microsoft.network/virtualnetworks'){
      add('network',{cidr:p.addressSpace?.addressPrefixes?.join(', ')});
      for(const sub of p.subnets??[]){resources.push(base('azure',sub.id.toLowerCase(),sub.name,'subnet','Microsoft.Network/virtualNetworks/subnets',...common,{parent:id(r.id),cidr:sub.properties?.addressPrefix??sub.properties?.addressPrefixes?.join(', ')}));if(sub.properties?.networkSecurityGroup?.id)links.push(relation(id(sub.properties.networkSecurityGroup.id),id(sub.id),'policy','NSG 적용','subnet.properties.networkSecurityGroup.id'));}
      for(const peer of p.virtualNetworkPeerings??[])if(peer.properties?.remoteVirtualNetwork?.id)links.push(relation(id(r.id),id(peer.properties.remoteVirtualNetwork.id),'peering','VNet peering','virtualNetworkPeerings.remoteVirtualNetwork.id'));
    } else if(t==='microsoft.compute/virtualmachines'){
      const nic=byId.get(p.networkProfile?.networkInterfaces?.[0]?.id?.toLowerCase()), ip=nic?.properties?.ipConfigurations?.[0]?.properties;
      add('compute',{parent:ip?.subnet?.id?id(ip.subnet.id):undefined,ip:ip?.privateIPAddress,status:p.provisioningState??'미확인',specs:{'인스턴스':p.hardwareProfile?.vmSize??'미확인','OS':p.storageProfile?.osDisk?.osType??'미확인','vCPU':'SKU 추가 조회 필요','메모리':'SKU 추가 조회 필요','GPU':'SKU 추가 조회 필요'}});
      if(nic?.properties?.networkSecurityGroup?.id)links.push(relation(id(nic.properties.networkSecurityGroup.id),id(r.id),'policy','NIC 보안 정책','networkInterface.networkSecurityGroup.id'));
    } else if(t==='microsoft.network/networksecuritygroups')add('firewall',{rules:[...(p.securityRules??[]),...(p.defaultSecurityRules??[])].map((rule:Raw)=>{const q=rule.properties??{};return{direction:q.direction??'Unknown',action:q.access??'Unknown',protocol:q.protocol??'*',ports:q.destinationPortRange??q.destinationPortRanges?.join(', ')??'*',source:q.sourceAddressPrefix??q.sourceAddressPrefixes?.join(', ')??q.sourceApplicationSecurityGroups?.map((x:Raw)=>x.id).join(', ')??'미확인',destination:q.destinationAddressPrefix??q.destinationAddressPrefixes?.join(', ')??'미확인',priority:String(q.priority??'-')};})});
    else if(t==='microsoft.network/expressroutecircuits')add('gateway',{specs:{'대역폭':`${p.serviceProviderProperties?.bandwidthInMbps??'?'} Mbps`,'공급자':p.serviceProviderProperties?.serviceProviderName??'미확인'},status:p.provisioningState??'미확인'});
    else if(t==='microsoft.network/virtualnetworkgateways'){
      add('gateway',{specs:{'종류':p.gatewayType??'미확인'}});
      const subnet=p.ipConfigurations?.[0]?.properties?.subnet?.id;
      if(subnet)links.push(relation(id(r.id),id(subnet.split('/subnets/')[0]),'attachment','VNet 연결','gateway.ipConfigurations.subnet.id'));
    } else if(t==='microsoft.network/connections'&&p.virtualNetworkGateway1?.id&&p.peer?.id)links.push(relation(id(p.peer.id),id(p.virtualNetworkGateway1.id),'attachment',p.connectionType??'연결','connection.peer.id / virtualNetworkGateway1.id'));
  }
  return finish(resources,links);
}
export function normalizeAws(data:Raw,scope:string,region:string):Normalized {
  const resources:Resource[]=[],links:Link[]=[];
  const native=(id:string)=>`${scope}/${region}/${id}`,id=(v:string)=>`aws:${native(v)}`;
  const add=(r:Raw,key:string,kind:Resource['kind'],type:string,extra:Partial<Resource>={})=>resources.push(base('aws',native(r[key]),name(r)??r[key],kind,type,scope,region,'EC2 Describe APIs',{tags:Object.fromEntries((r.Tags??[]).map((t:Raw)=>[t.Key,t.Value??''])),...extra}));
  for(const r of data.Vpcs??[])add(r,'VpcId','network','AWS::EC2::VPC',{cidr:r.CidrBlock});
  for(const r of data.Subnets??[])add(r,'SubnetId','subnet','AWS::EC2::Subnet',{parent:id(r.VpcId),cidr:r.CidrBlock,specs:{'가용 영역':r.AvailabilityZone??'미확인'}});
  for(const r of data.SecurityGroups??[])add(r,'GroupId','firewall','AWS::EC2::SecurityGroup',{parent:id(r.VpcId),rules:[...(r.IpPermissions??[]).map((v:Raw)=>({...v,direction:'Inbound'})),...(r.IpPermissionsEgress??[]).map((v:Raw)=>({...v,direction:'Outbound'}))].map((v:Raw)=>({direction:v.direction,action:'Allow',protocol:v.IpProtocol==='-1'?'All':v.IpProtocol,ports:v.FromPort==null?'All':`${v.FromPort}${v.ToPort!==v.FromPort?`–${v.ToPort}`:''}`,source:v.direction==='Inbound'?[...(v.IpRanges??[]).map((x:Raw)=>x.CidrIp),...(v.Ipv6Ranges??[]).map((x:Raw)=>x.CidrIpv6),...(v.UserIdGroupPairs??[]).map((x:Raw)=>x.GroupId),...(v.PrefixListIds??[]).map((x:Raw)=>x.PrefixListId)].join(', ')||'미확인':'attached resources',destination:v.direction==='Outbound'?[...(v.IpRanges??[]).map((x:Raw)=>x.CidrIp),...(v.Ipv6Ranges??[]).map((x:Raw)=>x.CidrIpv6),...(v.UserIdGroupPairs??[]).map((x:Raw)=>x.GroupId),...(v.PrefixListIds??[]).map((x:Raw)=>x.PrefixListId)].join(', ')||'미확인':'attached resources',priority:'동일 평가'}))});
  for(const reservation of data.Reservations??[])for(const r of reservation.Instances??[]){
    const spec=data.InstanceTypes?.find((x:Raw)=>x.InstanceType===r.InstanceType);
    add(r,'InstanceId','compute','AWS::EC2::Instance',{parent:r.SubnetId?id(r.SubnetId):undefined,ip:r.PrivateIpAddress,status:r.State?.Name??'미확인',specs:{'인스턴스':r.InstanceType??'미확인','vCPU':String(spec?.VCpuInfo?.DefaultVCpus??'미수집'),'메모리':spec?.MemoryInfo?.SizeInMiB?`${spec.MemoryInfo.SizeInMiB/1024} GiB`:'미수집','GPU':spec?String(spec.GpuInfo?.Gpus?.map((g:Raw)=>`${g.Count} × ${g.Name}`).join(', ')||'없음'):'미수집'}});
    for(const sg of r.SecurityGroups??[])links.push(relation(id(sg.GroupId),id(r.InstanceId),'policy','Security Group 적용','instance.SecurityGroups'));
  }
  for(const r of data.VpnGateways??[]){add(r,'VpnGatewayId','gateway','AWS::EC2::VPNGateway',{status:r.State??'미확인'});for(const a of r.VpcAttachments??[])links.push(relation(id(r.VpnGatewayId),id(a.VpcId),'attachment','VPN Gateway 연결','vpnGateway.VpcAttachments'));}
  return finish(resources,links);
}
export function normalizeGcp(assets:Raw[]):Normalized {
  const resources:Resource[]=[],links:Link[]=[];
  const canonical=(v:string)=>v.replace('https://www.googleapis.com/compute/v1/','//compute.googleapis.com/');
  const id=(v:string)=>`gcp:${canonical(v)}`;
  for(const a of assets){
    const p=a.resource?.data??{}, t=a.assetType, scope=a.name.match(/projects\/([^/]+)/)?.[1]??'unknown',region=a.resource?.location??p.region?.split('/').pop()??p.zone?.split('/').pop()??'global';
    const add=(kind:Resource['kind'],extra:Partial<Resource>={})=>resources.push(base('gcp',a.name,p.name??a.name.split('/').pop(),kind,t,scope,region,'Cloud Asset Inventory · RESOURCE',{tags:p.labels??{},...extra}));
    if(t==='compute.googleapis.com/Network')add('network',{specs:{'라우팅 모드':p.routingConfig?.routingMode??'미확인'}});
    else if(t==='compute.googleapis.com/Subnetwork')add('subnet',{parent:p.network?id(p.network):undefined,cidr:p.ipCidrRange});
    else if(t==='compute.googleapis.com/Instance')add('compute',{parent:p.networkInterfaces?.[0]?.subnetwork?id(p.networkInterfaces[0].subnetwork):undefined,ip:p.networkInterfaces?.[0]?.networkIP,status:p.status??'미확인',specs:{'인스턴스':p.machineType?.split('/').pop()??'미확인','vCPU':'machineTypes.get 추가 조회 필요','메모리':'machineTypes.get 추가 조회 필요','GPU':p.guestAccelerators?.map((g:Raw)=>`${g.acceleratorCount} × ${g.acceleratorType.split('/').pop()}`).join(', ')||'없음'}});
    else if(t==='compute.googleapis.com/Firewall'){
      add('firewall',{parent:p.network?id(p.network):undefined,status:p.disabled?'disabled':'enabled',specs:{'대상 태그':p.targetTags?.join(', ')||'전체 대상 (태그 제한 없음)','비활성':String(p.disabled??false)},rules:[...(p.allowed??[]).map((r:Raw)=>({...r,action:'Allow'})),...(p.denied??[]).map((r:Raw)=>({...r,action:'Deny'}))].map((r:Raw)=>({direction:p.direction??'INGRESS',action:r.action,protocol:r.IPProtocol,ports:r.ports?.join(', ')||'All',source:p.sourceRanges?.join(', ')||p.sourceTags?.join(', ')||'미지정',destination:p.destinationRanges?.join(', ')||p.targetTags?.join(', ')||'network targets',priority:String(p.priority??1000)}))});
      if(p.network)links.push(relation(id(a.name),id(p.network),'policy','VPC 방화벽 정책','firewall.network (대상 태그·서비스 계정 별도 평가 필요)'));
    } else if(t==='compute.googleapis.com/Router'){
      add('gateway',{specs:{'ASN':String(p.bgp?.asn??'미확인')}});
      if(p.network)links.push(relation(id(a.name),id(p.network),'attachment','Cloud Router 구성','router.network — 데이터 평면 hop 아님'));
    }
  }
  return finish(resources,links);
}
