import type {Change,Resource} from './schema.js';
const watched=(r:Resource)=>({상태:r.status,'사설 IP':r.ip??'','공인 IP':r.publicIp??'',CIDR:r.cidr??'',상위:r.parent??'',사양:JSON.stringify(r.specs),규칙:JSON.stringify(r.rules)});
export function diffResources(before:Resource[],after:Resource[]):Change[]{
  const prev=new Map(before.map(r=>[r.id,r])),next=new Map(after.map(r=>[r.id,r])),out:Change[]=[];
  const entry=(r:Resource,kind:Change['kind'],detail:string):Change=>({kind,id:r.id,name:r.name,provider:r.provider,scope:r.scope,detail});
  for(const r of after){
    const old=prev.get(r.id);if(!old){out.push(entry(r,'added','새로 수집됨'));continue;}
    const a=watched(old),b=watched(r),fields=(Object.keys(a) as (keyof typeof a)[]).filter(k=>a[k]!==b[k]);
    if(fields.length)out.push(entry(r,'changed',fields.map(f=>f==='사양'||f==='규칙'||f==='상위'?`${f} 변경`:`${f} ${a[f]||'없음'} → ${b[f]||'없음'}`).join(', ')));
  }
  // Only a successful collection reaches this point, so absence here means gone from the collected scope, not a failed call.
  for(const r of before)if(!next.has(r.id))out.push(entry(r,'removed','이번 수집에서 사라짐'));
  return out;
}
