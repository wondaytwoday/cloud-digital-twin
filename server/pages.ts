import {activityIdentity} from '../shared/activity.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Snapshot} from '../shared/schema.js';
import {ResourceKind} from '../shared/schema.js';
import {ResourcePage,ActivityPage,sensitiveActivity} from '../shared/page-contracts.js';
import {categoryOf,fleetTotals,capacityOf,capacityIssues,countBy,statusCounts,CATEGORIES} from '../shared/capacity.js';
import {resourceSearchIndex,searchKey} from '../shared/search.js';
import {isAuxiliary} from '../shared/classification.js';
import {health} from '../shared/topology.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revisions=new WeakMap<Snapshot,string>();
const revisionOf=(snapshot:Snapshot)=>{let value=revisions.get(snapshot);if(!value){value=hash([snapshot.mode,snapshot.resources,snapshot.activity,snapshot.scopeLabels,snapshot.itemCollection]);revisions.set(snapshot,value);}return value;};
const Cursor=z.object({revision:z.string(),filter:z.string(),offset:z.number().int().min(0),limit:z.number().int().min(1).max(100)}).strict();
export class PageError extends Error{constructor(public status:number,message:string){super(message);}}
function page<T>(rows:T[],snapshot:Snapshot,query:URLSearchParams,filters:unknown){
  const revision=revisionOf(snapshot),filter=hash(filters),raw=query.get('cursor'),limit=Number(query.get('limit')??100);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new PageError(400,'페이지 크기는 1~100이어야 합니다.');
  let offset=0;
  if(raw){
    let cursor:z.infer<typeof Cursor>;
    try{if(raw.length>1024||!/^[A-Za-z0-9_-]+$/.test(raw))throw new Error();cursor=Cursor.parse(JSON.parse(Buffer.from(raw,'base64url').toString('utf8')));}
    catch{throw new PageError(400,'올바르지 않은 페이지 커서입니다.');}
    if(cursor.revision!==revision)throw new PageError(409,'수집 데이터가 갱신됐습니다. 첫 페이지부터 다시 조회하세요.');
    if(cursor.filter!==filter||cursor.limit!==limit)throw new PageError(400,'조회 조건이 바뀌었습니다. 첫 페이지부터 다시 조회하세요.');
    if(cursor.offset>rows.length)throw new PageError(400,'페이지 범위를 확인하세요.');
    offset=cursor.offset;
  }
  const next=offset+limit;
  return{revision,total:rows.length,rows:rows.slice(offset,next),...(next<rows.length?{nextCursor:Buffer.from(JSON.stringify({revision,filter,offset:next,limit})).toString('base64url')}:{})};
}
function scopeFilter(query:URLSearchParams){
  const provider=query.get('provider')??'all',scopes=[...new Set(query.getAll('scope'))].sort();
  if(!['all','azure','aws','gcp','onprem'].includes(provider)||scopes.length>2000)throw new PageError(400,'조회 범위를 확인하세요.');
  const hasScopes=query.get('scoped')==='1',allowed=new Set(scopes);
  return{provider,scopes,hasScopes,matches:(r:{provider:string;scope:string})=>(provider==='all'||r.provider===provider)&&(!hasScopes||allowed.has(r.scope))};
}
const collator=new Intl.Collator('ko',{numeric:true});
export function resourcePage(snapshot:Snapshot,query:URLSearchParams){
  const scope=scopeFilter(query),q=searchKey(query.get('q')??''),category=query.get('category')??'all',kind=query.get('kind')??'all',state=query.get('state')??'all',sort=query.get('sort')??'name',dir=query.get('dir')??'1',auxiliary=query.get('auxiliary')==='1';
  if((category!=='all'&&!CATEGORIES.some(c=>c.id===category))||(kind!=='all'&&!ResourceKind.safeParse(kind).success)||!['all','ok','warn','stopped','unknown','neutral'].includes(state)||!['name','provider','kind','scope','address','region','status','size'].includes(sort)||!['1','-1'].includes(dir)||q.length>300)throw new PageError(400,'리소스 조회 조건을 확인하세요.');
  const index=resourceSearchIndex(snapshot);
  const all=snapshot.resources.filter(r=>scope.matches(r)&&(auxiliary||!isAuxiliary(r))&&(!q||index.get(r.id)?.includes(q)));
  const vms=all.filter(r=>r.kind==='compute'),fleet=fleetTotals(vms),capacity=vms.filter(r=>health(r.status)!=='stopped').map(capacityOf);
  const summary={total:all.length,vm:fleet.count,capacityTargets:capacity.length,vcpuKnown:capacity.filter(c=>c.vcpu!==undefined).length,memoryKnown:capacity.filter(c=>c.memoryGiB!==undefined).length,vcpu:fleet.vcpu,memoryGiB:fleet.memoryGiB,unsized:fleet.unsized,diskGiB:fleet.diskGiB,gpus:fleet.gpus,gpuHosts:fleet.gpuHosts,sizeIssues:capacityIssues(vms).slice(0,20),sizes:countBy(vms,r=>r.specs['인스턴스']??'미확인').slice(0,20).map(([name,count])=>({name,count})),engines:countBy(all.filter(r=>r.kind==='database'),r=>r.specs['종류']??r.type).slice(0,20).map(([name,count])=>({name,count})),unknownTypes:countBy(all.filter(r=>r.kind==='service'),r=>`${r.provider} · ${r.type}`).slice(0,10).map(([name,count])=>({name,count})),kinds:countBy(all,r=>r.kind).map(([kind,count])=>({kind,count})),states:statusCounts(all),providers:countBy(all,r=>r.provider).map(([provider,count])=>({provider,count}))};
  const value=(r:Snapshot['resources'][number])=>sort==='scope'?snapshot.scopeLabels[r.scope]??r.scope:sort==='address'?r.ip??r.cidr??'':sort==='size'?r.specs['인스턴스']??r.specs['종류']??'':r[sort as 'name'];
  const rows=all.filter(r=>(category==='all'||categoryOf(r.kind)===category)&&(kind==='all'||r.kind===kind)&&(state==='all'||health(r.status)===state)).sort((a,b)=>Number(dir)*collator.compare(value(a),value(b))||a.id.localeCompare(b.id));
  const paged=page(rows,snapshot,query,[scope.provider,scope.scopes,scope.hasScopes,q,category,kind,state,sort,dir,auxiliary]);
  return ResourcePage.parse({...paged,version:1,rows:paged.rows.map(r=>({id:r.id,name:r.name,type:r.type,provider:r.provider,scope:r.scope,kind:r.kind,region:r.region,status:r.status,ip:r.ip,cidr:r.cidr,size:r.specs['인스턴스']??r.specs['종류']})),summary});
}
export function activityPage(snapshot:Snapshot,query:URLSearchParams){
  const scope=scopeFilter(query),days=Number(query.get('days')??7),q=searchKey(query.get('q')??''),actor=query.get('actor')??'all',kind=query.get('kind')??'all';
  if(!Number.isInteger(days)||days<1||days>30||q.length>300||actor.length>500||!['all','write','delete','action','failed','sensitive'].includes(kind))throw new PageError(400,'활동 기록 조회 조건을 확인하세요.');
  // Anchor the date window to the snapshot generation, so a cursor does not
  // silently change its result set while the wall clock advances.
  const since=Date.parse(snapshot.collectedAt)-days*86_400_000;
  const all=[...new Map(snapshot.activity.filter(r=>scope.matches(r)&&Date.parse(r.at)>=since).map(r=>[activityIdentity(r),r])).values()];
  const actorCount=new Set(all.map(r=>r.actor)).size,actors=countBy(all,r=>r.actor).slice(0,200).map(([actor])=>actor),daily=new Map<string,{day:string;provider:Snapshot['activity'][number]['provider'];count:number}>();
  for(const row of all){const day=row.at.slice(0,10),key=JSON.stringify([day,row.provider]),old=daily.get(key);if(old)old.count++;else daily.set(key,{day,provider:row.provider,count:1});}
  const rows=all.filter(r=>(actor==='all'||r.actor===actor)&&(kind==='all'||kind==='failed'&&r.outcome==='failed'||kind==='sensitive'&&sensitiveActivity.test(r.operation)||r.kind===kind)&&(!q||searchKey(`${r.actor} ${r.targetName} ${r.label} ${r.operation} ${r.ip??''}`).includes(q))).sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id));
  const records=snapshot.itemCollection.filter(r=>r.item==='activity'&&scope.matches(r)),dates=records.flatMap(r=>r.collectedAt?[r.collectedAt]:[]).sort();
  const coverage={verified:records.length>0,incompleteScopes:new Set(records.filter(r=>r.state!=='complete').map(r=>r.scope)).size,limitedScopes:new Set(records.filter(r=>r.reason==='limited').map(r=>r.scope)).size,lastCompleteAt:dates[0]};
  return ActivityPage.parse({coverage,...page(rows,snapshot,query,[scope.provider,scope.scopes,scope.hasScopes,days,q,actor,kind]),version:1,actors,summary:{total:all.length,failed:all.filter(r=>r.outcome==='failed').length,sensitive:all.filter(r=>sensitiveActivity.test(r.operation)).length,actors:actorCount,daily:[...daily.values()].sort((a,b)=>a.day.localeCompare(b.day)),kinds:countBy(all,r=>r.kind).map(([kind,count])=>({kind,count}))}});
}
