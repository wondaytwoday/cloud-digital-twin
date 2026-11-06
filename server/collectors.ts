import { finish,normalizeAwsIam,normalizeAzure,normalizeAzureIam,normalizeAws,normalizeGcp,normalizeGcpIam,scopeNodeId,type Normalized } from './normalize.js';
import type { Activity, CostRow, HierarchyNode, IamAssignment } from '../shared/schema.js';
import {noReport,type Report} from '../shared/collect.js';
export type CollectOptions={withCost?:boolean;withActivity?:boolean;report?:Report};
// Change records cover a week: long enough to answer "who touched this", short enough to read in one pass.
const ACTIVITY_DAYS=7,ACTIVITY_CAP=2000;
const activitySince=(now=new Date())=>new Date(now.getTime()-ACTIVITY_DAYS*86_400_000);
const lastSegment=(id:string)=>id.split('/').filter(Boolean).pop()??id;
const count=(n:number)=>n.toLocaleString('ko-KR');
const SIX_MONTHS=6;
// Whole months up to today, the window every provider's cost query uses.
export function costWindow(now=new Date(),months=SIX_MONTHS){const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-(months-1),1));return{start:start.toISOString().slice(0,10),end:new Date(now.getTime()+86_400_000).toISOString().slice(0,10)};}
// Injectable HTTP boundary permits contract tests and the demo mode without credentials or live calls.
const AZURE_RESOURCES='Resources | project id, name, type, location, subscriptionId, resourceGroup, properties, tags, sku | order by id asc';
const AZURE_IAM="authorizationresources | where type =~ 'microsoft.authorization/roleassignments' or type =~ 'microsoft.authorization/roledefinitions' | project id, type, properties, subscriptionId | order by id asc";
export async function azurePages(subscriptions:string[],token:()=>Promise<string>,request:typeof fetch=fetch,query=AZURE_RESOURCES,onRows:(total:number)=>void=()=>{}){
  const rows:Record<string,any>[]=[],seen=new Set<string>();let next:string|undefined;
  do{
    let response:Response|undefined;
    for(let attempt=0;attempt<4;attempt++){
      response=await request('https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01',{method:'POST',headers:{Authorization:`Bearer ${await token()}`,'Content-Type':'application/json'},body:JSON.stringify({subscriptions,query,options:{$top:1000,resultFormat:'objectArray',...(next?{$skipToken:next}:{})}}),signal:AbortSignal.timeout(30_000)});
      if(response.status!==429&&response.status<500)break;
      if(attempt<3){const delay=Math.min(10_000,Math.max(500,(Number(response.headers.get('retry-after'))||2**attempt)*1000));await new Promise(r=>setTimeout(r,delay));}
    }
    if(!response?.ok)throw new Error(`Azure Resource Graph HTTP ${response?.status}. 조회 범위와 Reader 권한을 확인하세요.`);
    const body=await response.json();if(!Array.isArray(body.data))throw new Error('Azure: expected objectArray');
    rows.push(...body.data);onRows(rows.length);next=body.$skipToken;
    if(body.resultTruncated==='true'&&!next)throw new Error('Azure: truncated response without continuation token');
    if(next){if(seen.has(next))throw new Error('Azure: repeated pagination token');seen.add(next);}
  }while(next);
  return rows;
}
// Requires Microsoft.Management/managementGroups/read at the tenant root; without it the tree degrades to flat subscriptions.
async function azureHierarchy(token:()=>Promise<string>,request:typeof fetch,tenantId?:string){
  const get=async(url:string)=>{const r=await request(url,{headers:{Authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(30_000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();};
  // A credential can see many tenants; the root must be the one that owns the collected subscriptions.
  const tenants:any[]=(await get('https://management.azure.com/tenants?api-version=2022-12-01')).value??[],tenant=tenants.find(t=>t.tenantId===tenantId)??(tenantId?undefined:tenants[0]);if(!tenant)throw new Error('구독의 테넌트를 찾지 못함');
  const root=await get(`https://management.azure.com/providers/Microsoft.Management/managementGroups/${tenant.tenantId}?api-version=2021-04-01&$expand=children&$recurse=true`);
  const rootId=`azure:mg:${tenant.tenantId}`,nodes:HierarchyNode[]=[{id:rootId,name:tenant.displayName??root.properties?.displayName??'Tenant Root Group',provider:'azure',kind:'tenant',nativeId:tenant.tenantId}];
  const walk=(children:any[]|undefined,parent:string)=>{for(const c of children??[]){
    if(String(c.type).toLowerCase().endsWith('/subscriptions'))nodes.push({id:scopeNodeId('azure',c.name),parent,name:c.displayName??c.name,provider:'azure',kind:'subscription',nativeId:c.name,scope:c.name});
    else{const id=`azure:mg:${c.name}`;nodes.push({id,parent,name:c.displayName??c.name,provider:'azure',kind:'managementGroup',nativeId:c.name});walk(c.children,id);}
  }};
  walk(root.properties?.children,rootId);
  return nodes;
}
async function azureDisplayNames(ids:string[],graphToken:(()=>Promise<string>)|undefined,request:typeof fetch){
  const names=new Map<string,string>();if(!graphToken)return names;
  for(let i=0;i<ids.length;i+=1000){const r=await request('https://graph.microsoft.com/v1.0/directoryObjects/getByIds',{method:'POST',headers:{Authorization:`Bearer ${await graphToken()}`,'Content-Type':'application/json'},body:JSON.stringify({ids:ids.slice(i,i+1000),types:['user','group','servicePrincipal']}),signal:AbortSignal.timeout(30_000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);for(const o of (await r.json()).value??[])names.set(String(o.id).toLowerCase(),o.userPrincipalName??o.displayName??o.id);}
  return names;
}
export async function azureCost(subscriptions:string[],token:()=>Promise<string>,request:typeof fetch=fetch,now=new Date(),onScope:(done:number,total:number)=>void=()=>{}):Promise<{rows:CostRow[];failed:string[]}>{
  const {start,end}=costWindow(now),rows:CostRow[]=[],failed:string[]=[];let done=0;
  for(const sub of subscriptions){
    onScope(done++,subscriptions.length);
    const r=await request(`https://management.azure.com/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,{method:'POST',headers:{Authorization:`Bearer ${await token()}`,'Content-Type':'application/json'},body:JSON.stringify({type:'ActualCost',timeframe:'Custom',timePeriod:{from:start,to:end},dataset:{granularity:'Monthly',aggregation:{totalCost:{name:'Cost',function:'Sum'}},grouping:[{type:'Dimension',name:'ServiceName'}]}}),signal:AbortSignal.timeout(60_000)});
    if(!r.ok){failed.push(sub);continue;}
    const body=await r.json(),cols=(body.properties?.columns??[]).map((c:any)=>c.name),at=(n:string)=>cols.indexOf(n);
    for(const row of body.properties?.rows??[])rows.push({provider:'azure',scope:sub,service:row[at('ServiceName')]??'기타',month:String(row[at('BillingMonth')]).slice(0,7),amount:Number(row[at('Cost')]),currency:row[at('Currency')]??'USD'});
  }
  return{rows,failed};
}
// Activity Log keeps writes, deletes and actions per subscription; only the final Succeeded/Failed record of each operation is kept.
export async function azureActivity(subscriptions:string[],token:()=>Promise<string>,request:typeof fetch=fetch,now=new Date()):Promise<Activity[]>{
  const out:Activity[]=[],since=activitySince(now).toISOString();
  for(const sub of subscriptions){
    const filter=encodeURIComponent(`eventTimestamp ge '${since}' and eventTimestamp le '${now.toISOString()}'`);
    let url:string|undefined=`https://management.azure.com/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01&$filter=${filter}&$select=eventTimestamp,caller,operationName,resourceId,status,eventDataId,httpRequest,claims`;let kept=0;
    while(url&&kept<ACTIVITY_CAP){
      const r:Response=await request(url,{headers:{Authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(60_000)});if(!r.ok)throw new Error(`Activity Log 조회 실패 (${r.status})`);
      const body:any=await r.json();
      for(const e of body.value??[]){
        const op=String(e.operationName?.value??''),status=String(e.status?.value??'');
        if(!/\/(write|delete|action)$/i.test(op)||!/^(Succeeded|Failed)$/i.test(status))continue;
        const caller=String(e.caller??''),target=String(e.resourceId??'');
        out.push({id:`azure:${e.eventDataId}`,provider:'azure',at:e.eventTimestamp,actor:caller||e.claims?.name||'알 수 없음',actorType:caller.includes('@')?'user':caller?'service':'unknown',operation:op,label:e.operationName?.localizedValue??op,kind:/delete$/i.test(op)?'delete':/action$/i.test(op)?'action':'write',target:`azure:${target.toLowerCase()}`,targetName:lastSegment(target),scope:sub,outcome:/failed/i.test(status)?'failed':'ok',ip:e.httpRequest?.clientIpAddress,source:'Azure Activity Log'});kept++;
      }
      url=body.nextLink;
    }
  }
  return out;
}
export async function collectAzureWith(subscriptions:string[],token:()=>Promise<string>,request:typeof fetch=fetch,options:CollectOptions&{graphToken?:()=>Promise<string>}={}):Promise<Normalized>{
  // Explicit scope checks prevent ARG silently succeeding with only some subscriptions.
  const labels:Record<string,string>={},tenantIds=new Set<string>(),readable:string[]=[],warnings:string[]=[],report=options.report??noReport;let checked=0;
  for(const sub of subscriptions){report('scopes',{detail:'구독 접근 확인',done:checked++,total:subscriptions.length});const r=await request(`https://management.azure.com/subscriptions/${encodeURIComponent(sub)}?api-version=2022-12-01`,{headers:{Authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(30_000)});if(!r.ok){warnings.push(`Azure 구독 ${sub}: 접근 확인 실패 (${r.status}), 건너뜁니다.`);continue;}readable.push(sub);const body=await r.json();labels[sub]=body.displayName??sub;if(body.tenantId)tenantIds.add(body.tenantId);}
  if(!readable.length)throw new Error(warnings[0]??'Azure: 읽을 수 있는 구독이 없습니다.');
  report('scopes',{state:'done',detail:`구독 ${readable.length}개`});report('resources',{detail:'Resource Graph 조회'});
  const part=normalizeAzure(await azurePages(readable,token,request,AZURE_RESOURCES,n=>report('resources',{detail:`자원 ${count(n)}개 읽음`})),labels);
  report('resources',{state:'done',detail:`자원 ${count(part.resources.length)}개`});
  part.warnings.push(...warnings);part.incomplete=subscriptions.filter(x=>!readable.includes(x));
  if(tenantIds.size>1)part.warnings.push(`Azure: 구독이 ${tenantIds.size}개 테넌트에 걸쳐 있어 첫 테넌트의 관리 그룹만 표시합니다.`);
  try{part.hierarchy=await azureHierarchy(token,request,[...tenantIds][0]);}catch(e){part.warnings.push(`Azure: 관리 그룹을 읽지 못해 구독을 평면으로 표시합니다 (${e instanceof Error?e.message:'오류'}).`);}
  report('iam',{detail:'역할 할당 조회'});
  try{
    const rows=await azurePages(readable,token,request,AZURE_IAM),ids=[...new Set(rows.filter(r=>r.type.toLowerCase().endsWith('roleassignments')).map(r=>String(r.properties?.principalId).toLowerCase()))];
    let names=new Map<string,string>();
    try{names=await azureDisplayNames(ids,options.graphToken,request);}catch{part.warnings.push('Azure: Microsoft Graph 조회 권한이 없어 IAM 주체를 ID로 표시합니다.');}
    part.iam=normalizeAzureIam(rows,names);report('iam',{state:'done',detail:`할당 ${count(part.iam.length)}건`});
  }catch(e){part.warnings.push(`Azure: 역할 할당을 읽지 못했습니다 (${(e as Error)?.message?.slice(0,100)}).`);report('iam',{state:'failed',detail:'권한을 확인하세요'});}
  if(options.withActivity!==false){report('activity',{detail:'Activity Log 조회'});try{part.activity=await azureActivity(readable,token,request);report('activity',{state:'done',detail:`${count(part.activity.length)}건`});}catch(e){part.warnings.push(`Azure: 변경 기록(Activity Log)을 읽지 못했습니다 (${(e as Error)?.message?.slice(0,100)}).`);report('activity',{state:'failed',detail:'Reader 권한을 확인하세요'});}}else report('activity',{state:'skipped'});
  if(options.withCost!==false){try{const {rows,failed}=await azureCost(readable,token,request,undefined,(done,total)=>report('cost',{detail:'Cost Management 조회',done,total}));part.cost=rows;if(failed.length)part.warnings.push(`Azure: 구독 ${failed.length}개의 비용을 읽지 못했습니다. Cost Management Reader 권한을 확인하세요.`);report('cost',failed.length?{state:'failed',detail:`구독 ${failed.length}개 실패, 권한을 확인하세요`}:{state:'done',detail:`${count(rows.length)}행`});}catch(e){part.warnings.push(`Azure: 비용을 읽지 못했습니다 (${(e as Error)?.message?.slice(0,100)}).`);report('cost',{state:'failed',detail:'권한을 확인하세요'});}}
  const result=finish([part]);result.warnings.push('Azure: 보이는 지원 자원만 수집. 구독 내부 리소스별 접근 제한과 Resource Graph 반영 지연은 별도 확인 필요.');return result;
}
// Everything the signed-in identity can see, so nobody has to type subscription IDs.
// Sign-in passing says nothing about roles or the network path to ARM, so each failure here names its own fix.
export async function discoverAzureSubscriptions(token:()=>Promise<string>,request:typeof fetch=fetch){
  const found:string[]=[],inactive:string[]=[];let url:string|undefined='https://management.azure.com/subscriptions?api-version=2022-12-01';
  while(url){
    let r:Response;
    try{r=await request(url,{headers:{Authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(30_000)});}catch(e){throw new Error(azureNetworkMessage(e));}
    if(!r.ok){const body:any=await r.json().catch(()=>({}));throw new Error(azureListMessage(r.status,body?.error));}
    const body:any=await r.json();
    for(const s of body.value??[])s.state==='Enabled'?found.push(s.subscriptionId):inactive.push(s.state);
    url=body.nextLink;
  }
  if(!found.length)throw new Error(inactive.length?`Azure: 구독 ${inactive.length}개가 보이지만 활성 상태가 아닙니다 (${[...new Set(inactive)].join(', ')}).`:'Azure: 로그인은 됐지만 이 서비스 주체에 역할이 할당된 구독이 없습니다. 구독이나 테넌트 루트 관리 그룹에 Reader 역할을 할당하세요. 할당 직후에는 반영까지 몇 분 걸릴 수 있습니다.');
  return found;
}
function azureNetworkMessage(e:unknown){
  const err=e as any,code=err?.cause?.code??err?.code??(err?.name==='TimeoutError'?'시간 초과':err?.message);
  if(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(code)))return `Azure: management.azure.com 인증서를 신뢰하지 못했습니다 (${code}). 사내 TLS 검사가 있으면 셸에서 NODE_EXTRA_CA_CERTS에 회사 루트 인증서 경로를 지정하세요.`;
  return `Azure: management.azure.com에 연결하지 못했습니다 (${code}). 프록시를 거쳐야 하는 네트워크면 HTTPS_PROXY를 설정하세요.`;
}
function azureListMessage(status:number,error?:{code?:string;message?:string}){
  const detail=[error?.code,error?.message?.split('\n')[0].slice(0,160)].filter(Boolean).join(': ');
  if(status===401)return `Azure 구독 목록 조회를 거부했습니다 (401${detail?` ${detail}`:''}). AZURE_TENANT_ID가 구독이 있는 테넌트인지 확인하세요.`;
  if(status===403)return `Azure 구독 목록을 읽을 권한이 없습니다 (403${detail?` ${detail}`:''}). 서비스 주체에 Reader 역할을 할당하세요.`;
  return `Azure 구독 목록 조회 실패 (${status}${detail?` ${detail}`:''})`;
}
export async function collectAzure(subscriptions:string[]=[],options:CollectOptions={}):Promise<Normalized>{
  const {DefaultAzureCredential}=await import('@azure/identity');const credential=new DefaultAzureCredential(),token=async()=>(await credential.getToken('https://management.azure.com/.default')).token;
  options.report?.('scopes',{detail:'구독 목록 조회'});
  const targets=subscriptions.length?subscriptions:await discoverAzureSubscriptions(token);
  return collectAzureWith(targets,token,fetch,{...options,graphToken:async()=>(await credential.getToken('https://graph.microsoft.com/.default')).token});
}
// Management events from CloudTrail's free 90-day history; read-only calls are filtered out at the source.
export async function collectAwsActivity(call:AwsCaller,account:string,region:string,now=new Date()):Promise<Activity[]>{
  const out:Activity[]=[];let token:string|undefined;
  do{
    const r=await call('trail','LookupEvents',{LookupAttributes:[{AttributeKey:'ReadOnly',AttributeValue:'false'}],StartTime:activitySince(now),EndTime:now,MaxResults:50,...(token?{NextToken:token}:{})});
    for(const e of r.Events??[]){
      let detail:any={};try{detail=JSON.parse(e.CloudTrailEvent??'{}');}catch{/* summary fields still work */}
      const name=String(e.EventName??''),res=e.Resources?.[0],who=detail.userIdentity?.arn??e.Username??'알 수 없음',type=String(detail.userIdentity?.type??'');
      out.push({id:`aws:${e.EventId}`,provider:'aws',at:new Date(e.EventTime).toISOString(),actor:who,actorType:/IAMUser|Root/.test(type)||/assumed-role\/[^/]+\/[^/]*@|user\//.test(who)?'user':type?'service':'unknown',operation:name,label:`${String(detail.eventSource??'').replace('.amazonaws.com','')} ${name}`.trim(),kind:/^(Delete|Terminate|Revoke|Remove|Detach|Disassociate)/.test(name)?'delete':/^(Create|Put|Modify|Update|Authorize|Attach|Associate|Run|Set|Replace|Add|Enable|Disable)/.test(name)?'write':'action',target:res?.ResourceName?`aws:${res.ResourceName}`:'',targetName:res?.ResourceName??detail.eventSource??'',scope:account,outcome:detail.errorCode?'failed':'ok',ip:detail.sourceIPAddress,source:`AWS CloudTrail · ${region}`});
    }
    token=r.NextToken;
  }while(token&&out.length<ACTIVITY_CAP/4);
  return out;
}
type AwsService='ec2'|'elb'|'rds'|'dx'|'eks'|'org'|'iam'|'ce'|'rex'|'trail';
export type AwsCaller=(service:AwsService,operation:string,input?:Record<string,any>)=>Promise<any>;
async function awsPages(call:AwsCaller,service:AwsService,operation:string,key:string,input:Record<string,any>={},tokenIn='NextToken',tokenOut='NextToken'){
  const out:any[]=[],seen=new Set<string>();let token:string|undefined;
  do{const response=await call(service,operation,{...input,...(token?{[tokenIn]:token}:{})});out.push(...(response[key]??[]));token=response[tokenOut];if(token){if(seen.has(token))throw new Error('AWS: repeated pagination token');seen.add(token);}}while(token);
  return out;
}
const AWS_AUTH_ERROR=/ExpiredToken|InvalidClientTokenId|CredentialsProviderError|Could not load credentials/i;
// A service missing from a region is normal, not a gap in what was collected.
const AWS_UNAVAILABLE=/ENOTFOUND|UnknownEndpoint|getaddrinfo|not available in this region|UnsupportedOperation/i;
export async function collectAwsAccount(call:AwsCaller,account:string,region:string,label?:string):Promise<Normalized>{
  const data:Record<string,any[]>={},paged={MaxResults:100},failed:string[]=[];
  // One denied service must not cost the whole account; only a dead credential stops the run.
  const read=async<T>(what:string,work:()=>Promise<T>,empty:T):Promise<T>=>{
    try{return await work();}catch(e){const text=`${(e as Error)?.name} ${(e as Error)?.message}`;if(AWS_AUTH_ERROR.test(text))throw e;if(!AWS_UNAVAILABLE.test(text))failed.push(what);return empty;}
  };
  for(const [operation,key] of [['DescribeVpcs','Vpcs'],['DescribeSubnets','Subnets'],['DescribeInstances','Reservations'],['DescribeSecurityGroups','SecurityGroups'],['DescribeInternetGateways','InternetGateways'],['DescribeNatGateways','NatGateways'],['DescribeTransitGateways','TransitGateways'],['DescribeTransitGatewayVpcAttachments','TransitGatewayVpcAttachments'],['DescribeTransitGatewayPeeringAttachments','TransitGatewayPeeringAttachments'],['DescribeVpcPeeringConnections','VpcPeeringConnections'],['DescribeRouteTables','RouteTables']] as const)data[key]=await read(operation,()=>awsPages(call,'ec2',operation,key,paged),[]);
  // These two operations take no MaxResults and return everything at once.
  data.VpnGateways=await read('DescribeVpnGateways',async()=>(await call('ec2','DescribeVpnGateways')).VpnGateways??[],[]);
  data.VpnConnections=await read('DescribeVpnConnections',async()=>(await call('ec2','DescribeVpnConnections')).VpnConnections??[],[]);
  const types=[...new Set(data.Reservations.flatMap(r=>r.Instances??[]).map(r=>r.InstanceType))];data.InstanceTypes=[];
  for(let i=0;i<types.length;i+=100)data.InstanceTypes.push(...await read('DescribeInstanceTypes',()=>awsPages(call,'ec2','DescribeInstanceTypes','InstanceTypes',{InstanceTypes:types.slice(i,i+100)}),[]));
  data.LoadBalancers=await read('DescribeLoadBalancers',()=>awsPages(call,'elb','DescribeLoadBalancers','LoadBalancers',{},'Marker','NextMarker'),[]);
  for(const lb of data.LoadBalancers){
    lb.Targets=[];
    for(const group of await read('DescribeTargetGroups',()=>awsPages(call,'elb','DescribeTargetGroups','TargetGroups',{LoadBalancerArn:lb.LoadBalancerArn},'Marker','NextMarker'),[]))if(group.TargetType==='instance')lb.Targets.push(...await read('DescribeTargetHealth',async()=>((await call('elb','DescribeTargetHealth',{TargetGroupArn:group.TargetGroupArn})).TargetHealthDescriptions??[]).map((t:any)=>t.Target.Id),[]));
  }
  data.DBInstances=await read('DescribeDBInstances',()=>awsPages(call,'rds','DescribeDBInstances','DBInstances',{},'Marker','Marker'),[]);
  data.DirectConnectGateways=await read('DescribeDirectConnectGateways',()=>awsPages(call,'dx','DescribeDirectConnectGateways','directConnectGateways',{},'nextToken','nextToken'),[]);
  for(const gateway of data.DirectConnectGateways)gateway.associations=(await read('DescribeDirectConnectGatewayAssociations',()=>awsPages(call,'dx','DescribeDirectConnectGatewayAssociations','directConnectGatewayAssociations',{directConnectGatewayId:gateway.directConnectGatewayId},'nextToken','nextToken'),[])).filter((a:any)=>a.directConnectGatewayId===gateway.directConnectGatewayId);
  data.Clusters=[];
  for(const name of await read('ListClusters',()=>awsPages(call,'eks','ListClusters','clusters',{},'nextToken','nextToken'),[])){const cluster=await read('DescribeCluster',async()=>(await call('eks','DescribeCluster',{name})).cluster,undefined);if(cluster)data.Clusters.push(cluster);}
  const result=normalizeAws(data,account,region,label);
  if(failed.length){result.incomplete=[account];result.warnings.push(`AWS ${label??account} ${region}: 권한이나 설정 때문에 읽지 못한 항목: ${[...new Set(failed)].join(', ')}`);}
  return result;
}
// IAM is global, so it is read once per account rather than once per region.
export async function collectAwsIam(call:AwsCaller,account:string):Promise<{iam:IamAssignment[];warning?:string}>{
  try{
    const list=(op:string,key:string,input:Record<string,any>={})=>awsIamPages(call,op,key,input);
    const users=await list('ListUsers','Users');
    for(const u of users){
      u.policies=await list('ListAttachedUserPolicies','AttachedPolicies',{UserName:u.UserName});
      u.groupPolicies=[];for(const g of await list('ListGroupsForUser','Groups',{UserName:u.UserName}))u.groupPolicies.push(...(await list('ListAttachedGroupPolicies','AttachedPolicies',{GroupName:g.GroupName})).map((x:any)=>({...x,group:g.GroupName})));
      u.mfa=(await list('ListMFADevices','MFADevices',{UserName:u.UserName})).length>0;
      u.keys=await list('ListAccessKeys','AccessKeyMetadata',{UserName:u.UserName});
    }
    const roles=(await list('ListRoles','Roles')).filter(r=>!String(r.Path??'').startsWith('/aws-service-role/'));
    for(const r of roles)r.policies=await list('ListAttachedRolePolicies','AttachedPolicies',{RoleName:r.RoleName});
    return{iam:normalizeAwsIam({users,roles},account)};
  }catch(e){return{iam:[],warning:`AWS 계정 ${account}: IAM을 읽지 못했습니다 (${(e as Error)?.name}).`};}
}
async function awsIamPages(call:AwsCaller,op:string,key:string,input:Record<string,any>){
  const out:any[]=[];let marker:string|undefined;
  do{const r=await call('iam',op,{...input,...(marker?{Marker:marker}:{})});out.push(...(r[key]??[]));marker=r.IsTruncated?r.Marker:undefined;}while(marker);
  return out;
}
// One request per page, and Cost Explorer bills per request. The runner limits how often this runs.
export async function collectAwsCost(call:AwsCaller,now=new Date()):Promise<CostRow[]>{
  const {start,end}=costWindow(now),rows:CostRow[]=[];let token:string|undefined;
  do{
    const r=await call('ce','GetCostAndUsage',{TimePeriod:{Start:start,End:end},Granularity:'MONTHLY',Metrics:['UnblendedCost'],GroupBy:[{Type:'DIMENSION',Key:'LINKED_ACCOUNT'},{Type:'DIMENSION',Key:'SERVICE'}],...(token?{NextPageToken:token}:{})});
    for(const period of r.ResultsByTime??[])for(const g of period.Groups??[])rows.push({provider:'aws',scope:g.Keys[0],service:g.Keys[1],month:String(period.TimePeriod.Start).slice(0,7),amount:Number(g.Metrics.UnblendedCost.Amount),currency:g.Metrics.UnblendedCost.Unit??'USD'});
    token=r.NextPageToken;
  }while(token);
  return rows;
}
// Types the Describe collectors already read in full; everything else comes from Resource Explorer as a plain list.
const AWS_DESCRIBED=new Set(['ec2:instance','ec2:vpc','ec2:subnet','ec2:security-group','ec2:internet-gateway','ec2:natgateway','ec2:transit-gateway','ec2:transit-gateway-attachment','ec2:vpn-connection','ec2:vpn-gateway','ec2:vpc-peering-connection','ec2:route-table','ec2:network-interface','ec2:network-acl','elasticloadbalancing:loadbalancer','elasticloadbalancing:loadbalancer/app','elasticloadbalancing:loadbalancer/net','rds:db','eks:cluster']);
export async function collectAwsInventory(call:AwsCaller):Promise<{rows:any[];warning?:string}>{
  try{return{rows:(await awsPages(call,'rex','ListResources','Resources',{MaxResults:100})).filter(r=>!AWS_DESCRIBED.has(r.ResourceType))};}
  catch(e){return{rows:[],warning:`AWS: Resource Explorer를 읽지 못해 S3, Lambda 같은 나머지 서비스는 인벤토리에서 빠집니다 (${(e as Error)?.name}). 조직 인덱스를 켜면 함께 수집합니다.`};}
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
async function mapLimit<T,R>(items:T[],limit:number,work:(item:T)=>Promise<R>){
  const out:R[]=[];let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await work(items[i]);}}));
  return out;
}
const AWS_HOME_REGION=()=>process.env.AWS_REGION??process.env.AWS_DEFAULT_REGION??'us-east-1';
export const accountRoles=(accounts:{id:string;name:string}[],roleName:string):AwsRole[]=>accounts.map(a=>({label:a.name,roleArn:`arn:aws:iam::${a.id}:role/${roleName}`}));
export const parseAccounts=(value:string|undefined)=>(value??'').split(',').map(x=>x.trim()).filter(Boolean).map(x=>{const [name,id=name]=x.split('=');return{id:id.trim(),name:name.trim()};});
// With ATLAS_AWS_ROLE_NAME the signed-in identity only jumps: it reads the org and assumes a read role in each account, and needs no read rights of its own. Without it, the signed-in account is read directly.
export async function collectAws(regions:string[]=[],roles:AwsRole[]=[],options:CollectOptions={}):Promise<Normalized>{
  const [ec2,sts,elb,rds,dx,eks,org,iam,ce,rex,trail]=await Promise.all([import('@aws-sdk/client-ec2'),import('@aws-sdk/client-sts'),import('@aws-sdk/client-elastic-load-balancing-v2'),import('@aws-sdk/client-rds'),import('@aws-sdk/client-direct-connect'),import('@aws-sdk/client-eks'),import('@aws-sdk/client-organizations'),import('@aws-sdk/client-iam'),import('@aws-sdk/client-cost-explorer'),import('@aws-sdk/client-resource-explorer-2'),import('@aws-sdk/client-cloudtrail')]);
  const parts:Normalized[]=[],home=AWS_HOME_REGION(),warnings:string[]=[],incomplete:string[]=[],report=options.report??noReport;let hierarchy:HierarchyNode[]|undefined,identities=1,finishedIdentities=0,regionsDone=0;
  const single=async(module:any,Client:string,region:string,credentials:any,operation:string,input:any)=>{const client=new module[Client]({region,maxAttempts:3,credentials});try{return await client.send(new module[`${operation}Command`](input));}finally{client.destroy();}};
  const account=async(credentials:any)=>{const {Account}=await single(sts,'STSClient',home,credentials,'GetCallerIdentity',{});if(!Account)throw new Error('AWS 계정 ID를 확인할 수 없습니다.');return Account as string;};
  const readOrg=async(credentials:any)=>{if(hierarchy)return;const client=new org.OrganizationsClient({region:'us-east-1',maxAttempts:3,credentials});try{hierarchy=await awsHierarchy((_s,operation,input={})=>client.send(new (org as any)[`${operation}Command`](input)) as Promise<any>);}catch{/* member account: reported below if nothing could read the org */}client.destroy();};
  const collectIdentity=async(credentials:any,id:string,label?:string)=>{
    let targets=regions;
    if(!targets.length)targets=((await single(ec2,'EC2Client',home,credentials,'DescribeRegions',{AllRegions:false})).Regions??[]).map((r:any)=>r.RegionName).filter(Boolean);
    const who=label??id,regionTotal=targets.length*identities;
    parts.push(...await mapLimit(targets,4,async region=>{
      report('resources',{detail:`${who} · ${region}`,done:regionsDone,total:regionTotal});
      const options={region,maxAttempts:3,credentials},clients={ec2:new ec2.EC2Client(options),elb:new elb.ElasticLoadBalancingV2Client(options),rds:new rds.RDSClient(options),dx:new dx.DirectConnectClient(options),eks:new eks.EKSClient(options)},modules:Record<string,any>={ec2,elb,rds,dx,eks};
      const call:AwsCaller=(service,operation,input={})=>(clients as any)[service].send(new modules[service][`${operation}Command`](input));
      try{return await collectAwsAccount(call,id,region,label);}finally{regionsDone++;for(const client of Object.values(clients))client.destroy();}
    }));
    report('iam',{detail:who,done:finishedIdentities,total:identities});
    const {iam:assignments,warning}=await collectAwsIam((_s,operation,input={})=>single(iam,'IAMClient','us-east-1',credentials,operation,input),id);
    finishedIdentities++;report('iam',{done:finishedIdentities,total:identities});report('resources',{detail:`${who} · 나머지 서비스 목록`});
    const inventory=await collectAwsInventory((_s,operation,input={})=>single(rex,'ResourceExplorer2Client',home,credentials,operation,input));
    // IAM and other global services log to us-east-1, so it is always read alongside the collected regions.
    const activity:Activity[]=[],activityWarnings:string[]=[];
    if(options.withActivity!==false){report('activity',{detail:`${who} · CloudTrail`});for(const region of [...new Set([...targets,'us-east-1'])]){try{activity.push(...await collectAwsActivity((_s,operation,input={})=>single(trail,'CloudTrailClient',region,credentials,operation,input),id,region));}catch(e){activityWarnings.push(`AWS 계정 ${who} ${region}: 변경 기록(CloudTrail)을 읽지 못했습니다 (${(e as Error)?.name}).`);}}}
    parts.push({resources:[],links:[],warnings:[...(warning?[warning]:[]),...(inventory.warning?[inventory.warning]:[]),...activityWarnings.slice(0,3)],scopeLabels:{},iam:assignments,activity,awsInventory:{account:id,rows:inventory.rows}} as Normalized);
  };
  const assume=async(role:AwsRole,required=true)=>{
    const id=role.roleArn.match(/::(\d+):/)?.[1]??role.label;
    try{const {Credentials:c}=await single(sts,'STSClient',home,undefined,'AssumeRole',{RoleArn:role.roleArn,RoleSessionName:'cloud-atlas-reader',DurationSeconds:3600});if(!c)throw new Error('자격 증명 없음');await collectIdentity({accessKeyId:c.AccessKeyId,secretAccessKey:c.SecretAccessKey,sessionToken:c.SessionToken},id,role.label);}
    catch(e){warnings.push(`AWS 계정 ${role.label}: 역할을 맡지 못해 건너뜁니다 (${(e as Error)?.name}).`);if(required)incomplete.push(id);}
  };
  report('scopes',{detail:'조직 구조 확인'});
  await readOrg(undefined);
  const current=await account(undefined),roleName=process.env.ATLAS_AWS_ROLE_NAME,listed=parseAccounts(process.env.ATLAS_AWS_ACCOUNTS),orgAccounts=(hierarchy??[]).filter(n=>n.kind==='account').map(n=>({id:n.scope!,name:n.name})),accounts=listed.length?listed:orgAccounts;
  const orgRoles=roleName&&!roles.length?accountRoles(accounts.some(a=>a.id===current)?accounts:[...accounts,{id:current,name:current}],roleName):[];
  identities=roles.length||orgRoles.length||1;report('scopes',{state:'done',detail:`계정 ${identities}개`});report('resources',{detail:'리전 확인',done:0,total:identities});
  if(roles.length)for(const role of roles)await assume(role);
  else if(roleName){
    // StackSets skip the management account, so a missing role there is expected and does not make the collection partial.
    for(const role of orgRoles)await assume(role,!role.roleArn.includes(`::${current}:`));
  }else{
    await collectIdentity(undefined,current);
    const others=accounts.filter(a=>a.id!==current).length;
    if(others)warnings.push(`AWS: 조직의 다른 계정 ${others}개는 미수집입니다. 각 계정의 읽기 전용 역할 이름을 ATLAS_AWS_ROLE_NAME에 지정하면 함께 수집합니다.`);
  }
  report('resources',{state:'done',detail:`계정 ${identities}개 · 리전 ${regionsDone}개`});report('iam',{state:'done',detail:`계정 ${finishedIdentities}개`});
  report('activity',options.withActivity===false?{state:'skipped'}:{state:'done',detail:`${count(parts.reduce((n,p)=>n+(p.activity?.length??0),0))}건`});
  if(!hierarchy&&!listed.length)warnings.push('AWS: Organizations를 읽지 못해 계정을 평면으로 표시합니다. 관리 계정 또는 위임 관리자 권한이 필요합니다.');
  let cost:CostRow[]|undefined;
  if(options.withCost!==false){report('cost',{detail:'Cost Explorer 조회'});try{cost=await collectAwsCost((_s,operation,input={})=>single(ce,'CostExplorerClient','us-east-1',undefined,operation,input));report('cost',{state:'done',detail:`${count(cost.length)}행`});}catch(e){warnings.push(`AWS: 비용을 읽지 못했습니다 (${(e as Error)?.name}). 조직 전체 비용은 관리 계정의 ce:GetCostAndUsage 권한이 필요합니다.`);report('cost',{state:'failed',detail:'ce:GetCostAndUsage 권한을 확인하세요'});}}
  return finish([...parts,{resources:[],links:[],warnings,scopeLabels:{},hierarchy,incomplete,cost}]);
}
// REST fallback avoids protobuf Struct conversion ambiguity for resource.data.
export type GcpRequest=(url:string,init?:{method:string;data:unknown})=>Promise<any>;
export async function gcpPages(parent:string,request:GcpRequest,types:string[]=[],contentType='RESOURCE',onRows:(total:number)=>void=()=>{}){
  const assets:Record<string,any>[]=[],seen=new Set<string>();let next:string|undefined,readTime:string|undefined;
  do{const q=new URLSearchParams({contentType,pageSize:'1000'});types.forEach(t=>q.append('assetTypes',t));if(next)q.set('pageToken',next);if(readTime)q.set('readTime',readTime);
    const body=await request(`https://cloudasset.googleapis.com/v1/${parent}/assets?${q}`);if(!Array.isArray(body.assets)&&body.assets!==undefined)throw new Error('GCP: invalid assets response');assets.push(...body.assets??[]);onRows(assets.length);readTime=body.readTime??readTime;next=body.nextPageToken;if(next){if(seen.has(next))throw new Error('GCP: repeated pagination token');seen.add(next);}
  }while(next);return assets;
}
const GCP_HIERARCHY_TYPES=['Organization','Folder','Project'].map(t=>`cloudresourcemanager.googleapis.com/${t}`);
async function gcpHierarchy(parent:string,request:GcpRequest,projectNumbers:Map<string,string>,org:{domain?:string}){
  const nodes:HierarchyNode[]=[];
  for(const a of await gcpPages(parent,request,GCP_HIERARCHY_TYPES)){
    const d=a.resource?.data??{};
    if(d.projectNumber&&d.projectId)projectNumbers.set(String(d.projectNumber),d.projectId);
    if(a.assetType.endsWith('/Organization'))org.domain=d.displayName;
    if(a.assetType.endsWith('/Organization'))nodes.push({id:`gcp:${d.name}`,name:d.displayName??d.name,provider:'gcp',kind:'organization',nativeId:d.name});
    else if(a.assetType.endsWith('/Folder'))nodes.push({id:`gcp:${d.name}`,parent:`gcp:${d.parent}`,name:d.displayName??d.name,provider:'gcp',kind:'folder',nativeId:d.name});
    else nodes.push({id:scopeNodeId('gcp',d.projectId),parent:d.parent?`gcp:${d.parent.type}s/${d.parent.id}`:undefined,name:d.name??d.projectId,provider:'gcp',kind:'project',nativeId:d.projectId,scope:d.projectId});
  }
  // A parent outside the listed range (for example, a folder-scoped collection) becomes a root rather than dangling.
  const known=new Set(nodes.map(n=>n.id));for(const n of nodes)if(n.parent&&!known.has(n.parent))delete n.parent;
  return nodes;
}
// Billing has no read API with costs in it: this reads the BigQuery export, which the org must have turned on. Queries scan bytes, so the runner limits how often this runs.
export async function collectGcpCost(request:GcpRequest,table:string,now=new Date()):Promise<CostRow[]>{
  if(!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(table))throw new Error('ATLAS_GCP_BILLING_TABLE은 project.dataset.table 형식이어야 합니다.');
  const {start}=costWindow(now),project=table.split('.')[0];
  const query=`SELECT invoice.month AS month, project.id AS project, service.description AS service, currency, SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS amount FROM \`${table}\` WHERE usage_start_time >= TIMESTAMP('${start}') AND project.id IS NOT NULL GROUP BY 1, 2, 3, 4`;
  const body=await request(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`,{method:'POST',data:{query,useLegacySql:false,timeoutMs:60_000,maxResults:50_000}});
  if(!body.jobComplete)throw new Error('BigQuery 조회가 제한 시간 안에 끝나지 않았습니다.');
  return (body.rows??[]).map((r:any)=>{const [month,scope,service,currency,amount]=r.f.map((c:any)=>c.v);return{provider:'gcp' as const,scope,service,month:`${month.slice(0,4)}-${month.slice(4,6)}`,amount:Number(amount),currency};});
}
// Admin Activity audit logs are always on and free to read; one request covers many projects at once.
export async function gcpActivity(resourceNames:string[],request:GcpRequest,now=new Date()):Promise<Activity[]>{
  const out:Activity[]=[],filter=`logName:"cloudaudit.googleapis.com%2Factivity" AND timestamp>="${activitySince(now).toISOString()}"`;
  for(let i=0;i<resourceNames.length&&out.length<ACTIVITY_CAP;i+=50){
    let token:string|undefined;
    do{
      const body=await request('https://logging.googleapis.com/v2/entries:list',{method:'POST',data:{resourceNames:resourceNames.slice(i,i+50),filter,orderBy:'timestamp desc',pageSize:1000,...(token?{pageToken:token}:{})}});
      for(const e of body.entries??[]){
        const p=e.protoPayload??{},method=String(p.methodName??''),who=String(p.authenticationInfo?.principalEmail??'');
        const project=e.resource?.labels?.project_id??String(e.logName??'').match(/^projects\/([^/]+)/)?.[1]??'';
        out.push({id:`gcp:${e.insertId}:${e.timestamp}`,provider:'gcp',at:e.timestamp,actor:who||'알 수 없음',actorType:who.endsWith('gserviceaccount.com')?'service':who?'user':'unknown',operation:method,label:`${String(p.serviceName??'').replace('.googleapis.com','')} ${method.split('.').pop()}`.trim(),kind:/\.(delete|remove)/i.test(method)?'delete':/\.(insert|create|patch|update|set|add)/i.test(method)?'write':'action',target:p.resourceName?`gcp:${p.resourceName}`:'',targetName:lastSegment(String(p.resourceName??method)),scope:project,outcome:p.status?.code?'failed':'ok',ip:p.requestMetadata?.callerIp,source:'GCP Admin Activity 감사 로그'});
      }
      token=body.nextPageToken;
    }while(token&&out.length<ACTIVITY_CAP);
  }
  return out;
}
export async function collectGcpWith(parent:string,request:GcpRequest,options:CollectOptions={}):Promise<Normalized>{
  const report=options.report??noReport;
  report('resources',{detail:parent});
  const part=normalizeGcp(await gcpPages(parent,request,[],'RESOURCE',n=>report('resources',{detail:`${parent} · 자원 ${count(n)}개 읽음`})));
  const projectNumbers=new Map<string,string>(),org:{domain?:string}={};
  if(!parent.startsWith('projects/'))try{part.hierarchy=await gcpHierarchy(parent,request,projectNumbers,org);}catch(e){part.warnings.push(`GCP: 조직 계층을 읽지 못해 프로젝트를 평면으로 표시합니다 (${e instanceof Error?e.message:'오류'}).`);}
  report('iam',{detail:parent});
  try{part.iam=normalizeGcpIam(await gcpPages(parent,request,GCP_HIERARCHY_TYPES,'IAM_POLICY'),projectNumbers,parent.startsWith('projects/')?parent.split('/')[1]:undefined,org.domain);}
  catch(e){part.warnings.push(`GCP: IAM 정책을 읽지 못했습니다 (${(e as Error)?.message?.slice(0,100)}).`);}
  if(options.withActivity!==false){
    // An organization's own log holds only org-level changes; each project keeps its own.
    const names=parent.startsWith('projects/')?[parent]:[parent,...(part.hierarchy??[]).filter(n=>n.kind==='project').map(n=>`projects/${n.nativeId}`)];
    report('activity',{detail:'감사 로그 조회'});
    try{part.activity=await gcpActivity(names,request);report('activity',{state:'done',detail:`${count(part.activity.length)}건`});}catch(e){part.warnings.push(`GCP: 변경 기록(감사 로그)을 읽지 못했습니다 (${(e as Error)?.message?.slice(0,100)}). roles/logging.viewer가 필요합니다.`);report('activity',{state:'failed',detail:'logging.viewer 권한을 확인하세요'});}
  }
  const result=finish([part]);result.warnings.push('GCP: Asset Inventory의 최종 일관성 데이터. Cloud Router 관계는 구성 참조이며 패킷 경유 경로가 아닙니다.');return result;
}
// Prefer the whole organization; an identity without org rights still gets every project it can read.
export async function discoverGcpParents(request:GcpRequest){
  const orgList:{name:string;displayName?:string}[]=await request('https://cloudresourcemanager.googleapis.com/v3/organizations:search').then(b=>b.organizations??[],()=>[]);
  const records:{projectId:string;name?:string;parent?:{type:string;id:string}}[]=[];let token:string|undefined;
  do{const q=new URLSearchParams({filter:'lifecycleState:ACTIVE'});if(token)q.set('pageToken',token);const body=await request(`https://cloudresourcemanager.googleapis.com/v1/projects?${q}`);records.push(...(body.projects??[]));token=body.nextPageToken;}while(token);
  return{orgs:orgList.map(o=>o.name),orgNames:new Map(orgList.map(o=>[o.name,o.displayName??o.name])),projects:records.map(p=>`projects/${p.projectId}`),records};
}
// Per-project collection never sees the organization, so the folder tree is rebuilt from Resource Manager.
// getAncestry needs only read access on the project itself; folder and organization names need Browser or Folder Viewer, and fall back to their IDs.
export async function gcpAncestry(records:{projectId:string;name?:string;parent?:{type:string;id:string}}[],request:GcpRequest,orgNames=new Map<string,string>()){
  const chains=new Map<string,string[]>(),missingNames:string[]=[];let denied=0;
  const queue=[...records];
  await Promise.all(Array.from({length:Math.min(8,queue.length)},async()=>{for(let p=queue.shift();p;p=queue.shift()){
    try{const body=await request(`https://cloudresourcemanager.googleapis.com/v1/projects/${p.projectId}:getAncestry`,{method:'POST',data:{}});const up=(body.ancestor??[]).map((a:any)=>a.resourceId).filter((r:any)=>r&&r.type!=='project').map((r:any)=>`${r.type}s/${r.id}`);if(up.length){chains.set(p.projectId,up);continue;}}catch{denied++;}
    // Without ancestry the project still knows its direct parent.
    if(p.parent?.id)chains.set(p.projectId,[`${p.parent.type}s/${p.parent.id}`]);
  }}));
  const names=new Map(orgNames),folderParents=new Map<string,string>();
  try{let token:string|undefined;do{const q=new URLSearchParams();if(token)q.set('pageToken',token);const body=await request(`https://cloudresourcemanager.googleapis.com/v3/folders:search?${q}`);for(const f of body.folders??[]){if(!f?.name)continue;names.set(f.name,f.displayName??f.name);if(f.parent)folderParents.set(f.name,f.parent);}token=body.nextPageToken;}while(token);}catch{/* names fall back below */}
  const ancestors=new Set([...chains.values()].flat());
  for(const id of ancestors)if(!names.has(id)){try{const body=await request(`https://cloudresourcemanager.googleapis.com/v3/${id}`);if(body?.displayName){names.set(id,body.displayName);if(body.parent)folderParents.set(id,body.parent);continue;}}catch{/* label below */}missingNames.push(id);}
  const label=(id:string)=>names.get(id)??(id.startsWith('folders/')?`폴더 ${id.slice(8)}`:`조직 ${id.slice(14)}`);
  const nodes=new Map<string,HierarchyNode>();
  for(const chain of chains.values())chain.forEach((id,i)=>{const parent=chain[i+1]??folderParents.get(id);if(!nodes.has(id))nodes.set(id,{id:`gcp:${id}`,...(parent?{parent:`gcp:${parent}`}:{}),name:label(id),provider:'gcp',kind:id.startsWith('folders/')?'folder':'organization',nativeId:id});});
  for(const p of records){const up=chains.get(p.projectId)?.[0];nodes.set(`project:${p.projectId}`,{id:scopeNodeId('gcp',p.projectId),...(up?{parent:`gcp:${up}`}:{}),name:p.name??p.projectId,provider:'gcp',kind:'project',nativeId:p.projectId,scope:p.projectId});}
  const out=[...nodes.values()],known=new Set(out.map(n=>n.id));for(const n of out)if(n.parent&&!known.has(n.parent))delete n.parent;
  const warnings:string[]=[];
  if(denied)warnings.push(`GCP: 프로젝트 ${denied}개의 상위 폴더 경로를 읽지 못했습니다. 프로젝트에 resourcemanager.projects.get 권한이 필요합니다.`);
  if(missingNames.length)warnings.push(`GCP: 폴더·조직 ${missingNames.length}개의 이름을 읽지 못해 ID로 표시합니다. 조직이나 폴더에 Browser(roles/browser) 역할을 주면 이름이 보입니다.`);
  return{nodes:out,warnings};
}
export async function collectGcpAuto(request:GcpRequest,options:CollectOptions={}):Promise<Normalized>{
  const report=options.report??noReport;report('scopes',{detail:'조직과 프로젝트 조회'});
  const {orgs,orgNames,projects,records}=await discoverGcpParents(request),parts:Normalized[]=[],warnings:string[]=[],incomplete:string[]=[];let hierarchy:HierarchyNode[]|undefined;
  report('scopes',{state:'done',detail:orgs.length?`조직 ${orgs.length}개`:`프로젝트 ${projects.length}개`});let done=0;
  for(const parent of orgs){report('resources',{done:done++,total:orgs.length});try{parts.push(await collectGcpWith(parent,request,{report}));}catch(e){warnings.push(`GCP ${parent}: 조직 범위를 읽지 못해 프로젝트별로 수집합니다 (${(e as Error)?.message?.slice(0,240)}).`);}}
  if(!parts.length){done=0;for(const parent of projects){report('resources',{done:done++,total:projects.length});try{parts.push(await collectGcpWith(parent,request,{report}));}catch(e){warnings.push(`GCP ${parent}: 읽지 못했습니다 (${(e as Error)?.message?.slice(0,240)}).`);incomplete.push(parent.split('/')[1]);}}
    if(parts.length){report('scopes',{detail:'폴더 계층 조회'});const tree=await gcpAncestry(records,request,orgNames);hierarchy=tree.nodes;warnings.push(...tree.warnings);}}
  if(!parts.length)throw new Error(warnings[0]??'GCP: 이 계정으로 볼 수 있는 조직이나 프로젝트가 없습니다.');
  report('resources',{state:'done',detail:`범위 ${parts.length}개`});report('iam',{state:'done'});
  let cost:CostRow[]|undefined;const table=process.env.ATLAS_GCP_BILLING_TABLE;
  if(options.withCost!==false){if(table){report('cost',{detail:'BigQuery 조회'});try{cost=await collectGcpCost(request,table);report('cost',{state:'done',detail:`${count(cost.length)}행`});}catch(e){warnings.push(`GCP: 비용을 읽지 못했습니다 (${(e as Error)?.message?.slice(0,120)}).`);report('cost',{state:'failed',detail:'결제 내보내기 권한을 확인하세요'});}}else{warnings.push('GCP: 비용은 BigQuery 결제 내보내기로만 읽을 수 있습니다. 테이블을 ATLAS_GCP_BILLING_TABLE에 지정하세요.');report('cost',{state:'skipped',detail:'ATLAS_GCP_BILLING_TABLE 미설정'});}}
  return finish([...parts,{resources:[],links:[],warnings,scopeLabels:{},incomplete,cost,...(hierarchy?{hierarchy}:{})}]);
}
export async function collectGcp(parent:string,options:CollectOptions={}):Promise<Normalized>{
  const {GoogleAuth}=await import('google-auth-library');const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});const client=await auth.getClient();
  return collectGcpWith(parent,async(url,init)=>{const response=await client.request({url,timeout:60_000,retryConfig:{retry:3},...(init?{method:init.method as 'POST',data:init.data}:{})});return response.data;},options);
}
