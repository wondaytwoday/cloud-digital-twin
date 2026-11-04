// Deterministic API-shaped cost, IAM, and non-network inventory. Synthetic; never customer data.
import type {Raw} from './types.js';
export const seed=(text:string)=>[...text].reduce((h,c)=>(h*31+c.charCodeAt(0))%100_003,7);
const SERVICES:Record<string,[string,number][]>={
  azure:[['Virtual Machines',.42],['SQL Database',.2],['Bandwidth',.08],['Storage',.12],['Azure Kubernetes Service',.13],['Log Analytics',.05]],
  aws:[['Amazon Elastic Compute Cloud - Compute',.45],['Amazon Relational Database Service',.2],['AWS Data Transfer',.07],['Amazon Simple Storage Service',.1],['Amazon Elastic Kubernetes Service',.12],['AmazonCloudWatch',.06]],
  gcp:[['Compute Engine',.4],['Cloud SQL',.18],['Networking',.08],['Cloud Storage',.1],['Kubernetes Engine',.14],['BigQuery',.1]],
};
export function monthsBack(now:Date,count=6){return Array.from({length:count},(_,i)=>{const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-(count-1-i),1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;});}
export type CostPoint={scope:string;service:string;month:string;amount:number};
export function costPoints(provider:string,scopes:string[],now:Date):CostPoint[]{
  const months=monthsBack(now),day=now.getUTCDate(),days=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0)).getUTCDate();
  return scopes.flatMap(scope=>{
    const h=seed(`${provider}:${scope}`),base=1500+h%9000,trend=(h%9-3)/100;
    // One scope in seven has a real jump in its largest service, so the anomaly view has something true to find.
    const spikes=h%7===0;
    return SERVICES[provider].flatMap(([service,share],s)=>months.map((month,m)=>{
      const wobble=1+((seed(`${scope}${service}${month}`)%11)-5)/100,jump=spikes&&s===0&&m>=months.length-2?1.6:1,partial=m===months.length-1?day/days:1;
      return{scope,service,month,amount:Math.round(base*share*(1+trend*m)*wobble*jump*partial*100)/100};
    }));
  });
}
const guid=(text:string)=>{const h=String(seed(text)).padStart(12,'0');return `aaaaaaaa-0000-4000-8000-${h}`;};
const ROLES:Record<string,string>={Owner:'8e3af657-a8ff-443c-a75c-2fe8c4bcb635',Contributor:'b24988ac-6180-42a0-ab88-20f7382dd24c',Reader:'acdd72a7-3385-48ef-bd42-f606fba81ae7'};
export function azureIam(subscriptions:string[],names:Record<string,string>){
  const rows:Raw[]=[],directory:Record<string,string>={};
  const defs=Object.entries(ROLES).map(([roleName,id])=>({id:`/providers/Microsoft.Authorization/RoleDefinitions/${id}`,type:'microsoft.authorization/roledefinitions',properties:{roleName}}));
  const assign=(sub:string,principal:string,principalType:string,role:string)=>{const id=guid(principal);directory[id]=principal;rows.push({id:`/subscriptions/${sub}/providers/Microsoft.Authorization/roleAssignments/${guid(sub+principal+role)}`,type:'microsoft.authorization/roleassignments',subscriptionId:sub,properties:{principalId:id,principalType,scope:`/subscriptions/${sub}`,roleDefinitionId:`/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${ROLES[role]}`}});};
  subscriptions.forEach((sub,i)=>{
    assign(sub,'platform-admins','Group','Contributor');assign(sub,'sp-cicd-deploy','ServicePrincipal',i%3===0?'Owner':'Contributor');assign(sub,'security-readers','Group','Reader');
    if(/dev|sandbox/i.test(names[sub]??''))assign(sub,'dev.lead@atlas.example','User','Owner');
  });
  return{rows:[...defs,...rows],directory};
}
const old=(now:Date,days:number)=>new Date(now.getTime()-days*86_400_000).toISOString();
export function awsIamApi(account:string,label:string,now:Date){
  const h=seed(account),users=[{UserName:'ci-deploy'},...(h%2===0||/prod/.test(label)?[{UserName:'legacy-admin'}]:[])];
  const external=h%3===0?JSON.stringify({Statement:[{Principal:{AWS:'arn:aws:iam::900000000002:root'}}]}):JSON.stringify({Statement:[{Principal:{Service:'ec2.amazonaws.com'}}]});
  const attached=(name:string)=>({AttachedPolicies:[{PolicyName:name}]});
  return{
    ListUsers:{Users:users},
    ListAttachedUserPolicies:(i:Raw)=>i.UserName==='legacy-admin'?attached('AdministratorAccess'):attached('AmazonEC2FullAccess'),
    ListGroupsForUser:{Groups:[]},ListAttachedGroupPolicies:{AttachedPolicies:[]},
    ListMFADevices:(i:Raw)=>({MFADevices:i.UserName==='legacy-admin'?[]:[{SerialNumber:'x'}]}),
    ListAccessKeys:(i:Raw)=>({AccessKeyMetadata:[{Status:'Active',CreateDate:old(now,i.UserName==='legacy-admin'?412:48+(h%60))}]}),
    ListRoles:{Roles:[{RoleName:'AtlasReader',Path:'/',AssumeRolePolicyDocument:encodeURIComponent(JSON.stringify({Statement:[{Principal:{Service:'sts.amazonaws.com'}}]}))},{RoleName:label.includes('network')?'NetworkAdmin':'PlatformAdmin',Path:'/',AssumeRolePolicyDocument:encodeURIComponent(JSON.stringify({Statement:[{Principal:{Service:'sso.amazonaws.com'}}]}))},{RoleName:'VendorSupport',Path:'/',AssumeRolePolicyDocument:encodeURIComponent(external)},{RoleName:'AWSServiceRoleForSupport',Path:'/aws-service-role/x/'}]},
    ListAttachedRolePolicies:(i:Raw)=>attached(i.RoleName==='AtlasReader'?'ViewOnlyAccess':i.RoleName==='VendorSupport'?'SupportUser':'AdministratorAccess'),
  };
}
export const awsResources=(account:string,label:string,region:string)=>[
  {Arn:`arn:aws:s3:::${label}-assets`,ResourceType:'s3:bucket',Region:region,OwningAccountId:account},
  {Arn:`arn:aws:s3:::${label}-logs`,ResourceType:'s3:bucket',Region:region,OwningAccountId:account},
  {Arn:`arn:aws:lambda:${region}:${account}:function:${label}-events`,ResourceType:'lambda:function',Region:region,OwningAccountId:account},
  {Arn:`arn:aws:dynamodb:${region}:${account}:table/${label}-sessions`,ResourceType:'dynamodb:table',Region:region,OwningAccountId:account},
  {Arn:`arn:aws:ec2:${region}:${account}:vpc/already-described`,ResourceType:'ec2:vpc',Region:region,OwningAccountId:account},
];
export const azureServices=(sub:string,rg:string,slug:string,location='koreacentral')=>[
  {id:`/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.KeyVault/vaults/kv-${slug}`,name:`kv-${slug}`,type:'Microsoft.KeyVault/vaults',location,subscriptionId:sub,resourceGroup:rg,tags:{},properties:{provisioningState:'Succeeded'}},
  {id:`/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Web/sites/app-${slug}`,name:`app-${slug}`,type:'Microsoft.Web/sites',location,subscriptionId:sub,resourceGroup:rg,tags:{},properties:{state:'Running'}},
];
export const gcpServices=(project:string)=>[
  {name:`//storage.googleapis.com/${project}-assets`,assetType:'storage.googleapis.com/Bucket',resource:{location:'asia-northeast3',data:{name:`${project}-assets`}},project},
  {name:`//run.googleapis.com/projects/${project}/locations/asia-northeast3/services/${project}-api`,assetType:'run.googleapis.com/Service',resource:{location:'asia-northeast3',data:{name:`${project}-api`}}},
  {name:`//bigquery.googleapis.com/projects/${project}/datasets/analytics`,assetType:'bigquery.googleapis.com/Dataset',resource:{location:'asia-northeast3',data:{name:'analytics'}}},
];
export const gcpPolicies=(projects:string[],org:{id:string;domain:string}|null,numbers:Map<string,string>)=>{
  const assets:Raw[]=[];
  if(org)assets.push({name:`//cloudresourcemanager.googleapis.com/organizations/${org.id}`,assetType:'cloudresourcemanager.googleapis.com/Organization',iamPolicy:{bindings:[{role:'roles/resourcemanager.organizationAdmin',members:[`group:cloud-admins@${org.domain}`]},{role:'roles/owner',members:[`user:root.admin@${org.domain}`]}]}});
  for(const p of projects){const domain=org?.domain??'atlas.example',bindings:Raw[]=[{role:'roles/editor',members:[`serviceAccount:deployer@${p}.iam.gserviceaccount.com`]},{role:'roles/viewer',members:[`group:readers@${domain}`]}];if(/sandbox/.test(p))bindings.push({role:'roles/editor',members:['user:contractor@partner.example']});const n=String(100000+seed(p));numbers.set(p,n);assets.push({name:`//cloudresourcemanager.googleapis.com/projects/${n}`,assetType:'cloudresourcemanager.googleapis.com/Project',iamPolicy:{bindings}});}
  return assets;
};
