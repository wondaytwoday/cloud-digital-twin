import { finish,normalizeAzure,normalizeAws,normalizeGcp,scopeNodeId,type Normalized } from './normalize.js';
import type { HierarchyNode } from '../shared/schema.js';
export const AZURE_TYPES=['microsoft.compute/virtualmachines','microsoft.network/networkinterfaces','microsoft.network/virtualnetworks','microsoft.network/networksecuritygroups','microsoft.network/expressroutecircuits','microsoft.network/virtualnetworkgateways','microsoft.network/connections','microsoft.network/azurefirewalls','microsoft.network/loadbalancers','microsoft.network/natgateways','microsoft.network/privateendpoints','microsoft.network/applicationgateways','microsoft.network/bastionhosts','microsoft.containerservice/managedclusters','microsoft.sql/servers','microsoft.cache/redis','microsoft.documentdb/databaseaccounts','microsoft.storage/storageaccounts'];
export const GCP_TYPES=[...['Instance','Network','Subnetwork','Firewall','Router','InterconnectAttachment','VpnTunnel','ForwardingRule'].map(t=>`compute.googleapis.com/${t}`),'container.googleapis.com/Cluster','sqladmin.googleapis.com/Instance','redis.googleapis.com/Instance'];
// Injectable HTTP boundary permits contract tests and the demo mode without credentials or live calls.
export async function azurePages(subscriptions:string[],token:()=>Promise<string>,request:typeof fetch=fetch){
  const rows:Record<string,any>[]=[],seen=new Set<string>();let next:string|undefined;
  do{
    let response:Response|undefined;
    for(let attempt=0;attempt<4;attempt++){
      response=await request('https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01',{method:'POST',headers:{Authorization:`Bearer ${await token()}`,'Content-Type':'application/json'},body:JSON.stringify({subscriptions,query:`Resources | where type in~ (${AZURE_TYPES.map(t=>`'${t}'`).join(',')}) | project id, name, type, location, subscriptionId, resourceGroup, properties, tags, sku | order by id asc`,options:{$top:1000,resultFormat:'objectArray',...(next?{$skipToken:next}:{})}}),signal:AbortSignal.timeout(30_000)});
      if(response.status!==429&&response.status<500)break;
      if(attempt<3){const delay=Math.min(10_000,Math.max(500,(Number(response.headers.get('retry-after'))||2**attempt)*1000));await new Promise(r=>setTimeout(r,delay));}
    }
    if(!response?.ok)throw new Error(`Azure Resource Graph HTTP ${response?.status}. 조회 범위와 Reader 권한을 확인하세요.`);
    const body=await response.json();if(!Array.isArray(body.data))throw new Error('Azure: expected objectArray');
    rows.push(...body.data);next=body.$skipToken;
    if(body.resultTruncated==='true'&&!next)throw new Error('Azure: truncated response without continuation token');
    if(next){if(seen.has(next))throw new Error('Azure: repeated pagination token');seen.add(next);}
  }while(next);
  return rows;
}
// Requires Microsoft.Management/managementGroups/read at the tenant root; without it the tree degrades to flat subscriptions.
async function azureHierarchy(token:()=>Promise<string>,request:typeof fetch){
  const get=async(url:string)=>{const r=await request(url,{headers:{Authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(30_000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();};
  const tenant=(await get('https://management.azure.com/tenants?api-version=2022-12-01')).value?.[0];if(!tenant)throw new Error('tenant 없음');
  const root=await get(`https://management.azure.com/providers/Microsoft.Management/managementGroups/${tenant.tenantId}?api-version=2021-04-01&$expand=children&$recurse=true`);
  const rootId=`azure:mg:${tenant.tenantId}`,nodes:HierarchyNode[]=[{id:rootId,name:tenant.displayName??root.properties?.displayName??'Tenant Root Group',provider:'azure',kind:'tenant',nativeId:tenant.tenantId}];
  const walk=(children:any[]|undefined,parent:string)=>{for(const c of children??[]){
    if(String(c.type).toLowerCase().endsWith('/subscriptions'))nodes.push({id:scopeNodeId('azure',c.name),parent,name:c.displayName??c.name,provider:'azure',kind:'subscription',nativeId:c.name,scope:c.name});
    else{const id=`azure:mg:${c.name}`;nodes.push({id,parent,name:c.displayName??c.name,provider:'azure',kind:'managementGroup',nativeId:c.name});walk(c.children,id);}
  }};
  walk(root.properties?.children,rootId);
  return nodes;
}
export async function collectAzureWith(subscriptions:string[],token:()=>Promise<string>,request:typeof fetch=fetch):Promise<Normalized>{
  // Explicit scope checks prevent ARG silently succeeding with only some subscriptions.
  const labels:Record<string,string>={};
  for(const sub of subscriptions){const r=await request(`https://management.azure.com/subscriptions/${encodeURIComponent(sub)}?api-version=2022-12-01`,{headers:{Authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(30_000)});if(!r.ok)throw new Error(`Azure 구독 ${sub}: 접근 확인 실패 (${r.status})`);labels[sub]=(await r.json()).displayName??sub;}
  const part=normalizeAzure(await azurePages(subscriptions,token,request),labels);
  try{part.hierarchy=await azureHierarchy(token,request);}catch(e){part.warnings.push(`Azure: 관리 그룹을 읽지 못해 구독을 평면으로 표시합니다 (${e instanceof Error?e.message:'오류'}).`);}
  const result=finish([part]);result.warnings.push('Azure: 보이는 지원 자원만 수집. 구독 내부 리소스별 접근 제한과 Resource Graph 반영 지연은 별도 확인 필요.');return result;
}
export async function collectAzure(subscriptions:string[]):Promise<Normalized>{
  const {DefaultAzureCredential}=await import('@azure/identity');const credential=new DefaultAzureCredential();
  return collectAzureWith(subscriptions,async()=>(await credential.getToken('https://management.azure.com/.default')).token);
}
type AwsService='ec2'|'elb'|'rds'|'dx'|'eks'|'org';
export type AwsCaller=(service:AwsService,operation:string,input?:Record<string,any>)=>Promise<any>;
async function awsPages(call:AwsCaller,service:AwsService,operation:string,key:string,input:Record<string,any>={},tokenIn='NextToken',tokenOut='NextToken'){
  const out:any[]=[],seen=new Set<string>();let token:string|undefined;
  do{const response=await call(service,operation,{...input,...(token?{[tokenIn]:token}:{})});out.push(...(response[key]??[]));token=response[tokenOut];if(token){if(seen.has(token))throw new Error('AWS: repeated pagination token');seen.add(token);}}while(token);
  return out;
}
export async function collectAwsAccount(call:AwsCaller,account:string,region:string,label?:string):Promise<Normalized>{
  const data:Record<string,any[]>={},paged={MaxResults:100};
  for(const [operation,key] of [['DescribeVpcs','Vpcs'],['DescribeSubnets','Subnets'],['DescribeInstances','Reservations'],['DescribeSecurityGroups','SecurityGroups'],['DescribeInternetGateways','InternetGateways'],['DescribeNatGateways','NatGateways'],['DescribeTransitGateways','TransitGateways'],['DescribeTransitGatewayVpcAttachments','TransitGatewayVpcAttachments'],['DescribeTransitGatewayPeeringAttachments','TransitGatewayPeeringAttachments'],['DescribeVpcPeeringConnections','VpcPeeringConnections']] as const)data[key]=await awsPages(call,'ec2',operation,key,paged);
  // These two operations take no MaxResults and return everything at once.
  data.VpnGateways=(await call('ec2','DescribeVpnGateways')).VpnGateways??[];
  data.VpnConnections=(await call('ec2','DescribeVpnConnections')).VpnConnections??[];
  const types=[...new Set(data.Reservations.flatMap(r=>r.Instances??[]).map(r=>r.InstanceType))];data.InstanceTypes=[];
  for(let i=0;i<types.length;i+=100)data.InstanceTypes.push(...await awsPages(call,'ec2','DescribeInstanceTypes','InstanceTypes',{InstanceTypes:types.slice(i,i+100)}));
  data.LoadBalancers=await awsPages(call,'elb','DescribeLoadBalancers','LoadBalancers',{},'Marker','NextMarker');
  for(const lb of data.LoadBalancers){
    lb.Targets=[];
    for(const group of await awsPages(call,'elb','DescribeTargetGroups','TargetGroups',{LoadBalancerArn:lb.LoadBalancerArn},'Marker','NextMarker'))if(group.TargetType==='instance')lb.Targets.push(...((await call('elb','DescribeTargetHealth',{TargetGroupArn:group.TargetGroupArn})).TargetHealthDescriptions??[]).map((t:any)=>t.Target.Id));
  }
  data.DBInstances=await awsPages(call,'rds','DescribeDBInstances','DBInstances',{},'Marker','Marker');
  data.DirectConnectGateways=await awsPages(call,'dx','DescribeDirectConnectGateways','directConnectGateways',{},'nextToken','nextToken');
  for(const gateway of data.DirectConnectGateways)gateway.associations=(await awsPages(call,'dx','DescribeDirectConnectGatewayAssociations','directConnectGatewayAssociations',{directConnectGatewayId:gateway.directConnectGatewayId},'nextToken','nextToken')).filter(a=>a.directConnectGatewayId===gateway.directConnectGatewayId);
  data.Clusters=[];
  for(const name of await awsPages(call,'eks','ListClusters','clusters',{},'nextToken','nextToken'))data.Clusters.push((await call('eks','DescribeCluster',{name})).cluster);
  return normalizeAws(data,account,region,label);
}
// Organizations answers only for the management or a delegated admin account; member accounts fall back to a flat list.
export async function awsHierarchy(call:AwsCaller){
  const organization=(await call('org','DescribeOrganization')).Organization,orgId=`aws:org:${organization.Id}`;
  const nodes:HierarchyNode[]=[{id:orgId,name:organization.Name??organization.Id,provider:'aws',kind:'organization',nativeId:organization.Id}];
  const walk=async(parentNative:string,parent:string)=>{
    for(const a of await awsPages(call,'org','ListAccountsForParent','Accounts',{ParentId:parentNative}))nodes.push({id:scopeNodeId('aws',a.Id),parent,name:a.Name??a.Id,provider:'aws',kind:'account',nativeId:a.Id,scope:a.Id});
    for(const ou of await awsPages(call,'org','ListOrganizationalUnitsForParent','OrganizationalUnits',{ParentId:parentNative})){const id=`aws:ou:${ou.Id}`;nodes.push({id,parent,name:ou.Name??ou.Id,provider:'aws',kind:'ou',nativeId:ou.Id});await walk(ou.Id,id);}
  };
  for(const root of await awsPages(call,'org','ListRoots','Roots'))await walk(root.Id,orgId);
  return nodes;
}
export type AwsRole={label:string;roleArn:string};
export async function collectAws(regions:string[],roles:AwsRole[]=[]):Promise<Normalized>{
  const [ec2,sts,elb,rds,dx,eks,org]=await Promise.all([import('@aws-sdk/client-ec2'),import('@aws-sdk/client-sts'),import('@aws-sdk/client-elastic-load-balancing-v2'),import('@aws-sdk/client-rds'),import('@aws-sdk/client-direct-connect'),import('@aws-sdk/client-eks'),import('@aws-sdk/client-organizations')]);
  const parts:Normalized[]=[];let hierarchy:HierarchyNode[]|undefined;
  for(const role of roles.length?roles:[undefined]){
    const base=new sts.STSClient({region:regions[0],maxAttempts:3});let credentials:any;
    if(role){const {Credentials:c}=await base.send(new sts.AssumeRoleCommand({RoleArn:role.roleArn,RoleSessionName:'cloud-atlas-reader',DurationSeconds:900}));if(!c)throw new Error(`AWS 역할 ${role.label}: 자격 증명을 받지 못했습니다.`);credentials={accessKeyId:c.AccessKeyId!,secretAccessKey:c.SecretAccessKey!,sessionToken:c.SessionToken!};}
    const identity=await new sts.STSClient({region:regions[0],maxAttempts:3,credentials}).send(new sts.GetCallerIdentityCommand({}));
    if(!identity.Account)throw new Error('AWS 계정 ID를 확인할 수 없습니다.');
    if(!hierarchy){const client=new org.OrganizationsClient({region:'us-east-1',maxAttempts:3,credentials});try{hierarchy=await awsHierarchy((_s,operation,input={})=>client.send(new (org as any)[`${operation}Command`](input)) as Promise<any>);}catch{/* try the next role; a later warning reports if none could read it */}client.destroy();}
    for(const region of regions){
      const options={region,maxAttempts:3,credentials},clients={ec2:new ec2.EC2Client(options),elb:new elb.ElasticLoadBalancingV2Client(options),rds:new rds.RDSClient(options),dx:new dx.DirectConnectClient(options),eks:new eks.EKSClient(options)},modules:Record<string,any>={ec2,elb,rds,dx,eks};
      const call:AwsCaller=(service,operation,input={})=>(clients as any)[service].send(new modules[service][`${operation}Command`](input));
      parts.push(await collectAwsAccount(call,identity.Account,region,role?.label));
      for(const client of Object.values(clients))client.destroy();
    }
  }
  const warnings=hierarchy?[]:['AWS: Organizations를 읽지 못해 계정을 평면으로 표시합니다. 관리 계정 또는 위임 관리자 권한이 필요합니다.'];
  return finish([...parts,{resources:[],links:[],warnings,scopeLabels:{},hierarchy}]);
}
// REST fallback avoids protobuf Struct conversion ambiguity for resource.data.
export async function gcpPages(parent:string,request:(url:string)=>Promise<any>,types=GCP_TYPES){
  const assets:Record<string,any>[]=[],seen=new Set<string>();let next:string|undefined,readTime:string|undefined;
  do{const q=new URLSearchParams({contentType:'RESOURCE',pageSize:'1000'});types.forEach(t=>q.append('assetTypes',t));if(next)q.set('pageToken',next);if(readTime)q.set('readTime',readTime);
    const body=await request(`https://cloudasset.googleapis.com/v1/${parent}/assets?${q}`);if(!Array.isArray(body.assets)&&body.assets!==undefined)throw new Error('GCP: invalid assets response');assets.push(...body.assets??[]);readTime=body.readTime??readTime;next=body.nextPageToken;if(next){if(seen.has(next))throw new Error('GCP: repeated pagination token');seen.add(next);}
  }while(next);return assets;
}
const GCP_HIERARCHY_TYPES=['Organization','Folder','Project'].map(t=>`cloudresourcemanager.googleapis.com/${t}`);
async function gcpHierarchy(parent:string,request:(url:string)=>Promise<any>){
  const nodes:HierarchyNode[]=[];
  for(const a of await gcpPages(parent,request,GCP_HIERARCHY_TYPES)){
    const d=a.resource?.data??{};
    if(a.assetType.endsWith('/Organization'))nodes.push({id:`gcp:${d.name}`,name:d.displayName??d.name,provider:'gcp',kind:'organization',nativeId:d.name});
    else if(a.assetType.endsWith('/Folder'))nodes.push({id:`gcp:${d.name}`,parent:`gcp:${d.parent}`,name:d.displayName??d.name,provider:'gcp',kind:'folder',nativeId:d.name});
    else nodes.push({id:scopeNodeId('gcp',d.projectId),parent:d.parent?`gcp:${d.parent.type}s/${d.parent.id}`:undefined,name:d.name??d.projectId,provider:'gcp',kind:'project',nativeId:d.projectId,scope:d.projectId});
  }
  // A parent outside the listed range (for example, a folder-scoped collection) becomes a root rather than dangling.
  const known=new Set(nodes.map(n=>n.id));for(const n of nodes)if(n.parent&&!known.has(n.parent))delete n.parent;
  return nodes;
}
export async function collectGcpWith(parent:string,request:(url:string)=>Promise<any>):Promise<Normalized>{
  const part=normalizeGcp(await gcpPages(parent,request));
  if(!parent.startsWith('projects/'))try{part.hierarchy=await gcpHierarchy(parent,request);}catch(e){part.warnings.push(`GCP: 조직 계층을 읽지 못해 프로젝트를 평면으로 표시합니다 (${e instanceof Error?e.message:'오류'}).`);}
  const result=finish([part]);result.warnings.push('GCP: Asset Inventory의 최종 일관성 데이터. Cloud Router 관계는 구성 참조이며 패킷 경유 경로가 아닙니다.');return result;
}
export async function collectGcp(parent:string):Promise<Normalized>{
  const {GoogleAuth}=await import('google-auth-library');const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});const client=await auth.getClient();
  return collectGcpWith(parent,async(url)=>{const response=await client.request({url,timeout:30_000,retryConfig:{retry:3}});return response.data;});
}
