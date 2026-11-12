import {activityIdentity} from '../shared/activity.js';
import {collectionItems,resourceItem,type CollectionItem,type CollectionProvider} from '../shared/collection-items.js';
import type {ItemCollection,Snapshot} from '../shared/schema.js';
import {finish,type Normalized} from './normalize.js';

export function mergeSelected(result:Normalized,previous:Snapshot|null,provider:CollectionProvider,items:CollectionItem[],at:string):Normalized{
  const chosen=new Set(items),failed=new Set(result.incomplete),completed=new Set(result.collectedScopes);
  const incomingIds=new Set(result.resources.filter(r=>chosen.has(resourceItem(r))).map(r=>r.id));
  result={...result,resources:result.resources.filter(r=>r.kind==='external'||incomingIds.has(r.id)),
    links:result.links.filter(l=>incomingIds.has(l.source)),
    iam:chosen.has('iam')?result.iam:[],activity:chosen.has('activity')?result.activity:[],
  };
  const oldRecords=new Map((previous?.itemCollection??[]).map(r=>[JSON.stringify([r.provider,r.scope,r.item]),r]));
  const dataScopes=new Set([...previous?.scopes??[],...completed,...[...failed].filter(scope=>!result.iamIncomplete?.includes(scope))]);
  const iamScopes=new Set(result.iamCollectedScopes??result.collectedScopes),activityScopes=new Set(result.activityCollectedScopes??result.collectedScopes);
  const iamUnits=new Set([...iamScopes,...result.iamIncomplete??[]]),activityUnits=new Set([...activityScopes,...result.activityIncomplete??[]]);
  const scopes=new Set([...dataScopes,...(chosen.has('iam')?[...iamUnits,...previous?.iam.map(row=>row.scope)??[]]:[]),...(chosen.has('activity')?[...activityUnits,...previous?.activity.map(row=>row.scope)??[]]:[])]);
  const success=(scope:string,item:CollectionItem)=>chosen.has(item)&&(item==='iam'?iamScopes:item==='activity'?activityScopes:completed).has(scope)&&!failed.has(scope)&&
    !(item==='iam'&&result.iamIncomplete?.includes(scope))&&!(item==='activity'&&result.activityIncomplete?.includes(scope));
  for(const scope of scopes)for(const item of collectionItems){
    if(!chosen.has(item)||!dataScopes.has(scope)&&!(item==='iam'&&iamUnits.has(scope))&&!(item==='activity'&&activityUnits.has(scope)))continue;
    const unit=item==='cost'&&provider==='aws'?'organization':scope;
    const key=JSON.stringify([provider,unit,item]),old=oldRecords.get(key);
    const cost=result.costCoverage?.find(c=>c.provider===provider);
    const ok=item==='cost'?cost?.state==='complete':success(scope,item);
    const record:ItemCollection={provider,scope:unit,item,state:ok?'complete':completed.has(scope)?'partial':'failed',reason:ok?undefined:item==='activity'&&result.activityLimited?.includes(scope)?'limited':'failed',attemptedAt:at,collectedAt:ok?at:old?.collectedAt};
    oldRecords.set(key,record);
  }
  if(!previous)return {...result,itemCollection:[...oldRecords.values()]};
  const fresh=new Map(result.resources.filter(r=>r.kind!=='external').map(r=>[r.id,r]));
  const retained=previous.resources.filter(r=>r.kind!=='external'&&!fresh.has(r.id)&&!success(r.scope,resourceItem(r)));
  const retainedIds=new Set(retained.map(r=>r.id));
  let resources=[...result.resources.filter(r=>!retainedIds.has(r.id)),...retained];
  const ids=new Set(resources.map(r=>r.id)),before=new Map(previous.resources.map(r=>[r.id,r]));
  const links=previous.links.filter(l=>[l.source,l.target].some(id=>{const r=before.get(id);return r&&!success(r.scope,resourceItem(r));}));
  resources=resources.map(r=>{const parent=r.specs['미수집 상위 참조'];if(r.parent||!parent||!ids.has(parent))return r;const specs={...r.specs};delete specs['미수집 상위 참조'];return{...r,parent,specs};});
  const keepRecords=<T extends {id:string;scope:string}>(old:T[],fresh:T[],item:CollectionItem,key:(row:T)=>string=row=>row.id)=>{
    const ids=new Set(fresh.map(key));return [...fresh,...old.filter(r=>!ids.has(key(r))&&!success(r.scope,item))];
  };
  return finish([{...result,resources,links:[...links,...result.links],
    iam:keepRecords(previous.iam,result.iam??[],'iam'),activity:keepRecords(previous.activity,result.activity??[],'activity',activityIdentity),
    hierarchy:[...new Map([...previous.hierarchy,...result.hierarchy??[]].map(n=>[n.id,n])).values()],
    scopeLabels:{...previous.scopeLabels,...result.scopeLabels},collectedScopes:[...new Set([...previous.scopes,...result.collectedScopes??[]])],
    itemCollection:[...oldRecords.values()],
  }]);
}
