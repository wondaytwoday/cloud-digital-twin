import {asset,awsRouteTable,ebs,gceDisk,nacl,awsSubnet,azId,azRow,compute,ec2,egress,gce,gcpSubnetName,instanceTypes,nicConfig,nsg,publicIp,routeTable,securityGroup,sgRule,standardRules,subnetId,tag,vm,vnet,vnetId,withPublicIp} from './builders.js';
import type {Scenario} from './types.js';
import {aksPlatform,pvDiskId} from './kubernetes.js';
const connectivity='00000000-0000-4000-8000-000000000001',platform='00000000-0000-4000-8000-000000000002',data='00000000-0000-4000-8000-000000000003',dev='00000000-0000-4000-8000-000000000004',partner='00000000-0000-4000-8000-000000000099';
const hub=vnetId(connectivity,'rg-network-hub','vnet-hub'),spokes={platform:vnetId(platform,'rg-platform','vnet-platform-prod'),data:vnetId(data,'rg-data','vnet-data-prod'),dev:vnetId(dev,'rg-dev','vnet-dev')};
// The API VM's identities: a system-assigned one, and a user-assigned one granted read on the log storage account's blobs.
const API_SYSTEM_ID='bbbbbbbb-0000-4000-8000-000000000001',API_PRINCIPAL='bbbbbbbb-0000-4000-8000-000000000002',API_IDENTITY=azId(platform,'rg-platform','ManagedIdentity/userAssignedIdentities','id-api-prod');
// Commerce instances: orders-worker-01 has a second ENI in the data subnet, checkout-api-01 runs with an instance profile.
const COMMERCE=[ec2('i-checkout1','checkout-api-01','m6i.xlarge','subnet-app-a','10.21.1.20','sg-app','running',{profile:'arn:aws:iam::444455556666:instance-profile/checkout-api'}),ec2('i-checkout2','checkout-api-02','m6i.xlarge','subnet-app-c','10.21.2.20','sg-app'),
  ec2('i-orders','orders-worker-01','m6i.xlarge','subnet-app-a','10.21.1.30','sg-app','running',{enis:[{subnet:'subnet-data-a',ip:'10.21.3.30',sg:'sg-db'}]}),ec2('i-batch','batch-nightly-01','c6i.2xlarge','subnet-app-c','10.21.2.40','sg-app','stopped')];
const PAYMENTS_PRINCIPAL='bbbbbbbb-0000-4000-8000-000000000003',PAYMENTS_CLIENT='cccccccc-0000-4000-8000-000000000002';
// The hub firewall's policy: dev is denied first, the platform spoke may reach the data spoke's SQL and HTTPS, both spokes may leave on 443,
// and OS updates are an application (FQDN) rule, which an address alone cannot match.
const HUB_POLICY=azId(connectivity,'rg-network-hub','Network/firewallPolicies','afwp-hub');
const net=(name:string,src:string[],dst:string[],ports:string[],protocols=['TCP'])=>({ruleType:'NetworkRule',name,ipProtocols:protocols,sourceAddresses:src,destinationAddresses:dst,destinationPorts:ports});
const HUB_RULES=[{name:'platform-rules',properties:{priority:200,ruleCollections:[
  {ruleCollectionType:'FirewallPolicyFilterRuleCollection',name:'deny-dev',priority:100,action:{type:'Deny'},rules:[net('dev-anywhere',['10.12.0.0/16'],['*'],['*'],['Any'])]},
  {ruleCollectionType:'FirewallPolicyFilterRuleCollection',name:'spoke-to-spoke',priority:200,action:{type:'Allow'},rules:[net('platform-to-data',['10.10.0.0/16'],['10.11.0.0/16'],['1433','443'])]},
  {ruleCollectionType:'FirewallPolicyFilterRuleCollection',name:'internet-https',priority:300,action:{type:'Allow'},rules:[net('spokes-https',['10.10.0.0/16','10.11.0.0/16'],['*'],['443'])]},
  {ruleCollectionType:'FirewallPolicyFilterRuleCollection',name:'os-updates',priority:400,action:{type:'Allow'},rules:[{ruleType:'ApplicationRule',name:'ubuntu',sourceAddresses:['10.10.0.0/16'],targetFqdns:['*.ubuntu.com'],protocols:[{protocolType:'Http',port:80},{protocolType:'Https',port:443}]}]},
]}}];
const hostProject='atlas-net-host',appProject='atlas-analytics-prod',sandboxProject='atlas-sandbox',R='asia-northeast3';
const sharedVpc=`${compute(hostProject)}/global/networks/vpc-shared`,sandboxVpc=`${compute(sandboxProject)}/global/networks/vpc-sandbox`,hostSubnet=(n:string)=>gcpSubnetName(hostProject,R,n);
export const standard:Scenario={
  kubernetes:[{binding:{context:'aks-platform',provider:'azure',scope:platform,cluster:azId(platform,'rg-platform','ContainerService/managedClusters','aks-platform'),region:'koreacentral',networkPolicyEngine:'azure'},items:aksPlatform(platform,PAYMENTS_CLIENT)}],
  azure:{firewallPolicies:{[HUB_POLICY]:HUB_RULES},assignments:[{scope:`${azId(platform,'rg-platform','Storage/storageAccounts','stplatformlogs')}`,principalId:PAYMENTS_PRINCIPAL,principalType:'ServicePrincipal',role:'Storage Blob Data Reader',name:'id-payments-api'},{scope:`${azId(platform,'rg-platform','Storage/storageAccounts','stplatformlogs')}`,principalId:API_PRINCIPAL,principalType:'ServicePrincipal',role:'Storage Blob Data Reader',name:'id-api-prod'}],subscriptions:{[connectivity]:'Connectivity Hub',[platform]:'Platform Prod',[data]:'Data Prod',[dev]:'Dev / Test'},tree:{id:'tenant-atlas',name:'Atlas Corp 테넌트',children:[{id:'mg-platform',name:'Platform',children:[{id:connectivity,name:'Connectivity Hub',scope:connectivity}]},{id:'mg-landingzones',name:'Landing Zones',children:[{id:platform,name:'Platform Prod',scope:platform},{id:data,name:'Data Prod',scope:data}]},{id:'mg-sandbox',name:'Sandbox',children:[{id:dev,name:'Dev / Test',scope:dev}]}]},rows:withPublicIp([
    vnet(connectivity,'rg-network-hub','vnet-hub','10.0.0.0/16',[['GatewaySubnet','10.0.0.0/27'],['AzureFirewallSubnet','10.0.1.0/26'],['shared-services','10.0.2.0/24','nsg-shared']],[[spokes.platform,{allowGatewayTransit:true}],[spokes.data,{allowGatewayTransit:true}],[spokes.dev,{allowGatewayTransit:true}],[vnetId(partner,'rg-partner','vnet-partner-erp'),{}]]),
    nsg(connectivity,'rg-network-hub','nsg-shared',[['AllowBastionSSH','Inbound','Allow','Tcp','22','10.0.0.0/8',110],...standardRules]),
    azRow(connectivity,'rg-network-hub','Network/expressRouteCircuits','er-seoul-01',{provisioningState:'Succeeded',serviceProviderProperties:{bandwidthInMbps:1000,serviceProviderName:'Demo carrier',peeringLocation:'Seoul'}}),
    azRow(connectivity,'rg-network-hub','Network/virtualNetworkGateways','vgw-hub-er',{provisioningState:'Succeeded',gatewayType:'ExpressRoute',sku:{name:'ErGw1AZ'},ipConfigurations:[{properties:{subnet:{id:subnetId(connectivity,'rg-network-hub','vnet-hub','GatewaySubnet')}}}]}),
    azRow(connectivity,'rg-network-hub','Network/connections','conn-er-hub',{connectionType:'ExpressRoute',peer:{id:azId(connectivity,'rg-network-hub','Network/expressRouteCircuits','er-seoul-01')},virtualNetworkGateway1:{id:azId(connectivity,'rg-network-hub','Network/virtualNetworkGateways','vgw-hub-er')}}),
    azRow(connectivity,'rg-network-hub','Network/firewallPolicies','afwp-hub',{provisioningState:'Succeeded',threatIntelMode:'Alert'}),
    azRow(connectivity,'rg-network-hub','Network/azureFirewalls','afw-hub',{provisioningState:'Succeeded',sku:{tier:'Premium'},threatIntelMode:'Alert',firewallPolicy:{id:HUB_POLICY},ipConfigurations:[{properties:{privateIPAddress:'10.0.1.4',subnet:{id:subnetId(connectivity,'rg-network-hub','vnet-hub','AzureFirewallSubnet')}}}]}),
    ...vm(connectivity,'rg-network-hub','vnet-hub','shared-services','bastion-01','10.0.2.10','Standard_B2s'),
    vnet(platform,'rg-platform','vnet-platform-prod','10.10.0.0/16',[['web','10.10.1.0/24','nsg-web'],['app','10.10.2.0/24','nsg-app'],['aks','10.10.8.0/21','nsg-app'],['data','10.10.3.0/24','nsg-data']],[[hub,{useRemoteGateways:true}]]),
    nsg(platform,'rg-platform','nsg-web',standardRules),nsg(platform,'rg-platform','nsg-app',[['AllowFromWeb','Inbound','Allow','Tcp','8443','10.10.1.0/24',100],...standardRules]),nsg(platform,'rg-platform','nsg-data',[['AllowFromApp','Inbound','Allow','Tcp','1433','10.10.2.0/24',100],['DenyAll','Inbound','Deny','*','*','*',4000]]),
    azRow(platform,'rg-platform','Network/loadBalancers','ilb-web',{provisioningState:'Succeeded',frontendIPConfigurations:[{properties:{privateIPAddress:'10.10.1.4',subnet:{id:subnetId(platform,'rg-platform','vnet-platform-prod','web')}}}],backendAddressPools:[{properties:{backendIPConfigurations:[nicConfig(platform,'rg-platform','web-01'),nicConfig(platform,'rg-platform','web-02')]}}]},{sku:{name:'Standard'}}),
    ...vm(platform,'rg-platform','vnet-platform-prod','web','web-01','10.10.1.10','Standard_D2s_v5','running',undefined,{secondaryIps:['10.10.1.12']}),...vm(platform,'rg-platform','vnet-platform-prod','web','web-02','10.10.1.11','Standard_D2s_v5','running',undefined,{nicNsg:'nsg-web-02'}),
    // A NIC-level NSG: web-02 refuses SSH even from its own subnet, so two VMs side by side get different answers.
    nsg(platform,'rg-platform','nsg-web-02',[['DenySshFromWebSubnet','Inbound','Deny','Tcp','22','10.10.1.0/24',100]]),
    ...vm(platform,'rg-platform','vnet-platform-prod','app','api-prod-01','10.10.2.10','Standard_D4s_v5','running',undefined,{identity:{principalId:API_SYSTEM_ID,userAssigned:[API_IDENTITY]}}),
    azRow(platform,'rg-platform','ManagedIdentity/userAssignedIdentities','id-api-prod',{principalId:API_PRINCIPAL,clientId:'cccccccc-0000-4000-8000-000000000001',tenantId:'tenant-atlas'}),
    azRow(platform,'rg-platform','Storage/storageAccounts','stplatformlogs',{provisioningState:'Succeeded',publicNetworkAccess:'Disabled',networkAcls:{defaultAction:'Deny'}},{sku:{name:'Standard_ZRS'},kind:'StorageV2'}),
    azRow(platform,'rg-platform','Network/privateEndpoints','pe-stplatformlogs-blob',{subnet:{id:subnetId(platform,'rg-platform','vnet-platform-prod','data')},customDnsConfigs:[{fqdn:'stplatformlogs.blob.core.windows.net',ipAddresses:['10.10.3.6']}],privateLinkServiceConnections:[{properties:{privateLinkServiceId:azId(platform,'rg-platform','Storage/storageAccounts','stplatformlogs'),groupIds:['blob'],privateLinkServiceConnectionState:{status:'Approved'}}}]}),...vm(platform,'rg-platform','vnet-platform-prod','app','api-prod-02','10.10.2.11','Standard_D4s_v5'),...vm(platform,'rg-platform','vnet-platform-prod','app','worker-gpu-01','10.10.2.20','Standard_NC4as_T4_v3'),
    azRow(platform,'rg-platform','ContainerService/managedClusters','aks-platform',{provisioningState:'Succeeded',powerState:{code:'Running'},kubernetesVersion:'1.33.2',networkProfile:{networkPlugin:'azure',networkPolicy:'azure'},agentPoolProfiles:[{count:6,vnetSubnetID:subnetId(platform,'rg-platform','vnet-platform-prod','aks')}]}),
    // The identity payments-api's ServiceAccount federates to, and the managed disk behind the ledger database's PV.
    azRow(platform,'rg-platform','ManagedIdentity/userAssignedIdentities','id-payments-api',{principalId:PAYMENTS_PRINCIPAL,clientId:PAYMENTS_CLIENT,tenantId:'tenant-atlas'}),
    {...azRow(platform,'MC_rg-platform_aks-platform_koreacentral','Compute/disks','pvc-7f3a2c1e',{diskSizeGB:64,diskState:'Attached'},{sku:{name:'Premium_LRS'}}),id:pvDiskId(platform)},
    azRow(platform,'rg-platform','Sql/servers','sql-platform',{state:'Ready',version:'12.0'}),
    azRow(platform,'rg-platform','Network/privateEndpoints','pe-sql-platform',{subnet:{id:subnetId(platform,'rg-platform','vnet-platform-prod','data')},customDnsConfigs:[{ipAddresses:['10.10.3.5']}],privateLinkServiceConnections:[{properties:{privateLinkServiceId:azId(platform,'rg-platform','Sql/servers','sql-platform')}}]}),
    vnet(data,'rg-data','vnet-data-prod','10.11.0.0/16',[['etl','10.11.1.0/24','nsg-data-prod'],['warehouse','10.11.2.0/24','nsg-data-prod']],[[hub,{useRemoteGateways:true}]]),
    nsg(data,'rg-data','nsg-data-prod',standardRules),
    ...vm(data,'rg-data','vnet-data-prod','etl','etl-01','10.11.1.10','Standard_D8s_v5','running',undefined,{nics:[{subnet:'warehouse',ips:['10.11.2.20']}]}),...vm(data,'rg-data','vnet-data-prod','etl','etl-02','10.11.1.11','Standard_D8s_v5'),...vm(data,'rg-data','vnet-data-prod','warehouse','warehouse-01','10.11.2.10','Standard_E4s_v5','deallocated'),
    azRow(data,'rg-data','Network/natGateways','nat-etl',{provisioningState:'Succeeded',subnets:[{id:subnetId(data,'rg-data','vnet-data-prod','etl')}]}),
    vnet(dev,'rg-dev','vnet-dev','10.12.0.0/16',[['dev','10.12.1.0/24','nsg-dev']],[[hub,{useRemoteGateways:true}]]),
    nsg(dev,'rg-dev','nsg-dev',[['AllowAnySSH','Inbound','Allow','Tcp','22','0.0.0.0/0',100]]),
    ...vm(dev,'rg-dev','vnet-dev','dev','dev-sandbox-01','10.12.1.10','Standard_B2s','deallocated'),
    publicIp(dev,'rg-dev','pip-dev-sandbox','203.0.113.20'),
    // Both spokes send the private supernet to the hub firewall too: without it the on-prem 10.0.0.0/8 advertisement would carry spoke-to-spoke traffic past the firewall.
    routeTable(platform,'rg-platform','rt-platform',['web','app','data'].map(n=>subnetId(platform,'rg-platform','vnet-platform-prod',n)),[['0.0.0.0/0','VirtualAppliance','10.0.1.4'],['10.0.0.0/8','VirtualAppliance','10.0.1.4']]),
    routeTable(data,'rg-data','rt-data',['etl','warehouse'].map(n=>subnetId(data,'rg-data','vnet-data-prod',n)),[['0.0.0.0/0','VirtualAppliance','10.0.1.4'],['10.0.0.0/8','VirtualAppliance','10.0.1.4']]),
  ],'dev-sandbox-01',dev,'rg-dev','pip-dev-sandbox')},
  aws:[
    {account:'111122223333',label:'network-core',region:'ap-northeast-2',api:{
      DescribeVpcs:{Vpcs:[{VpcId:'vpc-transit',CidrBlock:'10.20.0.0/16',Tags:tag('vpc-transit')}]},
      DescribeSubnets:{Subnets:[awsSubnet('subnet-tgw-a','tgw-attach-a','vpc-transit','10.20.0.0/28','ap-northeast-2a')]},
      DescribeTransitGateways:{TransitGateways:[{TransitGatewayId:'tgw-core',State:'available',Options:{AmazonSideAsn:64512},Tags:tag('tgw-core')}]},
      DescribeTransitGatewayVpcAttachments:{TransitGatewayVpcAttachments:[{TransitGatewayId:'tgw-core',VpcId:'vpc-transit',VpcOwnerId:'111122223333',State:'available'},{TransitGatewayId:'tgw-core',VpcId:'vpc-commerce',VpcOwnerId:'444455556666',State:'available'},{TransitGatewayId:'tgw-core',VpcId:'vpc-dev',VpcOwnerId:'777788889999',State:'available'}]},
      DescribeVpnConnections:{VpnConnections:[{VpnConnectionId:'vpn-seoul',State:'available',Type:'ipsec.1',TransitGatewayId:'tgw-core',CustomerGatewayId:'cgw-seoul',VgwTelemetry:[{Status:'UP'},{Status:'DOWN'}],Tags:tag('vpn-seoul')}]},
    }},
    {account:'444455556666',label:'commerce-prod',region:'ap-northeast-2',api:{
      DescribeVpcs:{Vpcs:[{VpcId:'vpc-commerce',CidrBlock:'10.21.0.0/16',Tags:tag('vpc-commerce')}]},
      DescribeSubnets:{Subnets:[awsSubnet('subnet-public-a','public-a','vpc-commerce','10.21.0.0/24','ap-northeast-2a',true),awsSubnet('subnet-app-a','app-a','vpc-commerce','10.21.1.0/24','ap-northeast-2a'),awsSubnet('subnet-app-c','app-c','vpc-commerce','10.21.2.0/24','ap-northeast-2c'),awsSubnet('subnet-data-a','data-a','vpc-commerce','10.21.3.0/24','ap-northeast-2a')]},
      DescribeInstances:{Reservations:[{Instances:COMMERCE.slice(0,2)},{Instances:COMMERCE.slice(2)}]},
      DescribeSecurityGroups:{SecurityGroups:[securityGroup('sg-alb','vpc-commerce',[sgRule(443,'0.0.0.0/0')]),securityGroup('sg-app','vpc-commerce',[sgRule(8443,'10.21.0.0/24'),sgRule(443,'10.0.0.0/8')]),securityGroup('sg-db','vpc-commerce',[sgRule(5432,'10.21.1.0/24')],[])]},
      DescribeInternetGateways:{InternetGateways:[{InternetGatewayId:'igw-commerce',Attachments:[{VpcId:'vpc-commerce',State:'available'}],Tags:tag('igw-commerce')}]},
      DescribeNatGateways:{NatGateways:[{NatGatewayId:'nat-commerce',SubnetId:'subnet-public-a',State:'available',ConnectivityType:'public',NatGatewayAddresses:[{PrivateIp:'10.21.0.9'}],Tags:tag('nat-commerce')}]},
      DescribeRouteTables:{RouteTables:[awsRouteTable(['subnet-public-a'],[{DestinationCidrBlock:'0.0.0.0/0',GatewayId:'igw-commerce'}],'vpc-commerce'),awsRouteTable(['subnet-app-a','subnet-app-c','subnet-data-a'],[{DestinationCidrBlock:'0.0.0.0/0',NatGatewayId:'nat-commerce'},{DestinationCidrBlock:'10.0.0.0/8',TransitGatewayId:'tgw-core'},{DestinationPrefixListId:'pl-78a54011',GatewayId:'vpce-s3'}],'vpc-commerce')]},
      DescribeInstanceTypes:{InstanceTypes:instanceTypes},
      DescribeLoadBalancers:{LoadBalancers:[{LoadBalancerArn:'arn:aws:elasticloadbalancing:ap-northeast-2:444455556666:loadbalancer/app/alb-checkout/1',LoadBalancerName:'alb-checkout',Type:'application',Scheme:'internet-facing',State:{Code:'active'},AvailabilityZones:[{SubnetId:'subnet-public-a'}],SecurityGroups:['sg-alb']}]},
      DescribeTargetGroups:{TargetGroups:[{TargetGroupArn:'arn:aws:elasticloadbalancing:ap-northeast-2:444455556666:targetgroup/tg-checkout/1',TargetType:'instance'}]},
      DescribeTargetHealth:{TargetHealthDescriptions:[{Target:{Id:'i-checkout1'}},{Target:{Id:'i-checkout2'}}]},
      DescribeVolumes:{Volumes:ebs(COMMERCE)},
      // The data subnet's ACL admits app-a only; app-c is refused even though sg-db would let it in.
      DescribeNetworkAcls:{NetworkAcls:[nacl('acl-default','vpc-commerce',['subnet-public-a','subnet-app-a','subnet-app-c'],[[100,false,'allow','-1','0.0.0.0/0'],[100,true,'allow','-1','0.0.0.0/0']],true),
        nacl('acl-data','vpc-commerce',['subnet-data-a'],[[90,false,'deny','-1','10.21.2.0/24'],[100,false,'allow','6','10.21.0.0/16',[5432,5432]],[110,false,'allow','6','10.21.0.0/16',[1024,65535]],[100,true,'allow','6','10.21.0.0/16',[1024,65535]],[110,true,'allow','6','0.0.0.0/0',[443,443]]])]},
      DescribeVpcEndpoints:{VpcEndpoints:[{VpcEndpointId:'vpce-s3',VpcEndpointType:'Gateway',VpcId:'vpc-commerce',ServiceName:'com.amazonaws.ap-northeast-2.s3',State:'available',RouteTableIds:['rtb-vpc-commerce-subnet-app-a'],Tags:tag('vpce-s3')}]},
      DescribeDBInstances:{DBInstances:[{DBInstanceIdentifier:'rds-orders',Engine:'postgres',DBInstanceClass:'db.r6g.large',DBInstanceStatus:'available',MultiAZ:true,DBSubnetGroup:{Subnets:[{SubnetIdentifier:'subnet-data-a'}]},VpcSecurityGroups:[{VpcSecurityGroupId:'sg-db'}]}]},
    }},
    {account:'777788889999',label:'commerce-dev',region:'ap-northeast-2',api:{
      DescribeVpcs:{Vpcs:[{VpcId:'vpc-dev',CidrBlock:'10.22.0.0/16',Tags:tag('vpc-dev')}]},
      DescribeSubnets:{Subnets:[awsSubnet('subnet-dev-a','dev-app-a','vpc-dev','10.22.1.0/24','ap-northeast-2a')]},
      DescribeInstances:{Reservations:[{Instances:[ec2('i-devapp','dev-app-01','t3.medium','subnet-dev-a','10.22.1.10','sg-dev','stopped')]}]},
      DescribeSecurityGroups:{SecurityGroups:[securityGroup('sg-dev','vpc-dev',[sgRule(22,'10.0.0.0/8')],egress)]},
      DescribeInstanceTypes:{InstanceTypes:instanceTypes},
    }},
  ],
  awsOrg:{id:'o-atlas',name:'Atlas Org',children:[{id:'ou-infra',name:'Infrastructure',children:[{id:'111122223333',name:'network-core',scope:'111122223333'}]},{id:'ou-workloads',name:'Workloads',children:[{id:'444455556666',name:'commerce-prod',scope:'444455556666'},{id:'777788889999',name:'commerce-dev',scope:'777788889999'}]}]},
  gcp:{parent:'organizations/000000000000',tree:{id:'000000000000',name:'atlas.example',children:[{id:'100',name:'Shared Infra',children:[{id:hostProject,name:'atlas-net-host',scope:hostProject}]},{id:'200',name:'Production',children:[{id:appProject,name:'atlas-analytics-prod',scope:appProject}]},{id:'300',name:'Sandbox',children:[{id:sandboxProject,name:'atlas-sandbox',scope:sandboxProject}]}]},assets:[
    asset('compute.googleapis.com/Network',sharedVpc,{name:'vpc-shared',routingConfig:{routingMode:'GLOBAL'},peerings:[{name:'to-sandbox',network:sandboxVpc,state:'ACTIVE',exportCustomRoutes:true}]},'global'),
    ...(['gke-seoul','apps-seoul','data-seoul'] as const).map((n,i)=>asset('compute.googleapis.com/Subnetwork',hostSubnet(n),{name:n,network:sharedVpc,ipCidrRange:`10.30.${i+1}.0/24`})),
    asset('compute.googleapis.com/Route',`${compute(hostProject)}/global/routes/default-internet`,{network:sharedVpc,destRange:'0.0.0.0/0',nextHopGateway:`${compute(hostProject)}/global/gateways/default-internet-gateway`},'global'),
    asset('compute.googleapis.com/Router',`${compute(hostProject)}/regions/${R}/routers/router-seoul`,{name:'router-seoul',network:sharedVpc,bgp:{asn:64514}}),
    asset('compute.googleapis.com/InterconnectAttachment',`${compute(hostProject)}/regions/${R}/interconnectAttachments/ic-seoul-1`,{name:'ic-seoul-1',state:'ACTIVE',type:'PARTNER',bandwidth:'BPS_500M',router:`${compute(hostProject)}/regions/${R}/routers/router-seoul`}),
    asset('compute.googleapis.com/Firewall',`${compute(hostProject)}/global/firewalls/fw-allow-internal`,{name:'fw-allow-internal',network:sharedVpc,direction:'INGRESS',priority:1000,allowed:[{IPProtocol:'tcp',ports:['443','5432']}],sourceRanges:['10.0.0.0/8'],targetTags:['analytics']}),
    asset('compute.googleapis.com/Firewall',`${compute(hostProject)}/global/firewalls/fw-iap-ssh`,{name:'fw-iap-ssh',network:sharedVpc,direction:'INGRESS',priority:900,allowed:[{IPProtocol:'tcp',ports:['22']}],sourceRanges:['35.235.240.0/20']}),
    asset('compute.googleapis.com/ForwardingRule',`${compute(appProject)}/regions/${R}/forwardingRules/ilb-analytics`,{name:'ilb-analytics',IPAddress:'10.30.2.5',loadBalancingScheme:'INTERNAL',ports:['443'],subnetwork:hostSubnet('apps-seoul')}),
    // Only analytics-api-01 carries the 'analytics' tag that fw-allow-internal targets, so its twin next to it is not admitted.
    gce(appProject,sharedVpc,hostSubnet('apps-seoul'),'analytics-api-01','10.30.2.30','e2-standard-4','RUNNING',{tags:{items:['analytics']},serviceAccounts:[{email:`analytics-api@${appProject}.iam.gserviceaccount.com`,scopes:['https://www.googleapis.com/auth/cloud-platform']}]}),gceDisk(appProject,'analytics-api-01'),
    gce(appProject,sharedVpc,hostSubnet('apps-seoul'),'analytics-api-02','10.30.2.31','e2-standard-4'),
    gce(appProject,sharedVpc,hostSubnet('data-seoul'),'inference-gpu-01','10.30.3.30','n1-standard-4','RUNNING',{guestAccelerators:[{acceleratorCount:1,acceleratorType:'zones/asia-northeast3-a/acceleratorTypes/nvidia-tesla-t4'}]}),
    asset('container.googleapis.com/Cluster',`//container.googleapis.com/projects/${appProject}/locations/${R}/clusters/gke-analytics`,{name:'gke-analytics',status:'RUNNING',currentMasterVersion:'1.33.1-gke.100',currentNodeCount:9,networkConfig:{subnetwork:`projects/${hostProject}/regions/${R}/subnetworks/gke-seoul`}}),
    asset('sqladmin.googleapis.com/Instance',`//sqladmin.googleapis.com/projects/${appProject}/instances/sql-analytics`,{name:'sql-analytics',state:'RUNNABLE',databaseVersion:'POSTGRES_16',ipAddresses:[{ipAddress:'10.30.9.3'}],settings:{tier:'db-custom-4-16384',ipConfiguration:{privateNetwork:`/projects/${hostProject}/global/networks/vpc-shared`}}}),
    asset('compute.googleapis.com/Network',sandboxVpc,{name:'vpc-sandbox',routingConfig:{routingMode:'REGIONAL'},peerings:[{name:'to-shared',network:sharedVpc,state:'ACTIVE',importCustomRoutes:true}]},'global'),
    asset('compute.googleapis.com/Subnetwork',gcpSubnetName(sandboxProject,R,'sandbox'),{name:'sandbox',network:sandboxVpc,ipCidrRange:'10.22.1.0/24'}),
    gce(sandboxProject,sandboxVpc,gcpSubnetName(sandboxProject,R,'sandbox'),'sandbox-01','10.22.1.10','e2-medium','TERMINATED'),
  ]},
  onprem:[{id:'seoul-dc',name:'Seoul datacenter',region:'Seoul',cidr:'10.0.0.0/8',connects:[{name:'er-seoul-01',label:'ExpressRoute · 1 Gbps'},{name:'vpn-seoul',label:'IPsec VPN'},{name:'ic-seoul-1',label:'Partner Interconnect · 500 Mbps'}]}],
  flows:[{hops:['Seoul datacenter','er-seoul-01','vgw-hub-er','afw-hub','ilb-web','web-01','api-prod-01','sql-platform'],rate:'128 Mbps'},{hops:['Seoul datacenter','vpn-seoul','tgw-core','vpc-commerce','alb-checkout','checkout-api-01','rds-orders'],rate:'64 Mbps'},{hops:['Seoul datacenter','ic-seoul-1','router-seoul','ilb-analytics','analytics-api-01','sql-analytics'],rate:'96 Mbps'}],
};
