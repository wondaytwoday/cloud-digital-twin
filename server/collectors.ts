import {fetchRetry,mapLimit,positiveSetting,retry,wait,type Wait} from './async.js';
import {CostRowSchema,type CollectionGap,type CostCoverage} from '../shared/schema.js';
import { finish,normalizeAwsIam,normalizeAzure,normalizeAzureIam,normalizeAws,normalizeGcp,normalizeGcpIam,scopeNodeId,type Normalized } from './normalize.js';
import type { Activity, CostRow, HierarchyNode, IamAssignment } from '../shared/schema.js';
import {noReport,type Report} from '../shared/collect.js';
export type CollectOptions={withCost?:boolean;withActivity?:boolean;report?:Report;signal?:AbortSignal;wait?:Wait;checkpoint?:(result:Normalized)=>void};
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
export async function azurePages(subscriptions:string[],token:()=>Promise<string>,request:typeof fetch=fetch,query=AZURE_RESOURCES,onRows:(total:number)=>void=()=>{},options:Pick<CollectOptions,'signal'|'wait'>={}){
  const rows:Record<string,any>[]=[],seen=new Set<string>();let next:string|undefined;
  do{
    const response=await fetchRetry('https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01',{method:'POST',headers:{Authorization:`Bearer ${await token()}`,'Content-Type':'application/json'},body:JSON.stringify({subscriptions,query,options:{$top:1000,resultFormat:'objectArray',...(next?{$skipToken:next}:{})}})},request,{...options,timeoutMs:30_000});
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
export async function azureCost(subscriptions:string[],token:()=>Promise<string>,request:typeof fetch=fetch,now=new Date(),onScope:(done:number,total:number)=>void=()=>{},options:Pick<CollectOptions,'signal'|'wait'>={}):Promise<{rows:CostRow[];failed:string[]}>{
  const {start,end}=costWindow(now),rows:CostRow[]=[],failed:string[]=[];
  const query=JSON.stringify({type:'ActualCost',timeframe:'Custom',timePeriod:{from:start,to:end},dataset:{granularity:'Monthly',aggregation:{totalCost:{name:'Cost',function:'Sum'}},grouping:[{type:'Dimension',name:'ServiceName'}]}});
  for(const [index,sub] of subscriptions.entries()){
    options.signal?.throwIfAborted();
    if(index)await (options.wait??wait)(500,options.signal);
    onScope(index,subscriptions.length);
    const path=`/subscriptions/${encodeURIComponent(sub)}/providers/Microsoft.CostManagement/query`;
    let url:string|undefined=`https://management.azure.com${path}?api-version=2023-11-01`;
    const scopeRows:CostRow[]=[],seen=new Set<string>();
    try{
      while(url){
        const next=new URL(url);
        if(next.origin!=='https://management.azure.com'||next.pathname.toLowerCase()!==path.toLowerCase()||next.username||next.password)throw new Error('Azure: invalid cost continuation URL');
        if(seen.has(url))throw new Error('Azure: repeated cost continuation URL');seen.add(url);
        const response=await fetchRetry(url,{method:'POST',headers:{Authorization:`Bearer ${await token()}`,'Content-Type':'application/json'},body:query},request,{...options,timeoutMs:60_000});
        if(!response.ok)throw new Error(`Azure Cost Management HTTP ${response.status}`);
        const body=await response.json(),properties=body.properties;
        if(!Array.isArray(properties?.rows)||!Array.isArray(properties?.columns))throw new Error('Azure: invalid cost response');
        const cols=properties.columns.map((c:any)=>c.name),at=(...names:string[])=>names.map(n=>cols.indexOf(n)).find(i=>i>=0)??-1;
        for(const row of properties.rows){
          const rawMonth=String(row[at('BillingMonth','Month')]),month=/^\d{8}$/.test(rawMonth)?`${rawMonth.slice(0,4)}-${rawMonth.slice(4,6)}`:rawMonth.slice(0,7);
          scopeRows.push(CostRowSchema.parse({provider:'azure',scope:sub,service:row[at('ServiceName')]??'기타',month,amount:Number(row[at('Cost','PreTaxCost')]),currency:row[at('Currency')]}));
        }
        url=properties.nextLink||undefined;
      }
      rows.push(...scopeRows);
    }catch(e){if(options.signal?.aborted)throw e;failed.push(sub);}
    onScope(index+1,subscriptions.length);
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
  const originalRequest=request;
  request=(url,init={})=>{options.signal?.throwIfAborted();return originalRequest(url,{...init,signal:options.signal&&init.signal?AbortSignal.any([options.signal,init.signal]):options.signal??init.signal});};
  // Explicit scope checks prevent ARG silently succeeding with only some subscriptions.
  const labels:Record<string,string>={},tenantIds=new Set<string>(),readable:string[]=[],warnings:string[]=[],report=options.report??noReport;let checked=0;
  for(const sub of subscriptions){report('scopes',{detail:'구독 접근 확인',done:checked++,total:subscriptions.length});const r=await request(`https://management.azure.com/subscriptions/${encodeURIComponent(sub)}?api-version=2022-12-01`,{headers:{Authorization:`Bearer ${await token()}`},signal:AbortSignal.timeout(30_000)});if(!r.ok){warnings.push(`Azure 구독 ${sub}: 접근 확인 실패 (${r.status}), 건너뜁니다.`);continue;}readable.push(sub);const body=await r.json();labels[sub]=body.displayName??sub;if(body.tenantId)tenantIds.add(body.tenantId);}
  if(!readable.length)throw new Error(warnings[0]??'Azure: 읽을 수 있는 구독이 없습니다.');
  report('scopes',{state:'done',detail:`구독 ${readable.length}개`});report('resources',{detail:'Resource Graph 조회'});
  const part=normalizeAzure(await azurePages(readable,token,request,AZURE_RESOURCES,n=>report('resources',{detail:`자원 ${count(n)}개 읽음`}),options),labels);
  report('resources',{state:'done',detail:`자원 ${count(part.resources.length)}개`});
  part.warnings.push(...warnings);part.incomplete=subscriptions.filter(x=>!readable.includes(x));
  if(tenantIds.size>1)part.warnings.push(`Azure: 구독이 ${tenantIds.size}개 테넌트에 걸쳐 있어 첫 테넌트의 관리 그룹만 표시합니다.`);
  try{part.hierarchy=await azureHierarchy(token,request,[...tenantIds][0]);}catch(e){part.warnings.push(`Azure: 관리 그룹을 읽지 못해 구독을 평면으로 표시합니다 (${e instanceof Error?e.message:'오류'}).`);}
  part.collectedScopes=[...readable];part.hierarchy??=[];
  for(const scope of readable)if(!part.hierarchy.some(n=>n.scope===scope))part.hierarchy.push({id:scopeNodeId('azure',scope),name:labels[scope]??scope,provider:'azure',kind:'subscription',nativeId:scope,scope});
  report('iam',{detail:'역할 할당 조회'});
  try{
    const rows=await azurePages(readable,token,request,AZURE_IAM,undefined,options),ids=[...new Set(rows.filter(r=>r.type.toLowerCase().endsWith('roleassignments')).map(r=>String(r.properties?.principalId).toLowerCase()))];
    let names=new Map<string,string>();
    try{names=await azureDisplayNames(ids,options.graphToken,request);}catch{part.warnings.push('Azure: Microsoft Graph 조회 권한이 없어 IAM 주체를 ID로 표시합니다.');}
    part.iam=normalizeAzureIam(rows,names);report('iam',{state:'done',detail:`할당 ${count(part.iam.length)}건`});
  }catch(e){part.iamIncomplete=[...readable];part.warnings.push(`Azure: 역할 할당을 읽지 못했습니다 (${(e as Error)?.message?.slice(0,100)}).`);report('iam',{state:'failed',detail:'권한을 확인하세요'});}
  if(options.withActivity!==false){report('activity',{detail:'Activity Log 조회'});try{part.activity=await azureActivity(readable,token,request);report('activity',{state:'done',detail:`${count(part.activity.length)}건`});}catch(e){part.warnings.push(`Azure: 변경 기록(Activity Log)을 읽지 못했습니다 (${(e as Error)?.message?.slice(0,100)}).`);report('activity',{state:'failed',detail:'Reader 권한을 확인하세요'});}}else report('activity',{state:'skipped'});
  if(options.withCost!==false){
    const {rows,failed}=await azureCost(readable,token,request,undefined,(done,total)=>report('cost',{detail:'Cost Management 조회',done,total}),options);
    const failedScopes=[...new Set([...part.incomplete,...failed])];
    part.cost=rows;part.costCoverage=[{provider:'azure',state:failedScopes.length?(failedScopes.length===subscriptions.length?'failed':'partial'):'complete',failedScopes}];
    if(failedScopes.length)part.warnings.push(`Azure: 구독 ${failedScopes.length}개의 비용 일부 누락. 속도 제한·네트워크·Cost Management Reader 권한을 확인하세요. 다음 수집에서 다시 조회합니다.`);
    report('cost',failedScopes.length?{state:'failed',detail:`구독 ${failedScopes.length}개 비용 일부 누락`}:{state:'done',detail:`${count(rows.length)}행`});
  }
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
export async function collectAwsActivity(call:AwsCaller,account:string,region:string,now=new Date(),options:Pick<CollectOptions,'signal'|'wait'>={}):Promise<Activity[]>{
  const out:Activity[]=[],seen=new Set<string>();let token:string|undefined;
  do{
    options.signal?.throwIfAborted();
    if(token)await (options.wait??wait)(500,options.signal);
    const r=await call('trail','LookupEvents',{LookupAttributes:[{AttributeKey:'ReadOnly',AttributeValue:'false'}],StartTime:activitySince(now),EndTime:now,MaxResults:50,...(token?{NextToken:token}:{})});
    for(const e of r.Events??[]){
      let detail:any={};try{detail=JSON.parse(e.CloudTrailEvent??'{}');}catch{/* summary fields still work */}
      const name=String(e.EventName??''),res=e.Resources?.[0],who=detail.userIdentity?.arn??e.Username??'알 수 없음',type=String(detail.userIdentity?.type??'');
      out.push({id:`aws:${e.EventId}`,provider:'aws',at:new Date(e.EventTime).toISOString(),actor:who,actorType:/IAMUser|Root/.test(type)||/assumed-role\/[^/]+\/[^/]*@|user\//.test(who)?'user':type?'service':'unknown',operation:name,label:`${String(detail.eventSource??'').replace('.amazonaws.com','')} ${name}`.trim(),kind:/^(Delete|Terminate|Revoke|Remove|Detach|Disassociate)/.test(name)?'delete':/^(Create|Put|Modify|Update|Authorize|Attach|Associate|Run|Set|Replace|Add|Enable|Disable)/.test(name)?'write':'action',target:res?.ResourceName?`aws:${res.ResourceName}`:'',targetName:res?.ResourceName??detail.eventSource??'',scope:account,outcome:detail.errorCode?'failed':'ok',ip:detail.sourceIPAddress,source:`AWS CloudTrail · ${region}`});
    }
    token=r.NextToken;
    if(token){if(seen.has(token))throw new Error('CloudTrail: repeated pagination token');seen.add(token);}
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
const AWS_UNAVAILABLE=/not available in this region|UnsupportedOperation|OptInRequired/i;
export async function collectAwsAccount(call:AwsCaller,account:string,region:string,label?:string):Promise<Normalized>{
  const data:Record<string,any[]>={},paged={MaxResults:100},failed:string[]=[],collectionGaps:CollectionGap[]=[];
  // One denied service must not cost the whole account; only a dead credential stops the run.
  const read=async<T>(what:string,work:()=>Promise<T>,empty:T):Promise<T>=>{
    try{return await work();}catch(e){const text=`${(e as Error)?.name} ${(e as Error)?.message}`;if(AWS_AUTH_ERROR.test(text))throw e;const unavailable=AWS_UNAVAILABLE.test(text);if(!unavailable)failed.push(what);collectionGaps.push({provider:'aws',scope:account,region,operation:what,reason:/AccessDenied|UnauthorizedOperation|Forbidden/i.test(text)?'denied':unavailable?'unavailable':'failed',code:String((e as any)?.code??(e as any)?.cause?.code??(e as Error)?.name??'Error').slice(0,80)});return empty;}
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
  result.collectionGaps=collectionGaps;
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
export async function collectAwsCost(call:AwsCaller,now=new Date(),options:Pick<CollectOptions,'signal'|'wait'>={}):Promise<CostRow[]>{
  const {start,end}=costWindow(now),rows:CostRow[]=[],seen=new Set<string>();let token:string|undefined;
  do{
    const r=await retry(()=>call('ce','GetCostAndUsage',{TimePeriod:{Start:start,End:end},Granularity:'MONTHLY',Metrics:['UnblendedCost'],GroupBy:[{Type:'DIMENSION',Key:'LINKED_ACCOUNT'},{Type:'DIMENSION',Key:'SERVICE'}],...(token?{NextPageToken:token}:{})}),options);
    for(const period of r.ResultsByTime??[])for(const g of period.Groups??[])rows.push(CostRowSchema.parse({provider:'aws',scope:g.Keys[0],service:g.Keys[1],month:String(period.TimePeriod.Start).slice(0,7),amount:Number(g.Metrics.UnblendedCost.Amount),currency:g.Metrics.UnblendedCost.Unit??'USD'}));
    token=r.NextPageToken;
    if(token){if(seen.has(token))throw new Error('AWS: repeated cost pagination token');seen.add(token);}
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
const AWS_HOME_REGION=()=>process.env.AWS_REGION??process.env.AWS_DEFAULT_REGION??'us-east-1';
export const accountRoles=(accounts:{id:string;name:string}[],roleName:string):AwsRole[]=>accounts.map(a=>({label:a.name,roleArn:`arn:aws:iam::${a.id}:role/${roleName}`}));
export const parseAccounts=(value:string|undefined)=>(value??'').split(',').map(x=>x.trim()).filter(Boolean).map(x=>{const [name,id=name]=x.split('=');return{id:id.trim(),name:name.trim()};});
// With ATLAS_AWS_ROLE_NAME the signed-in identity only jumps: it reads the org and assumes a read role in each account, and needs no read rights of its own. Without it, the signed-in account is read directly.
export type AwsRuntime={
  identity:()=>Promise<string>;
  hierarchy:()=>Promise<HierarchyNode[]>;
  assume:(role:AwsRole)=>Promise<any>;
  regions:(credentials:any)=>Promise<string[]>;
  resources:(credentials:any,account:string,region:string,label?:string)=>Promise<Normalized>;
  iam:(credentials:any,account:string)=>ReturnType<typeof collectAwsIam>;
  inventory:(credentials:any)=>ReturnType<typeof collectAwsInventory>;
  activity:(credentials:any,account:string,region:string)=>Promise<Activity[]>;
  cost:()=>Promise<CostRow[]>;
};
// The coordinator has no SDK dependency: tests exercise multi-account runs with a fake runtime.
export async function collectAwsWith(runtime:AwsRuntime,regions:string[]=[],roles:AwsRole[]=[],options:CollectOptions={}):Promise<Normalized>{
  const report=options.report??noReport,parts:Normalized[]=[],warnings:string[]=[],incomplete=new Set<string>(),completed=new Set<string>();
  let hierarchy:HierarchyNode[]|undefined,cost:CostRow[]|undefined,costCoverage:CostCoverage[]|undefined;
  report('scopes',{detail:'조직 구조 확인'});
  try{hierarchy=await runtime.hierarchy();}catch(e){options.signal?.throwIfAborted();}
  const current=await runtime.identity(),roleName=process.env.ATLAS_AWS_ROLE_NAME,listed=parseAccounts(process.env.ATLAS_AWS_ACCOUNTS);
  const accounts=listed.length?listed:(hierarchy??[]).filter(n=>n.kind==='account').map(n=>({id:n.scope!,name:n.name}));
  const orgRoles=roleName&&!roles.length?accountRoles(accounts.some(a=>a.id===current)?accounts:[...accounts,{id:current,name:current}],roleName):[];
  const targets=roles.length?roles:roleName?orgRoles:[undefined];
  const idOf=(role:AwsRole|undefined)=>role?.roleArn.match(/::(\d+):/)?.[1]??role?.label??current;
  const pending=new Set(targets.map(idOf));let regionsDone=0,accountsDone=0;
  const result=()=>({...finish([...parts,{resources:[],links:[],warnings:[...warnings],scopeLabels:{},hierarchy,incomplete:[...new Set([...incomplete,...pending])],cost,costCoverage}]),collectedScopes:[...completed]});
  const checkpoint=()=>options.checkpoint?.(result());
  report('scopes',{state:'done',detail:`계정 ${targets.length}개`});
  const accountLimit=Math.floor(positiveSetting(process.env.ATLAS_AWS_ACCOUNT_CONCURRENCY,3,8));
  const regionLimit=Math.floor(positiveSetting(process.env.ATLAS_AWS_REGION_CONCURRENCY,4,8));
  await mapLimit(targets,accountLimit,async role=>{
    const id=idOf(role),who=role?.label??id,started=Date.now();
    try{
      const credentials=role?await runtime.assume(role):undefined;
      const atRegions=regions.length?regions:await runtime.regions(credentials);
      if(!atRegions.length)throw new Error('조회할 리전이 없습니다.');
      const regional=await mapLimit(atRegions,regionLimit,async region=>{
        const begin=Date.now();report('resources',{detail:`${who} · ${region}`,done:regionsDone});
        try{return await runtime.resources(credentials,id,region,role?.label);}
        catch(e){options.signal?.throwIfAborted();return{resources:[],links:[],scopeLabels:{},incomplete:[id],warnings:[`AWS ${who} ${region}: 자원 조회 실패 (${(e as Error)?.name??'Error'})`]};}
        finally{regionsDone++;report('resources',{detail:`${who} · ${region}`,elapsedMs:Date.now()-begin,done:regionsDone});}
      },options.signal);
      parts.push(...regional);
      report('iam',{detail:who});
      const iamStart=Date.now(),assignments=await runtime.iam(credentials,id);
      report('iam',{detail:who,elapsedMs:Date.now()-iamStart});
      const inventoryStart=Date.now(),inventory=await runtime.inventory(credentials);
      report('resources',{detail:`${who} · 나머지 서비스 목록`,elapsedMs:Date.now()-inventoryStart});
      const activity:Activity[]=[],accountWarnings=[...(assignments.warning?[assignments.warning]:[]),...(inventory.warning?[inventory.warning]:[])];
      if(options.withActivity!==false){
        report('activity',{detail:`${who} · CloudTrail`});
        const activityStart=Date.now();
        await mapLimit([...new Set([...atRegions,'us-east-1'])],regionLimit,async region=>{
          try{activity.push(...await runtime.activity(credentials,id,region));}
          catch(e){options.signal?.throwIfAborted();accountWarnings.push(`AWS ${who} ${region}: 변경 기록 조회 실패 (${(e as Error)?.name??'Error'})`);}
        },options.signal);
        report('activity',{detail:`${who} · CloudTrail`,elapsedMs:Date.now()-activityStart});
      }
      if(accountWarnings.length)incomplete.add(id);
      parts.push({resources:[],links:[],warnings:accountWarnings,scopeLabels:{[id]:who},iam:assignments.iam,iamIncomplete:assignments.warning?[id]:[],activity,awsInventory:{account:id,rows:inventory.rows}});
      completed.add(id);
    }catch(e){
      options.signal?.throwIfAborted();
      // The management account often has no StackSets read role; no other account is optional.
      const optional=!!roleName&&!roles.length&&id===current;
      warnings.push(`AWS ${who}: 계정 수집 실패 (${(e as Error)?.name??'Error'})${optional?' · 관리 계정의 역할을 확인하세요':''}`);
      if(!optional)incomplete.add(id);
    }finally{
      if(!options.signal?.aborted){pending.delete(id);accountsDone++;report('resources',{detail:`계정 ${who} 완료`,done:accountsDone,total:targets.length,elapsedMs:Date.now()-started});checkpoint();}
    }
  },options.signal);
  options.signal?.throwIfAborted();
  report('resources',{state:'done',detail:`계정 ${completed.size}개 · 리전 ${regionsDone}개`});
  report('iam',{state:'done'});report('activity',options.withActivity===false?{state:'skipped'}:{state:'done'});
  if(!hierarchy&&!listed.length)warnings.push('AWS: Organizations를 읽지 못해 계정을 평면으로 표시합니다. 관리 계정 또는 위임 관리자 권한이 필요합니다.');
  if(!roles.length&&!roleName&&accounts.some(a=>a.id!==current))warnings.push('AWS: 조직의 다른 계정은 미수집입니다. ATLAS_AWS_ROLE_NAME에 읽기 전용 역할을 지정하세요.');
  if(options.withCost!==false){
    report('cost',{detail:'Cost Explorer 조회'});
    try{cost=await runtime.cost();costCoverage=[{provider:'aws',state:'complete',failedScopes:[]}];report('cost',{state:'done',detail:`${count(cost.length)}행`});}
    catch(e){options.signal?.throwIfAborted();costCoverage=[{provider:'aws',state:'failed',failedScopes:[...new Set(targets.map(idOf))]}];warnings.push('AWS: 비용 일부 누락. Cost Explorer 속도 제한·네트워크·ce:GetCostAndUsage 권한을 확인하세요. 다음 수집에서 다시 조회합니다.');report('cost',{state:'failed',detail:'비용 조회 실패'});}
  }
  return result();
}
export async function collectAws(regions:string[]=[],roles:AwsRole[]=[],options:CollectOptions={}):Promise<Normalized>{
  const [ec2,sts,elb,rds,dx,eks,org,iam,ce,rex,trail]=await Promise.all([import('@aws-sdk/client-ec2'),import('@aws-sdk/client-sts'),import('@aws-sdk/client-elastic-load-balancing-v2'),import('@aws-sdk/client-rds'),import('@aws-sdk/client-direct-connect'),import('@aws-sdk/client-eks'),import('@aws-sdk/client-organizations'),import('@aws-sdk/client-iam'),import('@aws-sdk/client-cost-explorer'),import('@aws-sdk/client-resource-explorer-2'),import('@aws-sdk/client-cloudtrail')]);
  const home=AWS_HOME_REGION();
  const single=async(module:any,Client:string,region:string,credentials:any,operation:string,input:any)=>{
    options.signal?.throwIfAborted();
    const client=new module[Client]({region,maxAttempts:Client==='CostExplorerClient'?1:3,credentials});
    try{return await client.send(new module[`${operation}Command`](input),{abortSignal:options.signal});}finally{client.destroy();}
  };
  return collectAwsWith({
    identity:async()=>{const {Account}=await single(sts,'STSClient',home,undefined,'GetCallerIdentity',{});if(!Account)throw new Error('AWS 계정 ID를 확인할 수 없습니다.');return Account;},
    hierarchy:()=>awsHierarchy((_s,op,input={})=>single(org,'OrganizationsClient','us-east-1',undefined,op,input)),
    assume:async role=>{const {Credentials:c}=await single(sts,'STSClient',home,undefined,'AssumeRole',{RoleArn:role.roleArn,RoleSessionName:'cloud-atlas-reader',DurationSeconds:3600});if(!c)throw new Error('역할 자격 증명이 없습니다.');return{accessKeyId:c.AccessKeyId,secretAccessKey:c.SecretAccessKey,sessionToken:c.SessionToken};},
    regions:async credentials=>((await single(ec2,'EC2Client',home,credentials,'DescribeRegions',{AllRegions:false})).Regions??[]).map((r:any)=>r.RegionName).filter(Boolean),
    resources:async(credentials,id,region,label)=>{
      const clientOptions={region,maxAttempts:3,credentials},clients={ec2:new ec2.EC2Client(clientOptions),elb:new elb.ElasticLoadBalancingV2Client(clientOptions),rds:new rds.RDSClient(clientOptions),dx:new dx.DirectConnectClient(clientOptions),eks:new eks.EKSClient(clientOptions)},modules:Record<string,any>={ec2,elb,rds,dx,eks};
      const call:AwsCaller=(service,operation,input={})=>{options.signal?.throwIfAborted();return (clients as any)[service].send(new modules[service][`${operation}Command`](input),{abortSignal:options.signal});};
      try{return await collectAwsAccount(call,id,region,label);}finally{for(const client of Object.values(clients))client.destroy();}
    },
    iam:(credentials,id)=>collectAwsIam((_s,op,input={})=>single(iam,'IAMClient','us-east-1',credentials,op,input),id),
    inventory:credentials=>collectAwsInventory((_s,op,input={})=>single(rex,'ResourceExplorer2Client',home,credentials,op,input)),
    activity:(credentials,id,region)=>collectAwsActivity((_s,op,input={})=>single(trail,'CloudTrailClient',region,credentials,op,input),id,region,undefined,options),
    cost:()=>collectAwsCost((_s,op,input={})=>single(ce,'CostExplorerClient','us-east-1',undefined,op,input),undefined,options),
  },regions,roles,options);
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
export async function collectGcpCost(request:GcpRequest,table:string,now=new Date(),options:Pick<CollectOptions,'signal'|'wait'>={}):Promise<CostRow[]>{
  if(!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(table))throw new Error('ATLAS_GCP_BILLING_TABLE은 project.dataset.table 형식이어야 합니다.');
  const {start}=costWindow(now),project=table.split('.')[0];
  const query=`SELECT invoice.month AS month, project.id AS project, service.description AS service, currency, SUM(cost) + SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS amount FROM \`${table}\` WHERE usage_start_time >= TIMESTAMP('${start}') AND project.id IS NOT NULL GROUP BY 1, 2, 3, 4`;
  let body=await retry(()=>request(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`,{method:'POST',data:{query,useLegacySql:false,timeoutMs:60_000,maxResults:50_000}}),options);
  const job=body.jobReference,rows:CostRow[]=[],seen=new Set<string>();let polls=0;
  while(true){
    options.signal?.throwIfAborted();
    if(body.jobComplete){
      if(body.errors?.length)throw new Error('BigQuery 비용 조회 오류');
      for(const r of body.rows??[]){const [month,scope,service,currency,amount]=r.f.map((c:any)=>c.v);rows.push(CostRowSchema.parse({provider:'gcp',scope,service,month:`${month.slice(0,4)}-${month.slice(4,6)}`,amount:Number(amount),currency}));}
      if(!body.pageToken)break;
      if(seen.has(body.pageToken))throw new Error('BigQuery: repeated cost pagination token');seen.add(body.pageToken);
    }else{
      if(++polls>60)throw new Error('BigQuery 비용 조회 시간 초과');
      await (options.wait??wait)(1000,options.signal);
    }
    if(!job?.jobId)throw new Error('BigQuery 비용 조회의 jobReference가 없습니다.');
    const q=new URLSearchParams({maxResults:'50000',timeoutMs:'10000',...(job.location?{location:job.location}:{}),...(body.jobComplete&&body.pageToken?{pageToken:body.pageToken}:{})});
    body=await retry(()=>request(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(job.projectId??project)}/queries/${encodeURIComponent(job.jobId)}?${q}`),options);
  }
  return rows;
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
  // Empty projects are successful reads too. Keep their scope and tree node even
  // when there are no assets from which finish() could infer either one.
  const project=parent.startsWith('projects/')?parent.slice('projects/'.length):undefined;
  if(project){
    part.hierarchy??=[];
    if(!part.hierarchy.some(n=>n.scope===project))part.hierarchy.push({id:scopeNodeId('gcp',project),name:project,provider:'gcp',kind:'project',nativeId:project,scope:project});
  }
  part.collectedScopes=[...new Set([
    ...(project?[project]:[]),
    ...part.resources.filter(r=>r.scope!=='unknown'&&r.scope!=='external').map(r=>r.scope),
    ...(part.hierarchy??[]).filter(n=>n.kind==='project'&&n.scope).map(n=>n.scope!),
  ])];
  report('iam',{detail:parent});
  try{part.iam=normalizeGcpIam(await gcpPages(parent,request,GCP_HIERARCHY_TYPES,'IAM_POLICY'),projectNumbers,parent.startsWith('projects/')?parent.split('/')[1]:undefined,org.domain);}
  catch(e){
    options.signal?.throwIfAborted();
    // IAM scopes use project IDs, but organization and folder IDs omit prefixes.
    part.iamIncomplete=[...new Set([
      ...part.collectedScopes,
      ...(part.hierarchy??[]).map(n=>n.scope??n.nativeId.split('/').pop()!),
      parent.split('/')[1],
    ])];
    part.warnings.push(`GCP: IAM 정책을 읽지 못했습니다 (${(e as Error)?.message?.slice(0,100)}).`);
  }
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
async function gcpBilling(request:GcpRequest,scopes:string[],options:CollectOptions):Promise<Normalized>{
  const report=options.report??noReport,warnings:string[]=[];
  let cost:CostRow[]|undefined,costCoverage:CostCoverage[]|undefined;const table=process.env.ATLAS_GCP_BILLING_TABLE;
  if(options.withCost!==false){
    if(table){
      report('cost',{detail:'BigQuery 조회'});
      try{cost=await collectGcpCost(request,table,undefined,options);costCoverage=[{provider:'gcp',state:'complete',failedScopes:[]}];report('cost',{state:'done',detail:`${count(cost.length)}행`});}
      catch(e){options.signal?.throwIfAborted();costCoverage=[{provider:'gcp',state:'failed',failedScopes:scopes}];warnings.push('GCP: 비용 일부 누락. BigQuery 결제 내보내기 조회를 완료하지 못했습니다. 다음 수집에서 다시 조회합니다.');report('cost',{state:'failed',detail:'결제 내보내기 조회 실패'});}
    }else{costCoverage=[{provider:'gcp',state:'unconfigured',failedScopes:[]}];warnings.push('GCP: 비용은 BigQuery 결제 내보내기로만 읽을 수 있습니다. 테이블을 ATLAS_GCP_BILLING_TABLE에 지정하세요.');report('cost',{state:'skipped',detail:'ATLAS_GCP_BILLING_TABLE 미설정'});}
  }
  options.signal?.throwIfAborted();
  return{resources:[],links:[],warnings,scopeLabels:{},cost,costCoverage};
}
export async function collectGcpAuto(request:GcpRequest,options:CollectOptions={}):Promise<Normalized>{
  const originalRequest=request;request=async(url,init)=>{options.signal?.throwIfAborted();const body=await originalRequest(url,init);options.signal?.throwIfAborted();return body;};
  const report=options.report??noReport;report('scopes',{detail:'조직과 프로젝트 조회'});
  const {orgs,orgNames,projects,records}=await discoverGcpParents(request),parts:Normalized[]=[],warnings:string[]=[],incomplete:string[]=[];let hierarchy:HierarchyNode[]|undefined;
  report('scopes',{state:'done',detail:orgs.length?`조직 ${orgs.length}개`:`프로젝트 ${projects.length}개`});let done=0;
  for(const parent of orgs){report('resources',{done:done++,total:orgs.length});try{parts.push(await collectGcpWith(parent,request,{...options,report}));}catch(e){warnings.push(`GCP ${parent}: 조직 범위를 읽지 못해 프로젝트별로 수집합니다 (${(e as Error)?.message?.slice(0,240)}).`);}}
  // Organization permissions can differ, and some visible projects have no
  // organization at all. A successful organization does not cover those reads.
  const covered=new Set(parts.flatMap(p=>p.collectedScopes??[]));
  const remaining=projects.filter(parent=>!covered.has(parent.slice('projects/'.length)));
  if(remaining.length){done=0;for(const parent of remaining){report('resources',{done:done++,total:remaining.length});try{parts.push(await collectGcpWith(parent,request,{...options,report}));}catch(e){options.signal?.throwIfAborted();warnings.push(`GCP ${parent}: 읽지 못했습니다 (${(e as Error)?.message?.slice(0,240)}).`);incomplete.push(parent.split('/')[1]);}}
    if(parts.length){report('scopes',{detail:'폴더 계층 조회'});const tree=await gcpAncestry(records,request,orgNames);hierarchy=tree.nodes;warnings.push(...tree.warnings);}}
  if(!parts.length)throw new Error(warnings[0]??'GCP: 이 계정으로 볼 수 있는 조직이나 프로젝트가 없습니다.');
  report('resources',{state:'done',detail:`범위 ${parts.length}개`});report('iam',{state:'done'});
  const billing=await gcpBilling(request,projects.map(p=>p.slice(9)),options);
  options.signal?.throwIfAborted();
  return finish([...parts,billing,{resources:[],links:[],warnings,scopeLabels:{},incomplete,...(hierarchy?{hierarchy}:{})}]);
}
export async function collectGcp(parent:string,options:CollectOptions={}):Promise<Normalized>{
  const {GoogleAuth}=await import('google-auth-library');const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});const client=await auth.getClient();
  const request:GcpRequest=async(url,init)=>{options.signal?.throwIfAborted();const response=await client.request({url,timeout:60_000,signal:options.signal,retryConfig:{retry:url.startsWith('https://bigquery.googleapis.com/')?0:3},...(init?{method:init.method as 'POST',data:init.data}:{})});return response.data;};
  const inventory=await collectGcpWith(parent,request,options);
  return finish([inventory,await gcpBilling(request,inventory.resources.map(r=>r.scope),options)]);
}
