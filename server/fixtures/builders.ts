// Synthetic, documented API-shaped fixtures. Never customer data.
import type {Raw} from './types.js';
type Rule=[string,string,string,string,string,string,number];
// Owner and service tags on part of the estate, picked by name, so the demo shows tagged resources and untagged gaps side by side.
// Azure uses Owner/Service, AWS owner/service and GCP lower-case labels, the way people actually type them.
const TEAMS:[RegExp,string,string][]=[[/hub|connectivity|transit|network|vgw|afw|er-/i,'network-team','connectivity'],[/checkout|orders|commerce/i,'commerce-team','checkout'],[/data|analytics|etl|warehouse/i,'data-team','analytics'],[/platform|aks|api/i,'platform-team','platform-api']];
const team=(hint:string)=>TEAMS.find(([re])=>re.test(hint));
export const ownerTags=(hint:string,owner='owner',service='service'):Record<string,string>=>{const t=team(hint);return t?{[owner]:t[1],[service]:t[2]}:{};};
export const azId=(sub:string,rg:string,type:string,n:string)=>`/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.${type}/${n}`;
export const azRow=(sub:string,rg:string,type:string,name:string,properties:object,extra:Raw={},location='koreacentral'):Raw=>({id:azId(sub,rg,type,name),type:`Microsoft.${type}`,name,location,subscriptionId:sub,resourceGroup:rg,tags:{environment:rg.includes('dev')?'dev':'production',...ownerTags(`${rg} ${name}`,'Owner','Service')},properties,...extra});
export const vnetId=(sub:string,rg:string,n:string)=>azId(sub,rg,'Network/virtualNetworks',n);
export const subnetId=(sub:string,rg:string,vnet:string,n:string)=>`${vnetId(sub,rg,vnet)}/subnets/${n}`;
export const nsgId=(sub:string,rg:string,n:string)=>azId(sub,rg,'Network/networkSecurityGroups',n);
export const vnet=(sub:string,rg:string,name:string,cidr:string,subnets:[string,string,string?][],peers:[string,Raw][]=[],location?:string)=>azRow(sub,rg,'Network/virtualNetworks',name,{addressSpace:{addressPrefixes:[cidr]},subnets:subnets.map(([n,prefix,nsg])=>({id:subnetId(sub,rg,name,n),name:n,properties:{addressPrefix:prefix,...(nsg?{networkSecurityGroup:{id:nsgId(sub,rg,nsg)}}:{})}})),virtualNetworkPeerings:peers.map(([remote,flags],i)=>({name:`peer-${i}`,properties:{remoteVirtualNetwork:{id:remote},peeringState:'Connected',...flags}}))},{},location);
// Resource Graph returns every NSG with Azure's six default rules alongside the ones a person wrote (sources and destinations as Azure documents them).
const defaultRule=(name:string,direction:string,access:string,source:string,destination:string,priority:number)=>({name,properties:{direction,access,protocol:'*',sourcePortRange:'*',destinationPortRange:'*',sourceAddressPrefix:source,destinationAddressPrefix:destination,priority}});
const AZURE_DEFAULT_RULES=[defaultRule('AllowVnetInBound','Inbound','Allow','VirtualNetwork','VirtualNetwork',65000),defaultRule('AllowAzureLoadBalancerInBound','Inbound','Allow','AzureLoadBalancer','*',65001),defaultRule('DenyAllInBound','Inbound','Deny','*','*',65500),
  defaultRule('AllowVnetOutBound','Outbound','Allow','VirtualNetwork','VirtualNetwork',65000),defaultRule('AllowInternetOutBound','Outbound','Allow','*','Internet',65001),defaultRule('DenyAllOutBound','Outbound','Deny','*','*',65500)];
// Fixture rules are inbound: [name, direction, access, protocol, destination port, source prefix, priority].
// A source of the form asg:<id> names an application security group instead of an address prefix.
const nsgRule=([rule,direction,access,protocol,port,source,priority]:Rule)=>({name:rule,properties:{direction,access,protocol,sourcePortRange:'*',destinationPortRange:port,...(source.startsWith('asg:')?{sourceApplicationSecurityGroups:[{id:source.slice(4)}]}:{sourceAddressPrefix:source}),destinationAddressPrefix:'*',priority}});
export const nsg=(sub:string,rg:string,name:string,rules:Rule[],location?:string)=>azRow(sub,rg,'Network/networkSecurityGroups',name,{securityRules:rules.map(nsgRule),defaultSecurityRules:AZURE_DEFAULT_RULES},{},location);
// What Resource Graph returns for a VM: the VM row with managed disk IDs, one row per disk with managedBy, and one row per NIC.
// extra adds what real estates have and the first demos did not: more NICs, secondary IPs, a managed identity.
export type VmExtra={secondaryIps?:string[];nics?:{subnet:string;ips:string[]}[];identity?:{principalId:string;userAssigned?:string[]};nicNsg?:string;asgs?:string[]};
export const vm=(sub:string,rg:string,vnetName:string,subnet:string,name:string,ip:string,size:string,power='running',location?:string,extra:VmExtra={})=>{
  const nicId=(n:string)=>azId(sub,rg,'Network/networkInterfaces',n),diskId=(n:string)=>azId(sub,rg,'Compute/disks',n),vmId=azId(sub,rg,'Compute/virtualMachines',name);
  const data=/^Standard_(E|NC)/.test(size)?[{lun:0,diskSizeGB:512,managedDisk:{id:diskId(`${name}-data-0`)}}]:[];
  const nics=[{n:`${name}-nic`,subnet,ips:[ip,...(extra.secondaryIps??[])]},...(extra.nics??[]).map((x,k)=>({n:`${name}-nic-${k+2}`,...x}))];
  const identity=extra.identity?{identity:{type:extra.identity.userAssigned?'SystemAssigned, UserAssigned':'SystemAssigned',principalId:extra.identity.principalId,...(extra.identity.userAssigned?{userAssignedIdentities:Object.fromEntries(extra.identity.userAssigned.map(id=>[id,{}]))}:{})}}:{};
  return [
    azRow(sub,rg,'Compute/virtualMachines',name,{provisioningState:'Succeeded',hardwareProfile:{vmSize:size},storageProfile:{osDisk:{osType:'Linux',diskSizeGB:128,managedDisk:{id:diskId(`${name}-os`)}},dataDisks:data},networkProfile:{networkInterfaces:nics.map((x,k)=>({id:nicId(x.n),properties:{primary:k===0}}))},extended:{instanceView:{powerState:{code:`PowerState/${power}`}}}},identity,location),
    azRow(sub,rg,'Compute/disks',`${name}-os`,{diskSizeGB:128,diskState:'Attached',osType:'Linux'},{managedBy:vmId,sku:{name:'Premium_LRS'}},location),
    ...data.map(d=>azRow(sub,rg,'Compute/disks',`${name}-data-${d.lun}`,{diskSizeGB:d.diskSizeGB,diskState:'Attached'},{managedBy:vmId,sku:{name:'Premium_LRS'}},location)),
    ...nics.map((x,k)=>azRow(sub,rg,'Network/networkInterfaces',x.n,{primary:k===0,virtualMachine:{id:vmId},...(k===0&&extra.nicNsg?{networkSecurityGroup:{id:nsgId(sub,rg,extra.nicNsg)}}:{}),ipConfigurations:x.ips.map((addr,m)=>({id:`${nicId(x.n)}/ipConfigurations/ipconfig${m+1}`,name:`ipconfig${m+1}`,properties:{primary:m===0,privateIPAddress:addr,subnet:{id:subnetId(sub,rg,vnetName,x.subnet)},...(k===0&&extra.asgs?{applicationSecurityGroups:extra.asgs.map(id=>({id}))}:{})}}))},{},location)),
  ];
};
export const nicConfig=(sub:string,rg:string,vmName:string)=>({id:`${azId(sub,rg,'Network/networkInterfaces',`${vmName}-nic`)}/ipConfigurations/ipconfig1`});
export const privateService=(sub:string,rg:string,type:string,name:string,properties:object,subnet:string,ip:string,location?:string)=>[azRow(sub,rg,type,name,properties,{},location),azRow(sub,rg,'Network/privateEndpoints',`pe-${name}`,{subnet:{id:subnet},customDnsConfigs:[{ipAddresses:[ip]}],privateLinkServiceConnections:[{properties:{privateLinkServiceId:azId(sub,rg,type,name)}}]},{},location)];
export const standardRules:Rule[]=[['AllowCorporateHTTPS','Inbound','Allow','Tcp','443','10.0.0.0/8',100],['DenyInternet','Inbound','Deny','*','*','Internet',4000]];
export const tag=(name:string,extra:Raw={})=>[{Key:'Name',Value:name},...Object.entries(extra).map(([Key,Value])=>({Key,Value}))];
// What DescribeInstances returns: the instance with each ENI, its addresses and its groups. extra adds a second ENI or an instance profile.
export type Ec2Extra={enis?:{subnet:string;ip:string;sg:string}[];profile?:string;secondaryIps?:string[]};
export const ec2=(id:string,name:string,type:string,subnet:string,ip:string,sg:string,state='running',extra:Ec2Extra={})=>({InstanceId:id,InstanceType:type,SubnetId:subnet,PrivateIpAddress:ip,State:{Name:state},SecurityGroups:[{GroupId:sg}],Tags:tag(name,{environment:'production',...ownerTags(name)}),
  ...(extra.profile?{IamInstanceProfile:{Arn:extra.profile}}:{}),
  NetworkInterfaces:[{subnet,ip,sg,extraIps:extra.secondaryIps??[]},...(extra.enis??[]).map(e=>({...e,extraIps:[] as string[]}))].map((n,k)=>({NetworkInterfaceId:`eni-${id.slice(2)}-${k}`,SubnetId:n.subnet,PrivateIpAddress:n.ip,PrivateIpAddresses:[{PrivateIpAddress:n.ip,Primary:true},...n.extraIps.map(x=>({PrivateIpAddress:x,Primary:false}))],Groups:[{GroupId:n.sg}],Attachment:{DeviceIndex:k,AttachmentId:`eni-attach-${id.slice(2)}-${k}`},Status:'in-use',SourceDestCheck:true}))});
// DescribeVolumes: one root volume per instance, attached by instance ID.
export const ebs=(instances:{InstanceId:string;State:{Name:string}}[])=>instances.map(i=>({VolumeId:`vol-${i.InstanceId.slice(2)}`,Size:100,VolumeType:'gp3',Encrypted:true,State:'in-use',AvailabilityZone:'ap-northeast-2a',Attachments:[{InstanceId:i.InstanceId,Device:'/dev/xvda',State:'attached'}]}));
// DescribeNetworkAcls: entries as AWS returns them, including the catch-all 32767 deny in each direction.
export const nacl=(id:string,vpc:string,subnets:string[],entries:[number,boolean,'allow'|'deny',string,string,[number,number]?][],isDefault=false)=>({NetworkAclId:id,VpcId:vpc,IsDefault:isDefault,Associations:subnets.map(s=>({SubnetId:s,NetworkAclAssociationId:`aclassoc-${s}`})),Tags:tag(id),
  Entries:([...entries,[32767,false,'deny','-1','0.0.0.0/0'],[32767,true,'deny','-1','0.0.0.0/0']] as [number,boolean,string,string,string,[number,number]?][]).map(([n,egress,action,proto,cidr,ports])=>({RuleNumber:n,Egress:egress,RuleAction:action,Protocol:proto,CidrBlock:cidr,...(ports?{PortRange:{From:ports[0],To:ports[1]}}:{})}))});
export const awsSubnet=(id:string,name:string,vpc:string,cidr:string,az:string,isPublic=false)=>({SubnetId:id,VpcId:vpc,CidrBlock:cidr,AvailabilityZone:az,MapPublicIpOnLaunch:isPublic,Tags:tag(name)});
export const sgRule=(port:number,cidr:string)=>({IpProtocol:'tcp',FromPort:port,ToPort:port,IpRanges:[{CidrIp:cidr}]});
export const egress=[{IpProtocol:'-1',IpRanges:[{CidrIp:'0.0.0.0/0'}]}];
export const securityGroup=(id:string,vpc:string,inbound:Raw[],outbound:Raw[]=egress)=>({GroupId:id,GroupName:id,VpcId:vpc,Tags:tag(id),IpPermissions:inbound,IpPermissionsEgress:outbound});
export const instanceTypes:Raw[]=[{InstanceType:'t3.medium',VCpuInfo:{DefaultVCpus:2},MemoryInfo:{SizeInMiB:4096}},{InstanceType:'m6i.xlarge',VCpuInfo:{DefaultVCpus:4},MemoryInfo:{SizeInMiB:16384}},{InstanceType:'c6i.2xlarge',VCpuInfo:{DefaultVCpus:8},MemoryInfo:{SizeInMiB:16384}}];
export const compute=(project:string)=>`//compute.googleapis.com/projects/${project}`;
export const asset=(type:string,name:string,data:object,location='asia-northeast3')=>({name,assetType:type,resource:{location,data}});
export const gcpSubnetName=(project:string,region:string,n:string)=>`${compute(project)}/regions/${region}/subnetworks/${n}`;
export const gce=(project:string,network:string,subnetwork:string,n:string,ip:string,machine:string,status='RUNNING',extra:object={},zone='asia-northeast3-a')=>asset('compute.googleapis.com/Instance',`${compute(project)}/zones/${zone}/instances/${n}`,{name:n,machineType:`zones/${zone}/machineTypes/${machine}`,status,labels:{environment:project.includes('sandbox')?'sandbox':'production',...(project.includes('sandbox')?{}:ownerTags(`${project} ${n}`))},networkInterfaces:[{name:'nic0',network,subnetwork,networkIP:ip}],disks:[{boot:true,diskSizeGb:'100',source:`https://www.googleapis.com/compute/v1/projects/${project}/zones/${zone}/disks/${n}`}],...extra},zone.slice(0,-2));
// The Disk asset Asset Inventory returns next to an instance; added where a fixture wants the disk joined.
export const gceDisk=(project:string,n:string,zone='asia-northeast3-a')=>asset('compute.googleapis.com/Disk',`${compute(project)}/zones/${zone}/disks/${n}`,{name:n,sizeGb:'100',type:`zones/${zone}/diskTypes/pd-balanced`,status:'READY',users:[`https://www.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${n}`]},zone.slice(0,-2));
export const publicIp=(sub:string,rg:string,name:string,address:string,location?:string)=>azRow(sub,rg,'Network/publicIPAddresses',name,{ipAddress:address,publicIPAllocationMethod:'Static'},{},location);
// Attaches an address to the NIC a vm() helper created.
export function withPublicIp(rows:Raw[],vmName:string,sub:string,rg:string,pip:string){const nic=rows.find(r=>r.name===`${vmName}-nic`)!;nic.properties.ipConfigurations[0].properties.publicIPAddress={id:azId(sub,rg,'Network/publicIPAddresses',pip)};return rows;}
export const routeTable=(sub:string,rg:string,name:string,subnets:string[],routes:[string,string,string?][],location?:string)=>azRow(sub,rg,'Network/routeTables',name,{subnets:subnets.map(id=>({id})),routes:routes.map(([addressPrefix,nextHopType,nextHopIpAddress],i)=>({name:`r${i}`,properties:{addressPrefix,nextHopType,nextHopIpAddress}}))},{},location);
export const awsRouteTable=(subnets:string[],routes:Raw[],vpc:string)=>({RouteTableId:`rtb-${vpc}-${subnets[0]??'main'}`,VpcId:vpc,Associations:subnets.map(SubnetId=>({SubnetId})),Routes:[{DestinationCidrBlock:'10.0.0.0/8',GatewayId:'local'},...routes]});
