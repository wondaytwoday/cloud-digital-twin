// Entirely synthetic. Keep the smaller scenarios available for focused demos.
import {enterprise} from './enterprise.js';
import {asset,awsSubnet,azRow,compute,ec2,gce,gcpSubnetName,instanceTypes,nsg,privateService,securityGroup,sgRule,subnetId,tag,vm,vnet,vnetId} from './builders.js';
import type {OrgTree,Scenario} from './types.js';

const regions=[
  {key:'kr',label:'한국',azure:'koreacentral',aws:'ap-northeast-2',gcp:'asia-northeast3'},
  {key:'jp',label:'일본',azure:'japaneast',aws:'ap-northeast-1',gcp:'asia-northeast1'},
  {key:'us',label:'미국',azure:'eastus',aws:'us-east-1',gcp:'us-east1'},
] as const;
const units=['retail','finance','health','gaming','mobility','research'];
const environments=['prod','stage','dev'];
const uuid=(n:number)=>`00000000-0000-4000-9000-${String(n).padStart(12,'0')}`;
const pad=(n:number)=>String(n).padStart(2,'0');
const leaf=(id:string,name:string):OrgTree=>({id,name,scope:id});

function buildGlobalScale():Scenario{
  const azure={...enterprise.azure!,subscriptions:{...enterprise.azure!.subscriptions},rows:[...enterprise.azure!.rows],tree:structuredClone(enterprise.azure!.tree!)};
  const aws=[...enterprise.aws!],awsOrg=structuredClone(enterprise.awsOrg!);
  const gcp={...enterprise.gcp!,assets:[...enterprise.gcp!.assets],tree:structuredClone(enterprise.gcp!.tree!)};
  let index=0;
  for(const region of regions){
    const azRegion:OrgTree={id:`mg-scale-${region.key}`,name:`대규모 사업부 · ${region.label}`,children:[]};
    const awsRegion:OrgTree={id:`ou-scale-${region.key}`,name:`대규모 사업부 · ${region.label}`,children:[]};
    const gcpRegion:OrgTree={id:String(5000+index),name:`대규모 사업부 · ${region.label}`,children:[]};
    azure.tree.children!.push(azRegion);awsOrg.children!.push(awsRegion);gcp.tree.children!.push(gcpRegion);
    const hubSub=uuid(1000+index),hubRg=`rg-scale-hub-${region.key}`,hubNet=`vnet-scale-hub-${region.key}`;
    azure.subscriptions[hubSub]=`공용 네트워크 ${region.label}`;
    const hub=vnet(hubSub,hubRg,hubNet,`10.240.${index}.0/24`,[['shared',`10.240.${index}.0/26`]],[],region.azure);
    azure.rows.push(hub);azRegion.children!.push(leaf(hubSub,azure.subscriptions[hubSub]));
    const host=`scale-net-${region.key}`,sharedVpc=`${compute(host)}/global/networks/vpc-scale-shared-${region.key}`;
    gcp.assets.push(asset('compute.googleapis.com/Network',sharedVpc,{name:`vpc-scale-shared-${region.key}`,routingConfig:{routingMode:'GLOBAL'}},'global'));
    gcpRegion.children!.push(leaf(host,`공유 VPC 호스트 ${region.label}`));
    for(const [unitIndex,unit] of units.entries()){
      const azUnit:OrgTree={id:`mg-scale-${region.key}-${unit}`,name:unit,children:[]};
      const awsUnit:OrgTree={id:`ou-scale-${region.key}-${unit}`,name:unit,children:[]};
      const gcpUnit:OrgTree={id:String(10000+index*10+unitIndex),name:unit,children:[]};
      azRegion.children!.push(azUnit);awsRegion.children!.push(awsUnit);gcpRegion.children!.push(gcpUnit);
      for(const env of environments){
        const i=index++,slug=`${unit}-${region.key}-${env}`,sub=uuid(2000+i),rg=`rg-${slug}`,net=`vnet-${slug}`;
        const account=String(300000000000+i),project=`scale-${slug}`;
        const azCidr=`10.48.${i*4}`,awsCidr=`10.80.${i*4}`,gcpCidr=`10.160.${i*4}`;
        azure.subscriptions[sub]=`${unit} ${region.label} ${env}`;azUnit.children!.push(leaf(sub,azure.subscriptions[sub]));
        const spokeId=vnetId(sub,rg,net),hubId=vnetId(hubSub,hubRg,hubNet);
        azure.rows.push(vnet(sub,rg,net,`${azCidr}.0/22`,[['app',`${azCidr}.0/24`,`nsg-${slug}`],['data',`10.48.${i*4+1}.0/24`,`nsg-${slug}`]],[[hubId,{}]],region.azure));
        hub.properties.virtualNetworkPeerings.push({name:`peer-${slug}`,properties:{remoteVirtualNetwork:{id:spokeId},peeringState:'Connected'}});
        azure.rows.push(nsg(sub,rg,`nsg-${slug}`,[['HTTPS','Inbound','Allow','Tcp','443','10.0.0.0/8',100],['SSH','Inbound','Allow','Tcp','22',env==='dev'?'0.0.0.0/0':'10.0.0.0/8',200]],region.azure));
        for(let n=0;n<18;n++){
          const status=env==='dev'&&n%4===0?'deallocated':i%11===0&&n===1?'failed':'running';
          const rows=vm(sub,rg,net,'app',`${slug}-vm-${pad(n+1)}`,`${azCidr}.${10+n}`,'Standard_D4s_v5',status,region.azure);
          for(const row of rows)row.tags={environment:env,application:unit,costCenter:`CC-${100+unitIndex}`,owner:`${unit}@atlas.example`};
          azure.rows.push(...rows);
        }
        azure.rows.push(...privateService(sub,rg,'Sql/servers',`sql-scale-${slug}`,{state:'Ready',version:'12.0'},subnetId(sub,rg,net,'data'),`10.48.${i*4+1}.5`,region.azure));
        if(env==='prod')azure.rows.push(azRow(sub,rg,'ContainerService/managedClusters',`aks-scale-${slug}`,{provisioningState:'Succeeded',powerState:{code:'Running'},agentPoolProfiles:[{count:6,vnetSubnetID:subnetId(sub,rg,net,'app')}]},{},region.azure));

        const vpc=`vpc-scale-${slug}`,app=`subnet-scale-${slug}-app`,data=`subnet-scale-${slug}-data`,sg=`sg-scale-${slug}`;
        const instances=Array.from({length:18},(_,n)=>({...ec2(`i-scale-${slug}-${n}`,`${slug}-api-${pad(n+1)}`,'m6i.xlarge',app,`${awsCidr}.${10+n}`,sg,env==='dev'&&n%4===0?'stopped':'running'),Tags:tag(`${slug}-api-${pad(n+1)}`,{environment:env,application:unit,owner:`${unit}@atlas.example`})}));
        aws.push({account,label:`scale-${slug}`,region:region.aws,api:{
          DescribeVpcs:{Vpcs:[{VpcId:vpc,CidrBlock:`${awsCidr}.0/22`,Tags:tag(vpc)}]},
          DescribeSubnets:{Subnets:[awsSubnet(app,'app-a',vpc,`${awsCidr}.0/24`,`${region.aws}a`),awsSubnet(data,'data-b',vpc,`10.80.${i*4+1}.0/24`,`${region.aws}b`)]},
          DescribeInstances:{Reservations:[{Instances:instances}]},DescribeInstanceTypes:{InstanceTypes:instanceTypes},
          DescribeSecurityGroups:{SecurityGroups:[securityGroup(sg,vpc,[sgRule(443,'10.0.0.0/8'),sgRule(22,env==='dev'?'0.0.0.0/0':'10.0.0.0/8')])]},
          DescribeDBInstances:{DBInstances:[{DBInstanceIdentifier:`rds-scale-${slug}`,Engine:'postgres',DBInstanceClass:'db.r6g.xlarge',DBInstanceStatus:i%13===0?'backing-up':'available',MultiAZ:env==='prod',DBSubnetGroup:{Subnets:[{SubnetIdentifier:data}]},VpcSecurityGroups:[{VpcSecurityGroupId:sg}]}]},
          // A configured cross-account peer is a reference, not observed traffic.
          DescribeVpcPeeringConnections:{VpcPeeringConnections:[{Status:{Code:'active'},RequesterVpcInfo:{VpcId:vpc,OwnerId:account},AccepterVpcInfo:{VpcId:'vpc-inspect-ap-northeast-2',OwnerId:'100000000001',Region:'ap-northeast-2'}}]},
          ...(env==='prod'?{ListClusters:{clusters:[`eks-scale-${slug}`]},DescribeCluster:{cluster:{name:`eks-scale-${slug}`,status:'ACTIVE',version:'1.33',resourcesVpcConfig:{subnetIds:[app,data]}}}}:{}),
        }});awsUnit.children!.push(leaf(account,`${unit} ${region.label} ${env}`));

        const apps=gcpSubnetName(host,region.gcp,`${slug}-apps`);
        gcp.assets.push(asset('compute.googleapis.com/Subnetwork',apps,{name:`${slug}-apps`,network:sharedVpc,ipCidrRange:`${gcpCidr}.0/24`},region.gcp));
        for(let n=0;n<18;n++)gcp.assets.push(gce(project,sharedVpc,apps,`${slug}-gce-${pad(n+1)}`,`${gcpCidr}.${10+n}`,'e2-standard-4',env==='dev'&&n%4===0?'TERMINATED':'RUNNING',{labels:{environment:env,application:unit,owner:unit}},`${region.gcp}-a`));
        gcp.assets.push(asset('sqladmin.googleapis.com/Instance',`//sqladmin.googleapis.com/projects/${project}/instances/sql-scale-${slug}`,{name:`sql-scale-${slug}`,state:'RUNNABLE',databaseVersion:'POSTGRES_16',settings:{tier:'db-custom-4-16384',ipConfiguration:{privateNetwork:sharedVpc.replace('//compute.googleapis.com','')}}},region.gcp));
        if(env==='prod')gcp.assets.push(asset('container.googleapis.com/Cluster',`//container.googleapis.com/projects/${project}/locations/${region.gcp}/clusters/gke-scale-${slug}`,{name:`gke-scale-${slug}`,status:'RUNNING',currentNodeCount:6,networkConfig:{subnetwork:apps.replace('//compute.googleapis.com/','')}},region.gcp));
        gcpUnit.children!.push(leaf(project,`${unit} ${region.label} ${env}`));
      }
    }
  }
  return{...enterprise,azure,aws,awsOrg,gcp};
}
export const globalScale=buildGlobalScale();
