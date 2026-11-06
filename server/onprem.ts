import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {ResourceSchema,type Link,type Resource} from '../shared/schema.js';
export const SiteSchema=z.object({id:z.string(),name:z.string(),region:z.string(),cidr:z.string(),connects:z.array(z.object({name:z.string(),label:z.string()}))});
export type Site=z.infer<typeof SiteSchema>;
// CSP APIs cannot reconstruct the corporate side, so sites are registered by hand and attached to gateways by name.
export function applySites(sites:Site[],resources:Resource[],links:Link[],warnings:string[],scopeLabels:Record<string,string>){
  for(const site of sites){
    const dc=ResourceSchema.parse({id:`onprem:${site.id}`,nativeId:`manual/onprem/${site.id}`,name:site.name,provider:'onprem',kind:'onprem',type:'Corporate network',scope:'corporate',region:site.region,cidr:site.cidr,status:'수동 등록',specs:{'네트워크':'사내망 · 수동 등록'},source:'수동 등록 경계'});
    resources.unshift(dc);scopeLabels.corporate='사내망';
    for(const c of site.connects){
      const target=resources.find(r=>r.name===c.name&&r.provider!=='onprem');
      if(!target){warnings.push(`${site.name}: 연결 대상 ${c.name}을(를) 수집 결과에서 찾지 못했습니다.`);continue;}
      links.push({id:`attachment:${dc.id}:${target.id}`,source:dc.id,target:target.id,kind:'attachment',label:c.label,evidence:'수동 등록 — CSP API만으로 사내망 쪽을 복원할 수 없습니다.',basis:'declared',ref:'data/onprem.json'});
    }
  }
}
export async function readSites(root=process.env.SNAPSHOT_DIR??'data'):Promise<Site[]>{
  try{return z.array(SiteSchema).parse(JSON.parse(await readFile(`${root}/onprem.json`,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
}
