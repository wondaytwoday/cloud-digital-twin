import type {CrossRef,Link,Resource} from './schema.js';
// Joins relations whose two ends were collected separately (Kubernetes and a cloud). A reference that finds nothing is returned as unresolved,
// never turned into a placeholder resource: an unresolved node VM is a fact about the collection, not a new machine.
export function resolveCrossRefs(resources:Resource[],refs:CrossRef[]){
  const links:Link[]=[],unresolved:{source:string;kind:string;nativeId:string;label:string}[]=[];
  const byNative=new Map(resources.map(r=>[r.provider==='azure'?r.nativeId.toLowerCase():r.nativeId,r]));
  for(const ref of refs){
    const v=ref.provider==='azure'?ref.nativeId.toLowerCase():ref.nativeId;
    const hit=!ref.match||ref.match==='id'?byNative.get(v):ref.match==='suffix'?resources.find(r=>r.provider===ref.provider&&r.nativeId.endsWith(`/${ref.nativeId}`)):resources.find(r=>r.provider===ref.provider&&r.kind==='identity'&&(ref.match==='clientId'?r.specs['clientId']?.toLowerCase()===v.toLowerCase():r.specs['이메일']===ref.nativeId));
    if(!hit){unresolved.push({source:ref.source,kind:ref.kind,nativeId:ref.nativeId,label:ref.label});continue;}
    const [source,target]=ref.reverse?[hit.id,ref.source]:[ref.source,hit.id];
    links.push({id:`${ref.kind}:${source}:${target}`,source,target,kind:ref.kind,label:ref.label,evidence:ref.evidence,basis:'configured',ref:ref.nativeId});
  }
  return{links,unresolved};
}
