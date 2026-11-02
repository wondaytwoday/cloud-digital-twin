import {asset,awsSubnet,azRow,compute,ec2,gcpSubnetName,instanceTypes,nicConfig,nsg,privateService,securityGroup,sgRule,standardRules,subnetId,tag,vm,vnet} from './builders.js';
import type {Scenario} from './types.js';
const REGION='ap-northeast-2';
export const singleVm:Scenario={aws:[{account:'123456789012',label:'my-account',region:REGION,api:{
  DescribeVpcs:{Vpcs:[{VpcId:'vpc-main',CidrBlock:'10.0.0.0/16',Tags:tag('vpc-main')}]},
  DescribeSubnets:{Subnets:[awsSubnet('subnet-public','public-a','vpc-main','10.0.1.0/24','ap-northeast-2a',true)]},
  DescribeInternetGateways:{InternetGateways:[{InternetGatewayId:'igw-main',Attachments:[{VpcId:'vpc-main',State:'available'}],Tags:tag('igw-main')}]},
  DescribeInstances:{Reservations:[{Instances:[ec2('i-web','web-server','t3.medium','subnet-public','10.0.1.10','sg-web')]}]},
  DescribeSecurityGroups:{SecurityGroups:[securityGroup('sg-web','vpc-main',[sgRule(443,'0.0.0.0/0')])]},
  DescribeInstanceTypes:{InstanceTypes:instanceTypes},
}}]};
const sub='00000000-0000-4000-8000-0000000000a1',rg='rg-shop',net='vnet-shop';
export const webTier:Scenario={azure:{subscriptions:{[sub]:'Shop Prod'},tree:{id:'tenant-shop',name:'Shop 테넌트',children:[{id:sub,name:'Shop Prod',scope:sub}]},rows:[
  vnet(sub,rg,net,'10.1.0.0/16',[['web','10.1.1.0/24','nsg-web'],['data','10.1.2.0/24','nsg-data']]),
  nsg(sub,rg,'nsg-web',standardRules),nsg(sub,rg,'nsg-data',[['AllowFromWeb','Inbound','Allow','Tcp','1433','10.1.1.0/24',100],['DenyAll','Inbound','Deny','*','*','*',4000]]),
  azRow(sub,rg,'Network/loadBalancers','lb-shop',{provisioningState:'Succeeded',frontendIPConfigurations:[{properties:{privateIPAddress:'10.1.1.4',subnet:{id:subnetId(sub,rg,net,'web')}}}],backendAddressPools:[{properties:{backendIPConfigurations:[nicConfig(sub,rg,'shop-web-01'),nicConfig(sub,rg,'shop-web-02')]}}]},{sku:{name:'Standard'}}),
  ...vm(sub,rg,net,'web','shop-web-01','10.1.1.10','Standard_D2s_v5'),...vm(sub,rg,net,'web','shop-web-02','10.1.1.11','Standard_D2s_v5'),
  ...privateService(sub,rg,'Sql/servers','sql-shop',{state:'Ready',version:'12.0'},subnetId(sub,rg,net,'data'),'10.1.2.5'),
]},flows:[{hops:['lb-shop','shop-web-01','sql-shop'],rate:'8 Mbps'}]};
const project='my-app-prod',region='asia-northeast3',gvpc=`${compute(project)}/global/networks/vpc-app`;
export const gkeApp:Scenario={gcp:{parent:`projects/${project}`,assets:[
  asset('compute.googleapis.com/Network',gvpc,{name:'vpc-app',routingConfig:{routingMode:'REGIONAL'}},'global'),
  asset('compute.googleapis.com/Subnetwork',gcpSubnetName(project,region,'gke-nodes'),{name:'gke-nodes',network:gvpc,ipCidrRange:'10.2.0.0/20'}),
  asset('compute.googleapis.com/Firewall',`${compute(project)}/global/firewalls/fw-allow-lb`,{name:'fw-allow-lb',network:gvpc,direction:'INGRESS',priority:1000,allowed:[{IPProtocol:'tcp',ports:['443']}],sourceRanges:['130.211.0.0/22','35.191.0.0/16']}),
  asset('container.googleapis.com/Cluster',`//container.googleapis.com/projects/${project}/locations/${region}/clusters/gke-app`,{name:'gke-app',status:'RUNNING',currentMasterVersion:'1.33.1-gke.100',currentNodeCount:3,networkConfig:{subnetwork:`projects/${project}/regions/${region}/subnetworks/gke-nodes`}}),
  asset('sqladmin.googleapis.com/Instance',`//sqladmin.googleapis.com/projects/${project}/instances/sql-app`,{name:'sql-app',state:'RUNNABLE',databaseVersion:'POSTGRES_16',ipAddresses:[{ipAddress:'10.2.32.3'}],settings:{tier:'db-custom-2-8192',ipConfiguration:{privateNetwork:`/projects/${project}/global/networks/vpc-app`}}}),
]}};
export const hybridVpn:Scenario={aws:[{account:'123456789012',label:'corp-account',region:REGION,api:{
  DescribeVpcs:{Vpcs:[{VpcId:'vpc-corp',CidrBlock:'10.5.0.0/16',Tags:tag('vpc-corp')}]},
  DescribeSubnets:{Subnets:[awsSubnet('subnet-apps','apps-a','vpc-corp','10.5.1.0/24','ap-northeast-2a')]},
  DescribeVpnGateways:{VpnGateways:[{VpnGatewayId:'vgw-corp',State:'available',Tags:tag('vgw-corp'),VpcAttachments:[{VpcId:'vpc-corp',State:'attached'}]}]},
  DescribeVpnConnections:{VpnConnections:[{VpnConnectionId:'vpn-office',State:'available',Type:'ipsec.1',VpnGatewayId:'vgw-corp',CustomerGatewayId:'cgw-office',VgwTelemetry:[{Status:'UP'},{Status:'UP'}],Tags:tag('vpn-office')}]},
  DescribeInstances:{Reservations:[{Instances:[ec2('i-erp','erp-app-01','m6i.xlarge','subnet-apps','10.5.1.10','sg-erp')]}]},
  DescribeSecurityGroups:{SecurityGroups:[securityGroup('sg-erp','vpc-corp',[sgRule(443,'192.168.0.0/16')])]},
  DescribeInstanceTypes:{InstanceTypes:instanceTypes},
}}],onprem:[{id:'office',name:'본사 사무실',region:'Seoul',cidr:'192.168.0.0/16',connects:[{name:'vpn-office',label:'IPsec VPN'}]}],flows:[{hops:['본사 사무실','vpn-office','vgw-corp','vpc-corp','erp-app-01'],rate:'12 Mbps'}]};
