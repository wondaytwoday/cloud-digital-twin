import { fixtures } from './fixtures/index.js';
import { seed } from './fixtures/opsdata.js';
import type { OrgTree, Scenario } from './fixtures/types.js';
import { awsHierarchy,collectAwsCost,collectAwsIam,collectAwsInventory,collectAzureWith,collectAwsAccount,collectGcpCost,collectGcpWith,type AwsCaller,type GcpRequest } from './collectors.js';
import { awsIamApi,awsResources,azureIam,azureServices,costPoints,gcpPolicies,gcpServices } from './fixtures/opsdata.js';
import { finish,type Normalized } from './normalize.js';
import { applySites } from './onprem.js';
import { diffResources } from '../shared/diff.js';
import { ResourceSchema, validateSnapshot, type Connection, type Link, type Resource } from '../shared/schema.js';
import type { ScenarioId } from '../shared/scenarios.js';
import { demoActivity } from './fixtures/activity.js';
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
const PAGE=12;
// Fake HTTP/SDK boundaries: demo data walks the same pagination and normalization code as live collection.
const azureTransport=(rows:any[],names:Record<string,string>,tree:OrgTree|undefined,iam:{rows:any[];directory:Record<string,string>},now:Date):typeof fetch=>async(url,init)=>{
  const target=String(url);
  if(target.includes('directoryObjects/getByIds'))return json({value:JSON.parse(String(init?.body)).ids.map((id:string)=>({id,displayName:iam.directory[id]??id}))});
  if(target.includes('Microsoft.CostManagement/query')){const sub=target.match(/subscriptions\/([^/]+)/)![1];return json({properties:{columns:[{name:'Cost'},{name:'BillingMonth'},{name:'ServiceName'},{name:'Currency'}],rows:costPoints('azure',[sub],now).map(p=>[p.amount,`${p.month}-01T00:00:00`,p.service,'USD'])}});}
  if(target.includes('/tenants?'))return tree?json({value:[{tenantId:tree.id,displayName:tree.name}]}):new Response('{}',{status:403});
  if(target.includes('Microsoft.Management/managementGroups')){
    const child=(t:OrgTree):any=>t.scope?{type:'/subscriptions',name:t.scope,displayName:t.name}:{type:'Microsoft.Management/managementGroups',name:t.id,displayName:t.name,children:t.children?.map(child)};
    return json({name:tree!.id,properties:{displayName:tree!.name,children:tree!.children?.map(child)}});
  }
  if(target.includes('Microsoft.ResourceGraph')){const body=JSON.parse(String(init?.body)),source=String(body.query).startsWith('authorizationresources')?iam.rows:rows,offset=Number(body.options.$skipToken??0),end=offset+PAGE;return json({data:source.slice(offset,end),...(end<source.length?{$skipToken:String(end)}:{})});}
  const sub=target.match(/subscriptions\/([^?]+)/)?.[1]??'';return json({subscriptionId:sub,displayName:names[sub],tenantId:tree?.id});
};
const awsTransport=(api:Record<string,any>):AwsCaller=>async(_service,operation,input={})=>{
  const entry=api[operation]??{},response=typeof entry==='function'?entry(input):entry,key=Object.keys(response)[0];if(!key||!input.MaxResults)return response;
  const offset=Number(input.NextToken??0),end=offset+2,rows=response[key];
  return {[key]:rows.slice(offset,end),...(end<rows.length?{NextToken:String(end)}:{})};
};
const gcpTransport=(all:any[],policies:any[],now:Date):GcpRequest=>async(url,init)=>{
  if(url.includes('bigquery.googleapis.com')){const scopes=[...new Set(all.filter(a=>!String(a.assetType).startsWith('cloudresourcemanager')).map(a=>String(a.name).match(/projects\/([^/]+)/)?.[1]).filter((x):x is string=>!!x))];return {jobComplete:true,rows:costPoints('gcp',scopes,now).map(p=>({f:[{v:p.month.replace('-','')},{v:p.scope},{v:p.service},{v:'USD'},{v:String(p.amount)}]}))};}
  const params=new URL(url).searchParams,types=new Set(params.getAll('assetTypes')),source=params.get('contentType')==='IAM_POLICY'?policies:all,assets=source.filter(a=>!types.size||types.has(a.assetType)),offset=Number(params.get('pageToken')??0),end=offset+PAGE;
  return {readTime:now.toISOString(),assets:assets.slice(offset,end),...(end<assets.length?{nextPageToken:String(end)}:{})};
};
const awsOrgTransport=(tree:OrgTree):AwsCaller=>async(_service,operation,input={})=>{
  if(operation==='DescribeOrganization')return {Organization:{Id:tree.id,Name:tree.name}};
  if(operation==='ListRoots')return {Roots:[{Id:`r-${tree.id}`}]};
  const find=(t:OrgTree):OrgTree|undefined=>`r-${tree.id}`===input.ParentId&&t===tree?t:t.id===input.ParentId?t:t.children?.map(find).find(Boolean);
  const kids=find(tree)?.children??[];
  if(operation==='ListAccountsForParent')return {Accounts:kids.filter(k=>k.scope).map(k=>({Id:k.scope,Name:k.name}))};
  return {OrganizationalUnits:kids.filter(k=>!k.scope).map(k=>({Id:k.id,Name:k.name}))};
};
function gcpOrgAssets(tree:OrgTree,numbers:Map<string,string>){
  const assets:any[]=[{name:`//cloudresourcemanager.googleapis.com/organizations/${tree.id}`,assetType:'cloudresourcemanager.googleapis.com/Organization',resource:{data:{name:`organizations/${tree.id}`,displayName:tree.name}}}];
  const walk=(t:OrgTree,parentType:'organization'|'folder')=>{for(const c of t.children??[]){
    if(c.scope)assets.push({name:`//cloudresourcemanager.googleapis.com/projects/${c.scope}`,assetType:'cloudresourcemanager.googleapis.com/Project',resource:{data:{projectId:c.scope,projectNumber:numbers.get(c.scope),name:c.name,parent:{type:parentType,id:t.id}}}});
    else{assets.push({name:`//cloudresourcemanager.googleapis.com/folders/${c.id}`,assetType:'cloudresourcemanager.googleapis.com/Folder',resource:{data:{name:`folders/${c.id}`,displayName:c.name,parent:`${parentType}s/${t.id}`}}});walk(c,'folder');}
  }};
  walk(tree,'organization');return assets;
}
async function collectScenario(s:Scenario,now:Date){
  const parts:Normalized[]=[];
  if(s.azure){
    const subs=Object.keys(s.azure.subscriptions),iam=azureIam(subs,s.azure.subscriptions,s.azure.assignments),rows=[...s.azure.rows,...subs.flatMap(sub=>azureServices(sub,`rg-${seed(sub)}`,(s.azure!.subscriptions[sub]).toLowerCase().replace(/[^a-z0-9]+/g,'-')))];
    parts.push(await collectAzureWith(subs,async()=>'demo-token',azureTransport(rows,s.azure.subscriptions,s.azure.tree,iam,now),{graphToken:async()=>'demo-token',withActivity:false}));
  }
  for(const a of s.aws??[]){const merged={...a.api,...awsIamApi(a.account,a.label,now)};parts.push(await collectAwsAccount(awsTransport(merged),a.account,a.region,a.label));}
  const accounts=[...new Map((s.aws??[]).map(a=>[a.account,a])).values()];
  for(const a of accounts){
    const iam=await collectAwsIam(awsTransport(awsIamApi(a.account,a.label,now)),a.account),inventory=await collectAwsInventory(awsTransport({ListResources:{Resources:awsResources(a.account,a.label,a.region)}}));
    parts.push({resources:[],links:[],warnings:[],scopeLabels:{},iam:iam.iam,awsInventory:{account:a.account,rows:inventory.rows}});
  }
  if(accounts.length){
    const points=accounts.flatMap(a=>costPoints('aws',[a.account],now).map(p=>({...p})));
    const months=[...new Set(points.map(p=>p.month))];
    const ce:AwsCaller=async()=>({ResultsByTime:months.map(m=>({TimePeriod:{Start:`${m}-01`},Groups:points.filter(p=>p.month===m).map(p=>({Keys:[p.scope,p.service],Metrics:{UnblendedCost:{Amount:String(p.amount),Unit:'USD'}}}))}))});
    parts.push({resources:[],links:[],warnings:[],scopeLabels:{},cost:await collectAwsCost(ce,now)});
  }
  if(s.awsOrg)parts.push({resources:[],links:[],warnings:[],scopeLabels:{},hierarchy:await awsHierarchy(awsOrgTransport(s.awsOrg))});
  if(s.gcp){
    const projects=[...new Set(s.gcp.assets.map(a=>String(a.name).match(/projects\/([^/]+)/)?.[1]).filter((x):x is string=>!!x))];
    const numbers=new Map<string,string>(),policies=gcpPolicies(projects,s.gcp.tree?{id:s.gcp.tree.id,domain:s.gcp.tree.name}:null,numbers);
    const assets=[...s.gcp.assets,...projects.flatMap(gcpServices),...(s.gcp.tree?gcpOrgAssets(s.gcp.tree,numbers):[])],request=gcpTransport(assets,policies,now);
    parts.push(await collectGcpWith(s.gcp.parent,request,{withActivity:false}),{resources:[],links:[],warnings:[],scopeLabels:{},cost:await collectGcpCost(request,'demo.billing.export',now)});
  }
  return finish(parts);
}
export async function mockSnapshot(id:ScenarioId='standard'){
  const scenario=fixtures[id],clock=new Date(),{resources,links,warnings,scopeLabels,hierarchy,cost,iam}=await collectScenario(scenario,clock);
  const named=(name:string)=>{const r=resources.find(x=>x.name===name);if(!r)throw new Error(`Fixture ${id}: unknown resource ${name}`);return r;};
  applySites(scenario.onprem??[],resources,links,warnings,scopeLabels);
  addSyntheticTelemetry(resources);
  for(const flow of scenario.flows??[])links.push(...syntheticFlow(flow,named));
  const scopeCount=(p:string)=>new Set(resources.filter(r=>r.provider===p&&r.scope!=='external').map(r=>r.scope)).size;
  const connections:Connection[]=[];
  if(scenario.azure)connections.push({provider:'azure',status:'demo',api:'Azure Resource Graph',scopes:scopeCount('azure')});
  if(scenario.aws)connections.push({provider:'aws',status:'demo',api:'AWS Describe APIs',scopes:scopeCount('aws')});
  if(scenario.gcp)connections.push({provider:'gcp',status:'demo',api:'Cloud Asset Inventory',scopes:scopeCount('gcp')});
  const now=Date.now();
  return validateSnapshot({version:1,mode:'mock',scenario:id,activity:demoActivity(resources,new Date(now)),changes:demoChanges(resources,now),collectedAt:new Date(now).toISOString(),resources,links,warnings,scopes:[...new Set(resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external').map(r=>r.scope))],scopeLabels,connections,hierarchy,cost,iam,costAt:clock.toISOString()});
}
// A fabricated earlier state, so the change list has something to show. Goes through the same diff as live history.
function demoChanges(resources:Resource[],now:number){
  if(resources.length<30)return undefined;
  const before:Resource[]=resources.map(r=>({...r}));
  const stopped=before.find(r=>r.kind==='compute'&&/stopped|deallocated/.test(r.status)),warn=before.find(r=>r.kind==='gateway'&&r.status==='degraded'),newest=resources.filter(r=>r.kind==='compute').at(-1);
  if(stopped)stopped.status='running';if(warn)warn.status='available';
  const open=before.find(r=>r.kind==='firewall'&&r.rules.some(x=>x.source==='0.0.0.0/0'));if(open)open.rules=open.rules.map(x=>x.source==='0.0.0.0/0'?{...x,source:'10.0.0.0/8'}:x);
  const gone={...newest!,id:`${newest!.id}-retired`,name:'batch-legacy-01',nativeId:'retired'};
  return{since:new Date(now-86_400_000).toISOString(),items:diffResources([...before.filter(r=>r.id!==newest?.id),gone],resources)};
}
function addSyntheticTelemetry(resources:Resource[]){
  for(const [i,r] of resources.filter(r=>r.kind==='compute').entries()){
    if(!/stopped|deallocated|terminated|failed/i.test(r.status)){const cpu=18+(i*13)%62;r.metrics={cpu,memory:35+(i*17)%50,disk:22+(i*23)%71,...(/×/.test(r.specs['GPU']??'')?{gpu:40+(i*29)%55}:{}),history:Array.from({length:12},(_,h)=>Math.max(4,Math.min(96,cpu+((h*7+i*5)%24)-12)))};}
  }
}
function syntheticFlow({hops,rate}:{hops:string[];rate:string},named:(name:string)=>Resource):Link[]{
  return hops.slice(1).map((name,i)=>({id:`demo:${hops[i]}:${name}`,source:named(hops[i]).id,target:named(name).id,kind:'simulation' as const,label:'시연 트래픽',evidence:'명시적으로 작성한 시연 경로. 실제 패킷·경로 검증 결과가 아닙니다.',protocol:'TCP',ports:'443',rate}));
}
