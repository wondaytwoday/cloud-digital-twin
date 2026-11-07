import test from 'node:test';
import assert from 'node:assert/strict';
import {azureCost,azureFetch,azurePages,collectAwsActivity,collectAzureWith,retryAfterMs} from '../server/collectors.ts';

// Contract tests: each fakes one documented behaviour of a provider API and checks the collector copes.
// They stand in for, and do not replace, a run against a real account.
const json=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers});
const NOW=new Date('2026-11-07T00:00:00Z');

test('throttling waits as long as Azure asks, including Cost Management\'s own headers',()=>{
  assert.equal(retryAfterMs(new Headers({'retry-after':'3'}),0),3000);
  assert.equal(retryAfterMs(new Headers({'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after':'7','x-ms-ratelimit-microsoft.costmanagement-entity-retry-after':'2'}),0),7000,'the longest wait named');
  assert.equal(retryAfterMs(new Headers(),2),4000,'no header: exponential');assert.equal(retryAfterMs(new Headers({'retry-after':'600'}),0),30_000,'capped');
});
test('a throttled Azure call is retried with a fresh request, and gives up with the last answer',async()=>{
  let calls=0;const tokens:string[]=[];
  const flaky=(async(_u:unknown,init?:RequestInit)=>{tokens.push(String((init?.headers as Record<string,string>)?.Authorization));return ++calls<3?json({},429,{'retry-after':'0'}):json({ok:true});}) as typeof fetch;
  let n=0;const r=await azureFetch(flaky,'https://management.azure.com/x',()=>({headers:{Authorization:`Bearer t${++n}`}}));
  assert.equal(r.status,200);assert.deepEqual(tokens,['Bearer t1','Bearer t2','Bearer t3']);
  const down=(async()=>json({},503,{'retry-after':'0'})) as typeof fetch;assert.equal((await azureFetch(down,'u',()=>({}),2)).status,503);
});
test('Resource Graph is queried in batches of at most 1,000 subscriptions',async()=>{
  const subs=Array.from({length:2500},(_,i)=>`sub-${i}`),batches:number[]=[];
  const request=(async(_u:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));batches.push(body.subscriptions.length);const page=body.options.$skipToken?2:1;return json({data:[{id:`${body.subscriptions[0]}-${page}`}],...(page===1?{$skipToken:`next-${body.subscriptions[0]}`}:{})});}) as typeof fetch;
  const seen:number[]=[];const rows=await azurePages(subs,async()=>'t',request,undefined,n=>seen.push(n));
  assert.deepEqual(batches,[1000,1000,1000,1000,500,500],'each batch pages on its own token');
  assert.equal(rows.length,6);assert.deepEqual(seen,[1,2,3,4,5,6],'progress counts across batches');
});
test('Cost Management: a long answer is followed through nextLink, and a subscription failing part way is dropped, not undercounted',async()=>{
  const cols=[{name:'Cost'},{name:'BillingMonth'},{name:'ServiceName'},{name:'Currency'}];
  let throttled=false;
  const request=(async(u:unknown)=>{const url=String(u);
    if(url.includes('/subscriptions/a/')){if(!throttled){throttled=true;return json({},429,{'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after':'0'});}return url.includes('page2')?json({properties:{columns:cols,rows:[[2,'2026-10-01T00:00:00','Storage','KRW']]}}):json({properties:{columns:cols,rows:[[1,'2026-10-01T00:00:00','Compute','KRW']],nextLink:'https://management.azure.com/subscriptions/a/providers/Microsoft.CostManagement/query?page2'}});}
    return url.includes('page2')?json({},403):json({properties:{columns:cols,rows:[[9,'2026-10-01T00:00:00','Compute','KRW']],nextLink:'https://management.azure.com/subscriptions/b/providers/Microsoft.CostManagement/query?page2'}});
  }) as typeof fetch;
  const {rows,failed}=await azureCost(['a','b'],async()=>'t',request,NOW);
  assert.deepEqual(rows.map(r=>[r.scope,r.service,r.amount,r.month]),[['a','Compute',1,'2026-10'],['a','Storage',2,'2026-10']]);
  assert.deepEqual(failed,['b'],'half of b would read as a smaller bill, so none of it is kept');
});
test('Activity Log: one unreadable subscription is a partial read, not a lost one',async()=>{
  const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
  const event={eventDataId:'e1',eventTimestamp:'2026-11-06T00:00:00Z',caller:'kim@corp.example',operationName:{value:'Microsoft.Network/networkSecurityGroups/write'},status:{value:'Succeeded'},resourceId:`/subscriptions/${A}/x`};
  const request=(async(u:unknown,init?:RequestInit)=>{const url=String(u),body=String(init?.body??'');
    if(url.includes('eventtypes'))return url.includes(B)?json({},403):json({value:[event]});
    if(url.includes('ResourceGraph'))return json({data:[]});if(url.includes('CostManagement'))return json({properties:{columns:[],rows:[]}});
    void body;return url.includes('/tenants')||url.includes('managementGroups')?json({value:[]}):json({displayName:'S',tenantId:'t'});
  }) as typeof fetch;
  const r=await collectAzureWith([A,B],async()=>'t',request);
  assert.equal(r.activity?.length,1);assert.equal(r.gaps?.activity,'partial');assert.ok(r.warnings.some(w=>/구독 1개의 변경 기록/.test(w)));
});
test('CloudTrail pages are spaced to stay under two calls a second',async()=>{
  const at:number[]=[];let page=0;
  const call=async()=>{at.push(Date.now());page++;return{Events:[],...(page<3?{NextToken:`t${page}`}:{})};};
  await collectAwsActivity(call as any,'111','ap-northeast-2',NOW,120);
  assert.equal(at.length,3);for(let i=1;i<at.length;i++)assert.ok(at[i]-at[i-1]>=110,`gap ${at[i]-at[i-1]}ms`);
});
test('firewall policy rules are read over ARM with paging, and a refused read leaves the firewall marked uncollected',async()=>{
  const sub='00000000-0000-4000-8000-000000000001',policy=`/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.Network/firewallPolicies/p`;
  const fwRow={id:`/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.Network/azureFirewalls/fw`,name:'fw',type:'Microsoft.Network/azureFirewalls',subscriptionId:sub,resourceGroup:'rg',location:'kc',properties:{firewallPolicy:{id:policy},ipConfigurations:[{properties:{privateIPAddress:'10.0.1.4'}}]}};
  const group=(name:string,prio:number)=>({name,properties:{priority:prio,ruleCollections:[{ruleCollectionType:'FirewallPolicyFilterRuleCollection',name:'c',priority:100,action:{type:'Allow'},rules:[{ruleType:'NetworkRule',name:`r-${name}`,ipProtocols:['TCP'],sourceAddresses:['*'],destinationAddresses:['*'],destinationPorts:['443']}]}]}});
  const transport=(refuse:boolean)=>(async(u:unknown,init?:RequestInit)=>{const url=String(u);
    if(url.includes('ruleCollectionGroups'))return refuse?json({},403):url.includes('page2')?json({value:[group('g2',300)]}):json({value:[group('g1',200)],nextLink:`https://management.azure.com${policy}/ruleCollectionGroups?page2`});
    if(url.includes('ResourceGraph'))return json({data:String(init?.body).includes('authorizationresources')?[]:[fwRow]});
    if(url.includes('eventtypes'))return json({value:[]});if(url.includes('CostManagement'))return json({properties:{columns:[],rows:[]}});
    return url.includes('/tenants')||url.includes('managementGroups')?json({value:[]}):json({displayName:'S',tenantId:'t'});}) as typeof fetch;
  const ok=await collectAzureWith([sub],async()=>'t',transport(false)),fw=ok.resources.find(r=>r.name==='fw')!;
  assert.equal(fw.specs['정책 규칙'],'수집됨');assert.deepEqual(fw.rules.map(r=>r.name),['g1/c/r-g1','g2/c/r-g2'],'both pages, in group order');
  const refused=await collectAzureWith([sub],async()=>'t',transport(true)),fw2=refused.resources.find(r=>r.name==='fw')!;
  assert.equal(fw2.specs['정책 규칙'],'미수집');assert.ok(refused.warnings.some(w=>/방화벽 정책 p의 규칙을 읽지 못했습니다/.test(w)));
});
test('GCP router status supplies BGP routes, and a refused read is a warning that keeps the router uncollected',async()=>{
  const {collectGcpWith}=await import('../server/collectors.ts');
  const router={name:'//compute.googleapis.com/projects/p/regions/r/routers/rt',assetType:'compute.googleapis.com/Router',resource:{location:'r',data:{name:'rt',network:'https://www.googleapis.com/compute/v1/projects/p/global/networks/n'}}};
  const net={name:'//compute.googleapis.com/projects/p/global/networks/n',assetType:'compute.googleapis.com/Network',resource:{location:'global',data:{name:'n'}}};
  const request=(refuse:boolean)=>(async(url:string)=>{if(url.includes('getRouterStatus')){if(refuse)throw new Error('403 compute.routers.get');return{result:{bestRoutes:[{destRange:'10.0.0.0/8',nextHopIp:'169.254.0.1',priority:100}]}};}const types=new URL(url).searchParams.getAll('assetTypes');return types.length?{assets:[]}:{assets:[net,router]};}) as any;
  const ok=await collectGcpWith('projects/p',request(false),{withActivity:false});
  assert.deepEqual(ok.resources.find(r=>r.name==='n')!.routes.map(r=>[r.destination,r.via]),[['10.0.0.0/8','BGP']]);assert.equal(ok.resources.find(r=>r.name==='rt')!.specs['동적 경로'],'1개');
  const refused=await collectGcpWith('projects/p',request(true),{withActivity:false});
  assert.equal(refused.resources.find(r=>r.name==='rt')!.specs['동적 경로'],'수집 실패');assert.ok(refused.warnings.some(w=>/동적 경로를 읽지 못했습니다/.test(w)));
});
test('service tags: only the tags NSG rules use are kept, a fresh cache is reused, and a failed read falls back to the last list',async()=>{
  const sub='00000000-0000-4000-8000-000000000001';
  const nsgRow={id:`/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.Network/networkSecurityGroups/nsg`,name:'nsg',type:'Microsoft.Network/networkSecurityGroups',subscriptionId:sub,resourceGroup:'rg',location:'koreacentral',properties:{securityRules:[{name:'out',properties:{direction:'Outbound',access:'Allow',protocol:'Tcp',sourcePortRange:'*',destinationPortRange:'443',sourceAddressPrefix:'VirtualNetwork',destinationAddressPrefix:'Storage.KoreaCentral',priority:100}}]}};
  let tagCalls=0;
  const transport=(fail:boolean)=>(async(u:unknown,init?:RequestInit)=>{const url=String(u);
    if(url.includes('/serviceTags')){tagCalls++;assert.match(url,/locations\/koreacentral\/serviceTags/);return fail?json({},403):json({values:[{name:'Storage.KoreaCentral',properties:{addressPrefixes:['20.150.4.0/23']}},{name:'AzureCloud',properties:{addressPrefixes:['1.0.0.0/8']}}]});}
    if(url.includes('ResourceGraph'))return json({data:String(init?.body).includes('authorizationresources')?[]:[nsgRow]});
    if(url.includes('eventtypes'))return json({value:[]});if(url.includes('CostManagement'))return json({properties:{columns:[],rows:[]}});
    return url.includes('/tenants')||url.includes('managementGroups')?json({value:[]}):json({displayName:'S',tenantId:'t'});}) as typeof fetch;
  const first=await collectAzureWith([sub],async()=>'t',transport(false),{withActivity:false});
  assert.deepEqual(first.serviceTags,{'Storage.KoreaCentral':['20.150.4.0/23']},'tags no rule names are not stored');assert.equal(tagCalls,1);
  const cached={at:new Date(Date.now()-3_600_000).toISOString(),tags:first.serviceTags!};
  const second=await collectAzureWith([sub],async()=>'t',transport(false),{withActivity:false,cachedServiceTags:cached});
  assert.equal(tagCalls,1,'an hour-old list is not fetched again');assert.equal(second.serviceTagsAt,cached.at);
  const stale={at:new Date(Date.now()-3*86_400_000).toISOString(),tags:first.serviceTags!};
  const third=await collectAzureWith([sub],async()=>'t',transport(true),{withActivity:false,cachedServiceTags:stale});
  assert.equal(tagCalls,2);assert.deepEqual(third.serviceTags,first.serviceTags);assert.equal(third.serviceTagsAt,stale.at);assert.ok(third.warnings.some(w=>/새로 읽지 못해/.test(w)));
  const none=await collectAzureWith([sub],async()=>'t',transport(true),{withActivity:false});
  assert.equal(none.serviceTags,undefined);assert.ok(none.warnings.some(w=>/서비스 태그 대역을 읽지 못했습니다/.test(w)));
});
