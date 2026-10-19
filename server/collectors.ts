import { normalizeAzure,normalizeAws,normalizeGcp,type Normalized } from './normalize.js';
export const AZURE_TYPES=['microsoft.compute/virtualmachines','microsoft.network/networkinterfaces','microsoft.network/virtualnetworks','microsoft.network/networksecuritygroups','microsoft.network/expressroutecircuits','microsoft.network/virtualnetworkgateways','microsoft.network/connections'];
export const GCP_TYPES=['Instance','Network','Subnetwork','Firewall','Router'].map(t=>`compute.googleapis.com/${t}`);
// Injectable HTTP boundary permits contract tests without credentials or live calls.
export async function azurePages(subscriptions:string[],token:()=>Promise<string>,request:typeof fetch=fetch){
  const rows:Record<string,any>[]=[],seen=new Set<string>();let next:string|undefined;
  do{
    let response:Response|undefined;
    for(let attempt=0;attempt<4;attempt++){
      response=await request('https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01',{method:'POST',headers:{Authorization:`Bearer ${await token()}`,'Content-Type':'application/json'},body:JSON.stringify({subscriptions,query:`Resources | where type in~ (${AZURE_TYPES.map(t=>`'${t}'`).join(',')}) | project id, name, type, location, subscriptionId, resourceGroup, properties, tags | order by id asc`,options:{$top:1000,resultFormat:'objectArray',...(next?{$skipToken:next}:{})}}),signal:AbortSignal.timeout(30_000)});
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
export async function collectAzure(subscriptions:string[]):Promise<Normalized>{
  const {DefaultAzureCredential}=await import('@azure/identity');const credential=new DefaultAzureCredential();
  // Explicit scope checks prevent ARG silently succeeding with only some subscriptions.
  for(const sub of subscriptions){const token=await credential.getToken('https://management.azure.com/.default');const r=await fetch(`https://management.azure.com/subscriptions/${encodeURIComponent(sub)}?api-version=2022-12-01`,{headers:{Authorization:`Bearer ${token.token}`},signal:AbortSignal.timeout(30_000)});if(!r.ok)throw new Error(`Azure 구독 ${sub}: 접근 확인 실패 (${r.status})`);}
  const rows=await azurePages(subscriptions,async()=>{const t=await credential.getToken('https://management.azure.com/.default');return t.token;});
  const result=normalizeAzure(rows);result.warnings.push('Azure: 보이는 지원 자원만 수집. 구독 내부 리소스별 접근 제한과 Resource Graph 반영 지연은 별도 확인 필요.');return result;
}
export async function collectAws(regions:string[]):Promise<Normalized>{
  const ec2=await import('@aws-sdk/client-ec2'),sts=await import('@aws-sdk/client-sts');
  const identity=await new sts.STSClient({region:regions[0],maxAttempts:3}).send(new sts.GetCallerIdentityCommand({}));
  if(!identity.Account)throw new Error('AWS 계정 ID를 확인할 수 없습니다.');
  const results:Normalized[]=[];
  for(const region of regions){
    const client=new ec2.EC2Client({region,maxAttempts:3});const data:Record<string,any[]>={};
    for(const [Command,key] of [[ec2.DescribeVpcsCommand,'Vpcs'],[ec2.DescribeSubnetsCommand,'Subnets'],[ec2.DescribeInstancesCommand,'Reservations'],[ec2.DescribeSecurityGroupsCommand,'SecurityGroups']] as const){let next:string|undefined;const seen=new Set<string>();data[key]=[];do{const response:any=await client.send(new (Command as any)({MaxResults:100,NextToken:next}));data[key].push(...(response[key]??[]));next=response.NextToken;if(next){if(seen.has(next))throw new Error('AWS: repeated pagination token');seen.add(next);}}while(next);}
    data.VpnGateways=(await client.send(new ec2.DescribeVpnGatewaysCommand({}))).VpnGateways??[];
    const types=[...new Set(data.Reservations.flatMap(r=>r.Instances??[]).map(r=>r.InstanceType))];data.InstanceTypes=[];
    for(let i=0;i<types.length;i+=100){let token:string|undefined;do{const response=await client.send(new ec2.DescribeInstanceTypesCommand({InstanceTypes:types.slice(i,i+100),NextToken:token}));data.InstanceTypes.push(...response.InstanceTypes??[]);token=response.NextToken;}while(token);}
    results.push(normalizeAws(data,identity.Account,region));client.destroy();
  }
  return {resources:results.flatMap(r=>r.resources),links:results.flatMap(r=>r.links),warnings:results.flatMap(r=>r.warnings)};
}
// REST fallback avoids protobuf Struct conversion ambiguity for resource.data.
export async function gcpPages(parent:string,request:(url:string)=>Promise<any>){
  const assets:Record<string,any>[]=[],seen=new Set<string>();let next:string|undefined,readTime:string|undefined;
  do{const q=new URLSearchParams({contentType:'RESOURCE',pageSize:'1000'});GCP_TYPES.forEach(t=>q.append('assetTypes',t));if(next)q.set('pageToken',next);if(readTime)q.set('readTime',readTime);
    const body=await request(`https://cloudasset.googleapis.com/v1/${parent}/assets?${q}`);if(!Array.isArray(body.assets)&&body.assets!==undefined)throw new Error('GCP: invalid assets response');assets.push(...body.assets??[]);readTime=body.readTime??readTime;next=body.nextPageToken;if(next){if(seen.has(next))throw new Error('GCP: repeated pagination token');seen.add(next);}
  }while(next);return assets;
}
export async function collectGcp(parent:string):Promise<Normalized>{
  const {GoogleAuth}=await import('google-auth-library');const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});const client=await auth.getClient();
  const assets=await gcpPages(parent,async(url)=>{const response=await client.request({url,timeout:30_000,retryConfig:{retry:3}});return response.data;});
  const result=normalizeGcp(assets);result.warnings.push('GCP: Asset Inventory의 최종 일관성 데이터. Cloud Router 관계는 구성 참조이며 패킷 경유 경로가 아닙니다.');return result;
}
