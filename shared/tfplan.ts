import {z} from 'zod';
import type {Resource,Snapshot} from './schema.js';
import {descendants,impactOf} from './topology.js';
// Reads `terraform show -json <plan>` and lines its changes up against the collected estate.
// Everything here is a configuration candidate: it says what a change touches in the last snapshot, not what will break.
// A plan can carry secrets in plain text, so this runs only in the browser and nothing of it is sent or stored.
const ChangeSchema=z.object({address:z.string(),type:z.string(),mode:z.string().optional(),change:z.object({actions:z.array(z.string()),before:z.unknown().optional(),after:z.unknown().optional()})});
const PlanSchema=z.object({format_version:z.string().optional(),terraform_version:z.string().optional(),resource_changes:z.array(ChangeSchema).default([])});
export type PlanAction='create'|'update'|'delete'|'replace';
export type Subject={resource:Resource;how:'id'|'parent'|'reference'};
export type Candidate={resource:Resource;why:string};
export type PlanImpact={address:string;type:string;action:PlanAction;subjects:Subject[];candidates:Candidate[];note?:string};
export type PlanReport={terraformVersion?:string;changes:PlanImpact[];ignored:number};

export function parsePlan(text:string){
  let json:unknown;try{json=JSON.parse(text);}catch{throw new Error('JSON이 아닙니다. terraform show -json <plan 파일> 의 출력을 올리세요.');}
  const plan=PlanSchema.safeParse(json);
  if(!plan.success||(json&&typeof json==='object'&&!('resource_changes' in json)&&!('format_version' in json)))throw new Error('Terraform plan JSON이 아닙니다. terraform plan -out=plan.tfplan 후 terraform show -json plan.tfplan 의 출력을 올리세요.');
  return plan.data;
}
const actionOf=(actions:string[]):PlanAction|undefined=>actions.includes('delete')&&actions.includes('create')?'replace':actions.includes('delete')?'delete':actions.includes('create')?'create':actions.includes('update')?'update':undefined;
// Collected IDs and Terraform IDs spell the same resource differently: Azure differs in case, AWS is collected as account/region/id, GCP as an asset name with a host.
const GCP_HOST=/^(https?:)?\/\/[^/]+\/(compute\/(v1|beta)\/)?/;
const keyOf=(r:Resource)=>r.provider==='azure'?r.nativeId.toLowerCase():r.provider==='aws'?r.nativeId.split('/').slice(2).join('/'):r.provider==='gcp'?r.nativeId.replace(GCP_HOST,''):r.nativeId;
function index(resources:Resource[]){
  const by=new Map<string,Resource>();for(const r of resources)if(r.provider!=='onprem'&&r.kind!=='external')by.set(keyOf(r),r);
  return(value:string):{resource:Resource;exact:boolean}|undefined=>{
    const direct=by.get(value)??by.get(value.toLowerCase())??by.get(value.replace(GCP_HOST,''));if(direct)return{resource:direct,exact:true};
    // An Azure child (an NSG rule, a route, a subnet association) belongs to the resource above it in the path.
    if(value.startsWith('/subscriptions/')){const parts=value.toLowerCase().split('/');for(let n=parts.length-2;n>=9;n-=2){const up=by.get(parts.slice(0,n).join('/'));if(up)return{resource:up,exact:false};}}
    return undefined;
  };
}
// Every string in an object, the way Terraform nests references (subnet_id, security_groups[], network_interface[0].subnetwork).
function strings(v:unknown,out:string[]=[],depth=0):string[]{
  if(depth>6||out.length>500)return out;
  if(typeof v==='string'){if(v.length<400)out.push(v);}else if(Array.isArray(v))for(const x of v)strings(x,out,depth+1);else if(v&&typeof v==='object')for(const x of Object.values(v))strings(x,out,depth+1);
  return out;
}
const idOf=(v:unknown)=>v&&typeof v==='object'&&typeof (v as {id?:unknown}).id==='string'?(v as {id:string}).id:undefined;
const CAP=200;
export function planImpact(snapshot:Pick<Snapshot,'resources'|'links'>,text:string):PlanReport{
  const plan=parsePlan(text),find=index(snapshot.resources),byId=new Map(snapshot.resources.map(r=>[r.id,r]));
  const appliedTo=new Map<string,string[]>();for(const l of snapshot.links)if(l.kind==='policy')(appliedTo.get(l.source)??appliedTo.set(l.source,[]).get(l.source)!).push(l.target);
  let ignored=0;const changes:PlanImpact[]=[];
  for(const rc of plan.resource_changes){
    const action=actionOf(rc.change.actions);if(!action||rc.mode==='data'){ignored++;continue;}
    const subjects=new Map<string,Subject>(),own=idOf(rc.change.before)??idOf(rc.change.after);
    const hit=own?find(own):undefined;if(hit)subjects.set(hit.resource.id,{resource:hit.resource,how:hit.exact?'id':'parent'});
    // Without its own match (a new rule, an association), the change attaches to whatever it references.
    if(!subjects.size)for(const s of [...strings(rc.change.before),...strings(rc.change.after)]){const m=find(s);if(m&&!subjects.has(m.resource.id))subjects.set(m.resource.id,{resource:m.resource,how:'reference'});}
    const candidates=new Map<string,Candidate>(),add=(id:string,why:string)=>{const r=byId.get(id);if(r&&!subjects.has(id)&&!candidates.has(id)&&candidates.size<CAP)candidates.set(id,{resource:r,why});};
    for(const {resource:r,how} of subjects.values()){
      // A policy reaches what it is applied to and everything inside that.
      if(r.kind==='firewall')for(const t of appliedTo.get(r.id)??[]){add(t,`${r.name} 정책이 적용됨`);for(const d of descendants(snapshot.resources,t))add(d,`${r.name} 정책이 적용되는 ${byId.get(t)?.name??''} 안에 있음`);}
      // Taking a resource away, or the whole resource being replaced, can strand what only reached on-prem through it.
      if((action==='delete'||action==='replace')&&how!=='reference')for(const id of impactOf(snapshot.resources,snapshot.links,r.id).lost)add(id,`${r.name}이(가) 사라지면 사내망으로 가는 구성 경로가 끊김`);
      for(const d of descendants(snapshot.resources,r.id))add(d,`${r.name} 안에 있음`);
    }
    changes.push({address:rc.address,type:rc.type,action,subjects:[...subjects.values()],candidates:[...candidates.values()],
      ...(!subjects.size?{note:action==='create'?'새로 만들어지는 자원이고, 참조하는 수집 자원을 찾지 못했습니다.':'수집된 자원과 맞는 ID가 없습니다. 아직 수집 전이거나, 지원하지 않는 종류이거나, 볼 수 없는 범위입니다.'}:{})});
  }
  const rank:Record<PlanAction,number>={delete:0,replace:1,update:2,create:3};
  changes.sort((a,b)=>rank[a.action]-rank[b.action]||b.candidates.length-a.candidates.length);
  return{terraformVersion:plan.terraform_version,changes,ignored};
}
