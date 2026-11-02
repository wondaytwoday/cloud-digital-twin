import {asset,awsSubnet,azId,azRow,compute,ec2,gce,gcpSubnetName,instanceTypes,nicConfig,nsg,privateService,securityGroup,sgRule,standardRules,subnetId,tag,vm,vnet,vnetId} from './builders.js';
import type {AwsAccount,OrgTree,Raw,Scenario,Site} from './types.js';
// Generated, but deterministic: the same fixture on every request, so tests and screenshots stay comparable.
const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,pad=(n:number)=>String(n).padStart(2,'0');
const KR='koreacentral',JP='japaneast';
const azureHubs={[KR]:{sub:uuid(101),rg:'rg-hub-kr',name:'vnet-hub-kr',cidr:'10.100',label:'Connectivity KR',circuits:['er-seoul-01','er-busan-02'],vgw:'vgw-hub-kr'},[JP]:{sub:uuid(102),rg:'rg-hub-jp',name:'vnet-hub-jp',cidr:'10.101',label:'Connectivity JP',circuits:['er-tokyo-01'],vgw:'vgw-hub-jp'}} as const;
type AzureSpoke=[string,string,typeof KR|typeof JP,number,{aks?:boolean;redis?:boolean;cosmos?:boolean;storage?:boolean;dev?:boolean}];
const azureSpokes:AzureSpoke[]=[
  ['commerce','Commerce Prod',KR,6,{aks:true,redis:true}],['payments','Payments Prod',KR,4,{redis:true}],['identity','Identity Prod',KR,3,{cosmos:true}],['search','Search Prod',KR,5,{aks:true,storage:true}],
  ['data-platform','Data Platform',KR,6,{storage:true,cosmos:true}],['ml-platform','ML Platform',KR,4,{aks:true,storage:true}],['erp','ERP Prod',KR,4,{}],['dev-kr','Dev KR',KR,3,{dev:true}],
  ['commerce-jp','Commerce JP',JP,4,{aks:true,redis:true}],['payments-jp','Payments JP',JP,3,{redis:true}],['data-jp','Data JP',JP,3,{storage:true}],['erp-dr','ERP DR',JP,2,{}],['dev-jp','Dev JP',JP,2,{dev:true}],
];
function azureFixture(){
  const subscriptions:Record<string,string>={},rows:Raw[]=[];
  for(const [location,h] of Object.entries(azureHubs)){
    subscriptions[h.sub]=h.label;
    const spokesHere=azureSpokes.map((s,i)=>({s,i})).filter(({s})=>s[2]===location);
    const other=location===KR?azureHubs[JP]:azureHubs[KR];
    rows.push(vnet(h.sub,h.rg,h.name,`${h.cidr}.0.0/16`,[['GatewaySubnet',`${h.cidr}.0.0/27`],['AzureFirewallSubnet',`${h.cidr}.1.0/26`],['AzureBastionSubnet',`${h.cidr}.2.0/26`],['shared-services',`${h.cidr}.3.0/24`,`nsg-shared-${location}`]],[
      ...spokesHere.map(({s,i})=>[vnetId(uuid(200+i),`rg-${s[0]}`,`vnet-${s[0]}`),{allowGatewayTransit:true}] as [string,Raw]),
      [vnetId(other.sub,other.rg,other.name),{}],
      ...(location===KR?[[vnetId(uuid(999),'rg-partner','vnet-partner-settlement'),{}] as [string,Raw]]:[]),
    ],location));
    rows.push(nsg(h.sub,h.rg,`nsg-shared-${location}`,standardRules,location));
    rows.push(azRow(h.sub,h.rg,'Network/virtualNetworkGateways',h.vgw,{provisioningState:'Succeeded',gatewayType:'ExpressRoute',sku:{name:'ErGw3AZ'},ipConfigurations:[{properties:{subnet:{id:subnetId(h.sub,h.rg,h.name,'GatewaySubnet')}}}]},{},location));
    for(const circuit of h.circuits){
      rows.push(azRow(h.sub,h.rg,'Network/expressRouteCircuits',circuit,{provisioningState:'Succeeded',serviceProviderProperties:{bandwidthInMbps:circuit.includes('busan')?2000:10000,serviceProviderName:'Demo carrier',peeringLocation:circuit.split('-')[1]}},{},location));
      rows.push(azRow(h.sub,h.rg,'Network/connections',`conn-${circuit}`,{connectionType:'ExpressRoute',peer:{id:azId(h.sub,h.rg,'Network/expressRouteCircuits',circuit)},virtualNetworkGateway1:{id:azId(h.sub,h.rg,'Network/virtualNetworkGateways',h.vgw)}},{},location));
    }
    rows.push(azRow(h.sub,h.rg,'Network/azureFirewalls',`afw-hub-${location==='koreacentral'?'kr':'jp'}`,{provisioningState:'Succeeded',sku:{tier:'Premium'},ipConfigurations:[{properties:{privateIPAddress:`${h.cidr}.1.4`,subnet:{id:subnetId(h.sub,h.rg,h.name,'AzureFirewallSubnet')}}}]},{},location));
    rows.push(azRow(h.sub,h.rg,'Network/bastionHosts',`bastion-${location==='koreacentral'?'kr':'jp'}`,{provisioningState:'Succeeded',ipConfigurations:[{properties:{subnet:{id:subnetId(h.sub,h.rg,h.name,'AzureBastionSubnet')}}}]},{},location));
    for(const n of [1,2])rows.push(...vm(h.sub,h.rg,h.name,'shared-services',`dns-${location==='koreacentral'?'kr':'jp'}-${pad(n)}`,`${h.cidr}.3.${10+n}`,'Standard_D2s_v5','running',location));
  }
  azureSpokes.forEach(([slug,label,location,size,opt],i)=>{
    const sub=uuid(200+i),rg=`rg-${slug}`,net=`vnet-${slug}`,cidr=`10.${110+i}`,h=azureHubs[location];subscriptions[sub]=label;
    const subnets:[string,string,string?][]=[['web',`${cidr}.1.0/24`,`nsg-${slug}-web`],['app',`${cidr}.2.0/24`,`nsg-${slug}-app`],['data',`${cidr}.3.0/24`,`nsg-${slug}-data`]];
    if(opt.aks)subnets.push(['aks',`${cidr}.16.0/20`,`nsg-${slug}-app`]);
    rows.push(vnet(sub,rg,net,`${cidr}.0.0/16`,subnets,[[vnetId(h.sub,h.rg,h.name),{useRemoteGateways:true}]],location));
    rows.push(nsg(sub,rg,`nsg-${slug}-web`,opt.dev?[['AllowAnySSH','Inbound','Allow','Tcp','22','0.0.0.0/0',100]]:standardRules,location),nsg(sub,rg,`nsg-${slug}-app`,[['AllowFromWeb','Inbound','Allow','Tcp','8443',`${cidr}.1.0/24`,100],...standardRules],location),nsg(sub,rg,`nsg-${slug}-data`,[['AllowFromApp','Inbound','Allow','Tcp','1433',`${cidr}.2.0/24`,100],['DenyAll','Inbound','Deny','*','*','*',4000]],location));
    const webVms=Array.from({length:Math.max(2,size-2)},(_,n)=>`${slug}-web-${pad(n+1)}`),appVms=Array.from({length:size},(_,n)=>`${slug}-app-${pad(n+1)}`);
    rows.push(azRow(sub,rg,'Network/applicationGateways',`agw-${slug}`,{operationalState:'Running',sku:{tier:'WAF_v2'},gatewayIPConfigurations:[{properties:{subnet:{id:subnetId(sub,rg,net,'web')}}}],frontendIPConfigurations:[{properties:{privateIPAddress:`${cidr}.1.4`}}],backendAddressPools:[{properties:{backendIPConfigurations:webVms.map(v=>nicConfig(sub,rg,v))}}]},{},location));
    webVms.forEach((v,n)=>rows.push(...vm(sub,rg,net,'web',v,`${cidr}.1.${10+n}`,'Standard_D2s_v5','running',location)));
    appVms.forEach((v,n)=>rows.push(...vm(sub,rg,net,'app',v,`${cidr}.2.${10+n}`,n%5===4?'Standard_E4s_v5':'Standard_D4s_v5',opt.dev&&n>0?'deallocated':(i===2&&n===1?'failed':'running'),location)));
    if(opt.aks)rows.push(azRow(sub,rg,'ContainerService/managedClusters',`aks-${slug}`,{provisioningState:'Succeeded',powerState:{code:'Running'},kubernetesVersion:'1.33.2',agentPoolProfiles:[{count:6+i,vnetSubnetID:subnetId(sub,rg,net,'aks')}]},{},location));
    const dataSubnet=subnetId(sub,rg,net,'data');
    rows.push(...privateService(sub,rg,'Sql/servers',`sql-${slug}`,{state:'Ready',version:'12.0'},dataSubnet,`${cidr}.3.5`,location));
    if(opt.redis)rows.push(...privateService(sub,rg,'Cache/redis',`redis-${slug}`,{provisioningState:'Succeeded'},dataSubnet,`${cidr}.3.6`,location));
    if(opt.cosmos)rows.push(...privateService(sub,rg,'DocumentDB/databaseAccounts',`cosmos-${slug}`,{provisioningState:'Succeeded'},dataSubnet,`${cidr}.3.7`,location));
    if(opt.storage)rows.push(...privateService(sub,rg,'Storage/storageAccounts',`st${slug.replace('-','')}`,{provisioningState:'Succeeded'},dataSubnet,`${cidr}.3.8`,location));
  });
  // A governed subscription with nothing collected yet: the tree still shows it, with zero resources.
  const legacy=uuid(900);
  const leaf=(slug:string):OrgTree=>{const i=azureSpokes.findIndex(s=>s[0]===slug),sub=uuid(200+i);return{id:sub,name:azureSpokes[i][1],scope:sub};};
  const tree:OrgTree={id:'tenant-atlas',name:'Atlas Global 테넌트',children:[
    {id:'mg-platform',name:'Platform',children:[{id:'mg-connectivity',name:'Connectivity',children:Object.values(azureHubs).map(h=>({id:h.sub,name:h.label,scope:h.sub}))}]},
    {id:'mg-landingzones',name:'Landing Zones',children:[
      {id:'mg-corp-kr',name:'Corp KR',children:['commerce','payments','identity','search','erp'].map(leaf)},
      {id:'mg-corp-jp',name:'Corp JP',children:['commerce-jp','payments-jp','data-jp','erp-dr'].map(leaf)},
      {id:'mg-data',name:'Data & AI',children:['data-platform','ml-platform'].map(leaf)},
    ]},
    {id:'mg-sandbox',name:'Sandbox',children:[...['dev-kr','dev-jp'].map(leaf),{id:legacy,name:'Legacy App (미수집)',scope:legacy}]},
  ]};
  return{subscriptions,rows,tree};
}
const NETWORK='100000000001',APNE2='ap-northeast-2',APNE1='ap-northeast-1';
type AwsWorkload=[string,typeof APNE2|typeof APNE1,number,{eks?:boolean;aurora?:boolean;stopped?:number;nlb?:boolean}];
const awsWorkloads:AwsWorkload[]=[
  ['checkout-prod',APNE2,8,{eks:true,aurora:true}],['orders-prod',APNE2,6,{aurora:true}],['catalog-prod',APNE2,5,{eks:true}],['logistics-prod',APNE2,4,{nlb:true}],['analytics-prod',APNE2,6,{eks:true}],['batch-prod',APNE2,4,{stopped:2}],['stage',APNE2,3,{stopped:1}],
  ['checkout-jp',APNE1,5,{eks:true,aurora:true}],['orders-jp',APNE1,4,{}],['stage-jp',APNE1,2,{stopped:2}],
];
const awsAccountId=(i:number)=>String(200000000000+i);
function networkAccount(region:string,tgw:string,cidr:string,extra:Record<string,any>):AwsAccount{
  const attachments=awsWorkloads.map((w,i)=>({w,i})).filter(({w})=>w[1]===region).map(({w,i})=>({TransitGatewayId:tgw,VpcId:`vpc-${w[0]}`,VpcOwnerId:awsAccountId(i),State:'available'}));
  return{account:NETWORK,label:'network-core',region,api:{
    DescribeVpcs:{Vpcs:[{VpcId:`vpc-inspect-${region}`,CidrBlock:`${cidr}.0.0/16`,Tags:tag(`vpc-inspection-${region.endsWith('2')?'kr':'jp'}`)}]},
    DescribeSubnets:{Subnets:[awsSubnet(`subnet-inspect-${region}`,'tgw-attach-a',`vpc-inspect-${region}`,`${cidr}.0.0/28`,`${region}a`)]},
    DescribeTransitGateways:{TransitGateways:[{TransitGatewayId:tgw,State:'available',Options:{AmazonSideAsn:64512},Tags:tag(tgw)}]},
    DescribeTransitGatewayVpcAttachments:{TransitGatewayVpcAttachments:[{TransitGatewayId:tgw,VpcId:`vpc-inspect-${region}`,VpcOwnerId:NETWORK,State:'available'},...attachments]},
    ...extra,
  }};
}
function awsFixture():AwsAccount[]{
  const accounts:AwsAccount[]=[
    networkAccount(APNE2,'tgw-core-kr','10.200',{
      DescribeTransitGatewayPeeringAttachments:{TransitGatewayPeeringAttachments:[{State:'available',RequesterTgwInfo:{TransitGatewayId:'tgw-core-kr',OwnerId:NETWORK,Region:APNE2},AccepterTgwInfo:{TransitGatewayId:'tgw-core-jp',OwnerId:NETWORK,Region:APNE1}}]},
      DescribeVpnConnections:{VpnConnections:[{VpnConnectionId:'vpn-busan-backup',State:'available',Type:'ipsec.1',TransitGatewayId:'tgw-core-kr',CustomerGatewayId:'cgw-busan',VgwTelemetry:[{Status:'UP'},{Status:'DOWN'}],Tags:tag('vpn-busan-backup')},{VpnConnectionId:'vpn-branch-wan',State:'available',Type:'ipsec.1',TransitGatewayId:'tgw-core-kr',CustomerGatewayId:'cgw-branch',VgwTelemetry:[{Status:'UP'},{Status:'UP'}],Tags:tag('vpn-branch-wan')}]},
      DescribeDirectConnectGateways:{directConnectGateways:[{directConnectGatewayId:'dxgw-core',directConnectGatewayName:'dxgw-core',amazonSideAsn:64513,directConnectGatewayState:'available'}]},
      DescribeDirectConnectGatewayAssociations:{directConnectGatewayAssociations:[{directConnectGatewayId:'dxgw-core',associatedGateway:{id:'tgw-core-kr',ownerAccount:NETWORK,region:APNE2}},{directConnectGatewayId:'dxgw-core',associatedGateway:{id:'tgw-core-jp',ownerAccount:NETWORK,region:APNE1}}]},
    }),
    networkAccount(APNE1,'tgw-core-jp','10.201',{}),
  ];
  awsWorkloads.forEach(([slug,region,size,opt],i)=>{
    const vpc=`vpc-${slug}`,cidr=`10.${210+i}`,sub=(n:string)=>`subnet-${slug}-${n}`,account=awsAccountId(i);
    const instances=Array.from({length:size},(_,n)=>ec2(`i-${slug}-${n+1}`,`${slug}-api-${pad(n+1)}`,n%4===3?'c6i.2xlarge':'m6i.xlarge',sub(n%2?'app-c':'app-a'),`${cidr}.${n%2?2:1}.${10+n}`,`sg-${slug}-app`,n>=size-(opt.stopped??0)?'stopped':'running'));
    const lbType=opt.nlb?'network':'application',lbName=`${opt.nlb?'nlb':'alb'}-${slug}`;
    accounts.push({account,label:slug,region,api:{
      DescribeVpcs:{Vpcs:[{VpcId:vpc,CidrBlock:`${cidr}.0.0/16`,Tags:tag(vpc)}]},
      DescribeSubnets:{Subnets:[awsSubnet(sub('public-a'),'public-a',vpc,`${cidr}.0.0/24`,`${region}a`,true),awsSubnet(sub('public-c'),'public-c',vpc,`${cidr}.4.0/24`,`${region}c`,true),awsSubnet(sub('app-a'),'app-a',vpc,`${cidr}.1.0/24`,`${region}a`),awsSubnet(sub('app-c'),'app-c',vpc,`${cidr}.2.0/24`,`${region}c`),awsSubnet(sub('data-a'),'data-a',vpc,`${cidr}.3.0/24`,`${region}a`)]},
      DescribeInstances:{Reservations:[{Instances:instances}]},
      DescribeSecurityGroups:{SecurityGroups:[securityGroup(`sg-${slug}-lb`,vpc,[sgRule(443,'0.0.0.0/0')]),securityGroup(`sg-${slug}-app`,vpc,[sgRule(8443,`${cidr}.0.0/24`),sgRule(443,'10.0.0.0/8')]),securityGroup(`sg-${slug}-db`,vpc,[sgRule(5432,`${cidr}.1.0/24`)],[])]},
      DescribeInternetGateways:{InternetGateways:[{InternetGatewayId:`igw-${slug}`,Attachments:[{VpcId:vpc,State:'available'}],Tags:tag(`igw-${slug}`)}]},
      DescribeNatGateways:{NatGateways:['a','c'].map(az=>({NatGatewayId:`nat-${slug}-${az}`,SubnetId:sub(`public-${az}`),State:'available',ConnectivityType:'public',NatGatewayAddresses:[{PrivateIp:`${cidr}.${az==='a'?0:4}.9`}],Tags:tag(`nat-${slug}-${az}`)}))},
      DescribeInstanceTypes:{InstanceTypes:instanceTypes},
      DescribeLoadBalancers:{LoadBalancers:[{LoadBalancerArn:`arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/${lbName}`,LoadBalancerName:lbName,Type:lbType,Scheme:'internet-facing',State:{Code:'active'},AvailabilityZones:[{SubnetId:sub('public-a')},{SubnetId:sub('public-c')}]}]},
      DescribeTargetGroups:{TargetGroups:[{TargetGroupArn:`arn:aws:elasticloadbalancing:${region}:${account}:targetgroup/tg-${slug}`,TargetType:'instance'}]},
      DescribeTargetHealth:{TargetHealthDescriptions:instances.slice(0,Math.min(4,size)).map(x=>({Target:{Id:x.InstanceId}}))},
      DescribeDBInstances:{DBInstances:[{DBInstanceIdentifier:`${opt.aurora?'aurora':'rds'}-${slug}`,Engine:opt.aurora?'aurora-postgresql':'postgres',DBInstanceClass:'db.r6g.xlarge',DBInstanceStatus:'available',MultiAZ:true,DBSubnetGroup:{Subnets:[{SubnetIdentifier:sub('data-a')}]},VpcSecurityGroups:[{VpcSecurityGroupId:`sg-${slug}-db`}]}]},
      ...(i===0?{DescribeVpcPeeringConnections:{VpcPeeringConnections:[{Status:{Code:'active'},RequesterVpcInfo:{VpcId:vpc,OwnerId:account},AccepterVpcInfo:{VpcId:'vpc-partner-analytics',OwnerId:'900000000001'}}]}}:{}),
      ...(opt.eks?{ListClusters:{clusters:[`eks-${slug}`]},DescribeCluster:{cluster:{name:`eks-${slug}`,status:'ACTIVE',version:'1.33',resourcesVpcConfig:{subnetIds:[sub('app-a'),sub('app-c')]}}}}:{}),
    }});
  });
  return accounts;
}
const awsLeaf=(slug:string):OrgTree=>{const i=awsWorkloads.findIndex(w=>w[0]===slug);return{id:awsAccountId(i),name:slug,scope:awsAccountId(i)};};
const awsOrg:OrgTree={id:'o-atlasglobal',name:'Atlas Global Org',children:[
  {id:'ou-infra',name:'Infrastructure',children:[{id:NETWORK,name:'network-core',scope:NETWORK}]},
  {id:'ou-workloads',name:'Workloads',children:[
    {id:'ou-prod-kr',name:'Prod KR',children:['checkout-prod','orders-prod','catalog-prod','logistics-prod','analytics-prod','batch-prod'].map(awsLeaf)},
    {id:'ou-prod-jp',name:'Prod JP',children:['checkout-jp','orders-jp'].map(awsLeaf)},
    {id:'ou-stage',name:'Staging',children:['stage','stage-jp'].map(awsLeaf)},
  ]},
]};
const SEOUL='asia-northeast3',TOKYO='asia-northeast1';
const prodHost='atlas-net-prod',nonprodHost='atlas-net-nonprod',prodVpc=`${compute(prodHost)}/global/networks/vpc-prod-shared`,nonprodVpc=`${compute(nonprodHost)}/global/networks/vpc-nonprod-shared`;
type GcpService=[string,typeof SEOUL|typeof TOKYO,number,'prod'|'nonprod',{gke?:boolean;sql?:boolean;redis?:boolean;off?:number}];
const gcpServices:GcpService[]=[
  ['recsys',SEOUL,5,'prod',{gke:true,redis:true}],['ads',SEOUL,4,'prod',{sql:true}],['media',SEOUL,6,'prod',{gke:true}],['risk',SEOUL,3,'prod',{sql:true,redis:true}],['warehouse',SEOUL,4,'prod',{sql:true}],
  ['recsys-jp',TOKYO,3,'prod',{gke:true}],['ads-jp',TOKYO,3,'prod',{sql:true}],['qa',SEOUL,3,'nonprod',{sql:true,off:1}],['perf',SEOUL,4,'nonprod',{gke:true,off:2}],
];
function gcpFixture(){
  const type=(t:string)=>`compute.googleapis.com/${t}`,assets:Raw[]=[];
  const sandbox=(n:string,i:number,net:string)=>{const project=`atlas-sandbox-${n}`,vpc=`${compute(project)}/global/networks/vpc-sandbox-${n}`,subnet=gcpSubnetName(project,SEOUL,`sandbox-${n}`);assets.push(asset(type('Network'),vpc,{name:`vpc-sandbox-${n}`,routingConfig:{routingMode:'REGIONAL'},peerings:[{name:'to-shared',network:net,state:'ACTIVE',importCustomRoutes:true}]},'global'),asset(type('Subnetwork'),subnet,{name:`sandbox-${n}`,network:vpc,ipCidrRange:`10.${240+i}.1.0/24`}));assets.push(gce(project,vpc,subnet,`sandbox-${n}-01`,`10.${240+i}.1.10`,'e2-medium',i?'TERMINATED':'RUNNING'));return vpc;};
  const sandboxVpcs=[sandbox('team-a',0,nonprodVpc),sandbox('team-b',1,nonprodVpc)];
  const router=(project:string,region:string,n:string)=>`${compute(project)}/regions/${region}/routers/${n}`;
  assets.push(asset(type('Network'),prodVpc,{name:'vpc-prod-shared',routingConfig:{routingMode:'GLOBAL'},peerings:[{name:'to-partner',network:`${compute('partner-data-exchange')}/global/networks/vpc-partner-exchange`,state:'ACTIVE'}]},'global'));
  assets.push(asset(type('Network'),nonprodVpc,{name:'vpc-nonprod-shared',routingConfig:{routingMode:'GLOBAL'},peerings:sandboxVpcs.map((network,i)=>({name:`to-sandbox-${i}`,network,state:'ACTIVE',exportCustomRoutes:true}))},'global'));
  for(const [n,region] of [['router-seoul-a',SEOUL],['router-seoul-b',SEOUL],['router-tokyo-a',TOKYO]] as const)assets.push(asset(type('Router'),router(prodHost,region,n),{name:n,network:prodVpc,bgp:{asn:64514}},region));
  assets.push(asset(type('Router'),router(nonprodHost,SEOUL,'router-nonprod'),{name:'router-nonprod',network:nonprodVpc,bgp:{asn:64515}}));
  for(const [n,r,region] of [['ic-seoul-a','router-seoul-a',SEOUL],['ic-seoul-b','router-seoul-b',SEOUL],['ic-tokyo-a','router-tokyo-a',TOKYO]] as const)assets.push(asset(type('InterconnectAttachment'),`${compute(prodHost)}/regions/${region}/interconnectAttachments/${n}`,{name:n,state:'ACTIVE',type:'DEDICATED',bandwidth:'BPS_10G',router:router(prodHost,region,r)},region));
  assets.push(asset(type('VpnTunnel'),`${compute(nonprodHost)}/regions/${SEOUL}/vpnTunnels/vpn-nonprod-1`,{name:'vpn-nonprod-1',status:'ESTABLISHED',router:router(nonprodHost,SEOUL,'router-nonprod')}));
  for(const [host,vpc] of [[prodHost,prodVpc],[nonprodHost,nonprodVpc]] as const){
    assets.push(asset(type('Firewall'),`${compute(host)}/global/firewalls/fw-${host}-internal`,{name:`fw-${host}-internal`,network:vpc,direction:'INGRESS',priority:1000,allowed:[{IPProtocol:'tcp',ports:['443','5432']}],sourceRanges:['10.0.0.0/8']},'global'));
    assets.push(asset(type('Firewall'),`${compute(host)}/global/firewalls/fw-${host}-iap`,{name:`fw-${host}-iap`,network:vpc,direction:'INGRESS',priority:900,allowed:[{IPProtocol:'tcp',ports:['22']}],sourceRanges:['35.235.240.0/20']},'global'));
  }
  gcpServices.forEach(([slug,region,size,env,opt],i)=>{
    const project=`atlas-${slug}`,host=env==='prod'?prodHost:nonprodHost,net=env==='prod'?prodVpc:nonprodVpc,cidr=`10.${220+i}`,zone=`${region}-a`;
    const apps=gcpSubnetName(host,region,`${slug}-apps`);
    assets.push(asset(type('Subnetwork'),apps,{name:`${slug}-apps`,network:net,ipCidrRange:`${cidr}.1.0/24`},region));
    assets.push(asset(type('ForwardingRule'),`${compute(project)}/regions/${region}/forwardingRules/ilb-${slug}`,{name:`ilb-${slug}`,IPAddress:`${cidr}.1.5`,loadBalancingScheme:'INTERNAL',ports:['443'],subnetwork:apps},region));
    for(let n=0;n<size;n++)assets.push(gce(project,net,apps,`${slug}-vm-${pad(n+1)}`,`${cidr}.1.${10+n}`,n%3===2?'n2-standard-8':'e2-standard-4',n>=size-(opt.off??0)?'TERMINATED':'RUNNING',{},zone));
    if(opt.gke){const nodes=gcpSubnetName(host,region,`${slug}-gke`);assets.push(asset(type('Subnetwork'),nodes,{name:`${slug}-gke`,network:net,ipCidrRange:`${cidr}.16.0/20`},region),asset('container.googleapis.com/Cluster',`//container.googleapis.com/projects/${project}/locations/${region}/clusters/gke-${slug}`,{name:`gke-${slug}`,status:'RUNNING',currentMasterVersion:'1.33.1-gke.100',currentNodeCount:6+i,networkConfig:{subnetwork:`projects/${host}/regions/${region}/subnetworks/${slug}-gke`}},region));}
    if(opt.sql)assets.push(asset('sqladmin.googleapis.com/Instance',`//sqladmin.googleapis.com/projects/${project}/instances/sql-${slug}`,{name:`sql-${slug}`,state:'RUNNABLE',databaseVersion:'POSTGRES_16',ipAddresses:[{ipAddress:`${cidr}.9.3`}],settings:{tier:'db-custom-8-32768',ipConfiguration:{privateNetwork:`/projects/${host}/global/networks/${net.split('/').pop()}`}}},region));
    if(opt.redis)assets.push(asset('redis.googleapis.com/Instance',`//redis.googleapis.com/projects/${project}/locations/${region}/instances/redis-${slug}`,{name:`redis-${slug}`,state:'READY',tier:'STANDARD_HA',host:`${cidr}.9.4`,authorizedNetwork:`projects/${host}/global/networks/${net.split('/').pop()}`},region));
  });
  const project=(id:string):OrgTree=>({id,name:id,scope:id}),service=(...slugs:string[])=>slugs.map(s=>project(`atlas-${s}`));
  const tree:OrgTree={id:'000000000000',name:'atlas-global.example',children:[
    {id:'1000',name:'Network',children:[project(prodHost),project(nonprodHost)]},
    {id:'2000',name:'Production',children:[{id:'2100',name:'Seoul',children:service('recsys','ads','media','risk','warehouse')},{id:'2200',name:'Tokyo',children:service('recsys-jp','ads-jp')}]},
    {id:'3000',name:'Non-production',children:service('qa','perf')},
    {id:'4000',name:'Sandbox',children:service('sandbox-team-a','sandbox-team-b')},
  ]};
  return{parent:'organizations/000000000000',assets,tree};
}
const sites:Site[]=[
  {id:'seoul-dc',name:'Seoul DC',region:'Seoul',cidr:'10.0.0.0/12',connects:[{name:'er-seoul-01',label:'ExpressRoute · 10 Gbps'},{name:'dxgw-core',label:'Direct Connect · 10 Gbps'},{name:'ic-seoul-a',label:'Interconnect · 10 Gbps'}]},
  {id:'busan-dr',name:'Busan DR',region:'Busan',cidr:'10.16.0.0/12',connects:[{name:'er-busan-02',label:'ExpressRoute · 2 Gbps'},{name:'vpn-busan-backup',label:'IPsec 백업'},{name:'ic-seoul-b',label:'Interconnect · 10 Gbps'}]},
  {id:'tokyo-colo',name:'Tokyo colo',region:'Tokyo',cidr:'10.32.0.0/12',connects:[{name:'er-tokyo-01',label:'ExpressRoute · 10 Gbps'},{name:'dxgw-core',label:'Direct Connect · 10 Gbps'},{name:'ic-tokyo-a',label:'Interconnect · 10 Gbps'}]},
  {id:'branch-wan',name:'지점 WAN',region:'전국',cidr:'172.16.0.0/12',connects:[{name:'vpn-branch-wan',label:'SD-WAN IPsec'},{name:'vpn-nonprod-1',label:'Cloud VPN'}]},
];
export const enterprise:Scenario={azure:azureFixture(),aws:awsFixture(),awsOrg,gcp:gcpFixture(),onprem:sites,flows:[
  {hops:['Seoul DC','er-seoul-01','vgw-hub-kr','afw-hub-koreacentral'.replace('-koreacentral','-kr'),'agw-commerce','commerce-web-01','commerce-app-01','sql-commerce'],rate:'2.4 Gbps'},
  {hops:['Seoul DC','dxgw-core','tgw-core-kr','vpc-checkout-prod','alb-checkout-prod','checkout-prod-api-01','aurora-checkout-prod'],rate:'1.8 Gbps'},
  {hops:['Seoul DC','ic-seoul-a','router-seoul-a','ilb-recsys','recsys-vm-01','redis-recsys'],rate:'900 Mbps'},
  {hops:['Tokyo colo','er-tokyo-01','vgw-hub-jp','agw-commerce-jp','commerce-jp-web-01','commerce-jp-app-01','sql-commerce-jp'],rate:'700 Mbps'},
]};
