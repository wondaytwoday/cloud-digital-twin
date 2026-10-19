// Synthetic, documented API-shaped fixtures. Never customer data.
const az='/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg-production/providers/';
const azId=(type:string,n:string)=>`${az}Microsoft.${type}/${n}`;
const net=azId('Network/virtualNetworks','vnet-platform'),nsg=azId('Network/networkSecurityGroups','nsg-workloads');
const azRow=(type:string,name:string,properties:object)=>({id:azId(type.replace('Microsoft.',''),name),type,name,location:'koreacentral',subscriptionId:'00000000-0000-4000-8000-000000000001',tags:{environment:'production',team:'platform'},properties});
export const azureFixture=[
  azRow('Microsoft.Network/virtualNetworks','vnet-platform',{addressSpace:{addressPrefixes:['10.10.0.0/16']},subnets:['application','data'].map((name,i)=>({id:`${net}/subnets/${name}`,name,properties:{addressPrefix:`10.10.${i+1}.0/24`}}))}),
  azRow('Microsoft.Network/networkSecurityGroups','nsg-workloads',{securityRules:[{name:'AllowCorporateHTTPS',properties:{direction:'Inbound',access:'Allow',protocol:'Tcp',destinationPortRange:'443',sourceAddressPrefix:'10.0.0.0/8',destinationAddressPrefix:'*',priority:100}},{name:'DenyInternet',properties:{direction:'Inbound',access:'Deny',protocol:'*',destinationPortRange:'*',sourceAddressPrefix:'Internet',destinationAddressPrefix:'*',priority:200}}]}),
  ...['api-prod-01','worker-gpu-01'].flatMap((name,i)=>[azRow('Microsoft.Compute/virtualMachines',name,{provisioningState:'Succeeded',hardwareProfile:{vmSize:i?'Standard_NC4as_T4_v3':'Standard_D4s_v5'},storageProfile:{osDisk:{osType:'Linux'}},networkProfile:{networkInterfaces:[{id:azId('Network/networkInterfaces',`${name}-nic`)}]}}),azRow('Microsoft.Network/networkInterfaces',`${name}-nic`,{networkSecurityGroup:{id:nsg},ipConfigurations:[{properties:{privateIPAddress:`10.10.${i+1}.10`,subnet:{id:`${net}/subnets/${i?'data':'application'}`}}}]})]),
  azRow('Microsoft.Network/virtualNetworkGateways','gateway-hub',{gatewayType:'ExpressRoute',ipConfigurations:[{properties:{subnet:{id:`net-placeholder`}}}]}),
  azRow('Microsoft.Network/expressRouteCircuits','expressroute-seoul',{provisioningState:'Succeeded',serviceProviderProperties:{bandwidthInMbps:1000,serviceProviderName:'Demo carrier'}}),
  azRow('Microsoft.Network/connections','er-hub-link',{connectionType:'ExpressRoute',peer:{id:azId('Network/expressRouteCircuits','expressroute-seoul')},virtualNetworkGateway1:{id:azId('Network/virtualNetworkGateways','gateway-hub')}}),
];
// GatewaySubnet reference is part of the network schema; no fictitious inline firewall.
(azureFixture.find(r=>r.name==='gateway-hub')!.properties as any).ipConfigurations[0].properties.subnet.id=`${net}/subnets/GatewaySubnet`;
export const awsFixture={
  Vpcs:[{VpcId:'vpc-demo',CidrBlock:'10.20.0.0/16',Tags:[{Key:'Name',Value:'vpc-commerce'}]}],
  Subnets:['application','data'].map((n,i)=>({SubnetId:`subnet-${n}`,VpcId:'vpc-demo',CidrBlock:`10.20.${i+1}.0/24`,AvailabilityZone:'ap-northeast-2a',Tags:[{Key:'Name',Value:n}]})),
  Reservations:[{Instances:['checkout-api-01','orders-worker-01'].map((n,i)=>({InstanceId:`i-demo${i}`,InstanceType:'m6i.xlarge',SubnetId:`subnet-${i?'data':'application'}`,PrivateIpAddress:`10.20.${i+1}.20`,State:{Name:'running'},SecurityGroups:[{GroupId:'sg-demo'}],Tags:[{Key:'Name',Value:n},{Key:'environment',Value:'production'}]}))}],
  SecurityGroups:[{GroupId:'sg-demo',GroupName:'sg-commerce',VpcId:'vpc-demo',Tags:[{Key:'Name',Value:'sg-commerce'}],IpPermissions:[{IpProtocol:'tcp',FromPort:443,ToPort:443,IpRanges:[{CidrIp:'10.0.0.0/8'}]}],IpPermissionsEgress:[{IpProtocol:'-1',IpRanges:[{CidrIp:'0.0.0.0/0'}]}]}],
  InstanceTypes:[{InstanceType:'m6i.xlarge',VCpuInfo:{DefaultVCpus:4},MemoryInfo:{SizeInMiB:16384}}],
  VpnGateways:[{VpnGatewayId:'vgw-demo',State:'available',Tags:[{Key:'Name',Value:'vpn-gateway-seoul'}],VpcAttachments:[{VpcId:'vpc-demo',State:'attached'}]}],
};
const project='atlas-analytics-demo',groot=`//compute.googleapis.com/projects/${project}`,gnet=`${groot}/global/networks/vpc-analytics`;
const asset=(type:string,path:string,data:object,location='asia-northeast3')=>({name:`${groot}/${path}`,assetType:`compute.googleapis.com/${type}`,resource:{location,data}});
export const gcpFixture=[
  asset('Network','global/networks/vpc-analytics',{name:'vpc-analytics',routingConfig:{routingMode:'GLOBAL'}},'global'),
  ...['application','data'].map((n,i)=>asset('Subnetwork',`regions/asia-northeast3/subnetworks/${n}`,{name:n,network:gnet,ipCidrRange:`10.30.${i+1}.0/24`})),
  ...['analytics-api-01','inference-gpu-01'].map((n,i)=>asset('Instance',`zones/asia-northeast3-a/instances/${n}`,{name:n,machineType:`zones/asia-northeast3-a/machineTypes/${i?'n1-standard-4':'e2-standard-4'}`,status:'RUNNING',labels:{environment:'production',team:'data'},networkInterfaces:[{network:gnet,subnetwork:`${groot}/regions/asia-northeast3/subnetworks/${i?'data':'application'}`,networkIP:`10.30.${i+1}.30`}],...(i?{guestAccelerators:[{acceleratorCount:1,acceleratorType:'zones/asia-northeast3-a/acceleratorTypes/nvidia-tesla-t4'}]}:{})})),
  asset('Firewall','global/firewalls/allow-internal',{name:'fw-analytics',network:gnet,direction:'INGRESS',priority:1000,allowed:[{IPProtocol:'tcp',ports:['443','5432']}],sourceRanges:['10.0.0.0/8'],targetTags:['analytics']}),
  asset('Router','regions/asia-northeast3/routers/router-seoul',{name:'router-seoul',network:gnet,bgp:{asn:64514}}),
];
