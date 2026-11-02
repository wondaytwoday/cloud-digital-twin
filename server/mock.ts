import { fixtures } from './fixtures/index.js';
import type { OrgTree, Scenario } from './fixtures/types.js';
import { awsHierarchy,collectAzureWith,collectAwsAccount,collectGcpWith,type AwsCaller } from './collectors.js';
import { finish,type Normalized } from './normalize.js';
import { ResourceSchema, validateSnapshot, type Connection, type Link, type Resource } from '../shared/schema.js';
import type { ScenarioId } from '../shared/scenarios.js';
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
const PAGE=12;
// Fake HTTP/SDK boundaries: demo data walks the same pagination and normalization code as live collection.
const azureTransport=(rows:any[],names:Record<string,string>,tree?:OrgTree):typeof fetch=>async(url,init)=>{
  const target=String(url);
  if(target.includes('/tenants?'))return tree?json({value:[{tenantId:tree.id,displayName:tree.name}]}):new Response('{}',{status:403});
  if(target.includes('Microsoft.Management/managementGroups')){
    const child=(t:OrgTree):any=>t.scope?{type:'/subscriptions',name:t.scope,displayName:t.name}:{type:'Microsoft.Management/managementGroups',name:t.id,displayName:t.name,children:t.children?.map(child)};
    return json({name:tree!.id,properties:{displayName:tree!.name,children:tree!.children?.map(child)}});
  }
  if(target.includes('Microsoft.ResourceGraph')){const offset=Number(JSON.parse(String(init?.body)).options.$skipToken??0),end=offset+PAGE;return json({data:rows.slice(offset,end),...(end<rows.length?{$skipToken:String(end)}:{})});}
  const sub=target.match(/subscriptions\/([^?]+)/)?.[1]??'';return json({subscriptionId:sub,displayName:names[sub]});
};
const awsTransport=(api:Record<string,any>):AwsCaller=>async(_service,operation,input={})=>{
  const response=api[operation]??{},key=Object.keys(response)[0];if(!key||!input.MaxResults)return response;
  const offset=Number(input.NextToken??0),end=offset+2,rows=response[key];
  return {[key]:rows.slice(offset,end),...(end<rows.length?{NextToken:String(end)}:{})};
};
const gcpTransport=(all:any[])=>async(url:string)=>{const params=new URL(url).searchParams,types=new Set(params.getAll('assetTypes')),assets=all.filter(a=>types.has(a.assetType)),offset=Number(params.get('pageToken')??0),end=offset+PAGE;return {readTime:new Date().toISOString(),assets:assets.slice(offset,end),...(end<assets.length?{nextPageToken:String(end)}:{})};};
const awsOrgTransport=(tree:OrgTree):AwsCaller=>async(_service,operation,input={})=>{
  if(operation==='DescribeOrganization')return {Organization:{Id:tree.id,Name:tree.name}};
  if(operation==='ListRoots')return {Roots:[{Id:`r-${tree.id}`}]};
  const find=(t:OrgTree):OrgTree|undefined=>`r-${tree.id}`===input.ParentId&&t===tree?t:t.id===input.ParentId?t:t.children?.map(find).find(Boolean);
  const kids=find(tree)?.children??[];
  if(operation==='ListAccountsForParent')return {Accounts:kids.filter(k=>k.scope).map(k=>({Id:k.scope,Name:k.name}))};
  return {OrganizationalUnits:kids.filter(k=>!k.scope).map(k=>({Id:k.id,Name:k.name}))};
};
function gcpOrgAssets(tree:OrgTree){
  const assets:any[]=[{name:`//cloudresourcemanager.googleapis.com/organizations/${tree.id}`,assetType:'cloudresourcemanager.googleapis.com/Organization',resource:{data:{name:`organizations/${tree.id}`,displayName:tree.name}}}];
  const walk=(t:OrgTree,parentType:'organization'|'folder')=>{for(const c of t.children??[]){
    if(c.scope)assets.push({name:`//cloudresourcemanager.googleapis.com/projects/${c.scope}`,assetType:'cloudresourcemanager.googleapis.com/Project',resource:{data:{projectId:c.scope,name:c.name,parent:{type:parentType,id:t.id}}}});
    else{assets.push({name:`//cloudresourcemanager.googleapis.com/folders/${c.id}`,assetType:'cloudresourcemanager.googleapis.com/Folder',resource:{data:{name:`folders/${c.id}`,displayName:c.name,parent:`${parentType}s/${t.id}`}}});walk(c,'folder');}
  }};
  walk(tree,'organization');return assets;
}
async function collectScenario(s:Scenario){
  const parts:Normalized[]=[];
  if(s.azure)parts.push(await collectAzureWith(Object.keys(s.azure.subscriptions),async()=>'demo-token',azureTransport(s.azure.rows,s.azure.subscriptions,s.azure.tree)));
  for(const a of s.aws??[])parts.push(await collectAwsAccount(awsTransport(a.api),a.account,a.region,a.label));
  if(s.awsOrg)parts.push({resources:[],links:[],warnings:[],scopeLabels:{},hierarchy:await awsHierarchy(awsOrgTransport(s.awsOrg))});
  if(s.gcp)parts.push(await collectGcpWith(s.gcp.parent,gcpTransport([...s.gcp.assets,...(s.gcp.tree?gcpOrgAssets(s.gcp.tree):[])])));
  return finish(parts);
}
export async function mockSnapshot(id:ScenarioId='standard'){
  const scenario=fixtures[id],{resources,links,warnings,scopeLabels,hierarchy}=await collectScenario(scenario);
  const named=(name:string)=>{const r=resources.find(x=>x.name===name);if(!r)throw new Error(`Fixture ${id}: unknown resource ${name}`);return r;};
  for(const site of scenario.onprem??[]){
    const dc=ResourceSchema.parse({id:`onprem:${site.id}`,nativeId:`manual/onprem/${site.id}`,name:site.name,provider:'onprem',kind:'onprem',type:'Corporate network',scope:'corporate',region:site.region,cidr:site.cidr,status:'수동 등록',specs:{'네트워크':'사내망 · 수동 등록'},source:'수동 등록 경계'});
    resources.unshift(dc);scopeLabels.corporate='사내망';
    for(const c of site.connects)links.push({id:`attachment:${dc.id}:${named(c.name).id}`,source:dc.id,target:named(c.name).id,kind:'attachment',label:c.label,evidence:'수동 등록 — CSP API만으로 사내망 쪽을 복원할 수 없습니다.'});
  }
  addSyntheticTelemetry(resources);
  for(const flow of scenario.flows??[])links.push(...syntheticFlow(flow,named));
  const scopeCount=(p:string)=>new Set(resources.filter(r=>r.provider===p&&r.scope!=='external').map(r=>r.scope)).size;
  const connections:Connection[]=[];
  if(scenario.azure)connections.push({provider:'azure',status:'demo',api:'Azure Resource Graph',scopes:scopeCount('azure')});
  if(scenario.aws)connections.push({provider:'aws',status:'demo',api:'AWS Describe APIs',scopes:scopeCount('aws')});
  if(scenario.gcp)connections.push({provider:'gcp',status:'demo',api:'Cloud Asset Inventory',scopes:scopeCount('gcp')});
  return validateSnapshot({version:1,mode:'mock',scenario:id,collectedAt:new Date().toISOString(),resources,links,warnings,scopes:[...new Set(resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external').map(r=>r.scope))],scopeLabels,connections,hierarchy});
}
function addSyntheticTelemetry(resources:Resource[]){
  for(const [i,r] of resources.filter(r=>r.kind==='compute').entries()){
    if(!/stopped|deallocated|terminated|failed/i.test(r.status)){const cpu=18+(i*13)%62;r.metrics={cpu,memory:35+(i*17)%50,history:Array.from({length:12},(_,h)=>Math.max(4,Math.min(96,cpu+((h*7+i*5)%24)-12)))};}
    r.iam=[{principal:r.provider==='azure'?'platform-operators':r.provider==='aws'?'PlatformReadOnly':'platform@example.internal',role:r.provider==='azure'?'Reader':r.provider==='aws'?'ReadOnlyAccess':'roles/viewer',scope:r.scope}];
  }
}
function syntheticFlow({hops,rate}:{hops:string[];rate:string},named:(name:string)=>Resource):Link[]{
  return hops.slice(1).map((name,i)=>({id:`demo:${hops[i]}:${name}`,source:named(hops[i]).id,target:named(name).id,kind:'simulation' as const,label:'시연 트래픽',evidence:'명시적으로 작성한 시연 경로. 실제 패킷·경로 검증 결과가 아닙니다.',protocol:'TCP',ports:'443',rate}));
}
