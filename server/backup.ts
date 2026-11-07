import {createHash} from 'node:crypto';
import {cp,mkdir,readdir,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {validateSnapshot} from '../shared/schema.js';
import {FileSnapshotStore} from './store.js';
// Everything an operator would miss after losing the data folder: snapshots and their history, the audit trail, collection status and the hand-registered on-prem sites.
// Lock, temporary and probe files are left out; they describe a moment, not the data.
const skip=(name:string)=>name==='collect.lock'||name.endsWith('.tmp')||name.startsWith('.probe-');
type Entry={path:string;bytes:number;sha256:string};
export type Manifest={format:1;createdAt:string;files:Entry[]};
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
async function walk(root:string,dir=''):Promise<string[]>{
  const out:string[]=[];
  for(const d of await readdir(path.join(root,dir),{withFileTypes:true})){if(skip(d.name))continue;const rel=path.join(dir,d.name);if(d.isDirectory())out.push(...await walk(root,rel));else if(d.isFile())out.push(rel);}
  return out.sort();
}
const stamp=(at:string)=>at.replace(/[:.]/g,'-');
// Taken under the collection lock, so no run writes half a snapshot into the copy. Written to a temporary name first: a folder that exists is a finished backup.
export async function backupData(root:string,target:string,now=new Date()):Promise<{dir:string;manifest:Manifest}>{
  const inside=path.relative(path.resolve(root),path.resolve(target));
  if(!inside||(!inside.startsWith('..')&&!path.isAbsolute(inside)))throw new Error('백업은 데이터 폴더 밖에 두어야 합니다. 같은 디스크가 망가지면 함께 잃습니다.');
  const release=await new FileSnapshotStore(root).lock();
  if(!release)throw new Error('수집이 진행 중이라 백업하지 않습니다. 수집이 끝난 뒤 다시 실행하세요.');
  try{
    const createdAt=now.toISOString(),dir=path.join(target,`cloud-atlas-${stamp(createdAt)}`),tmp=`${dir}.partial`,files:Entry[]=[];
    await mkdir(tmp,{recursive:true,mode:0o700});
    try{
      for(const rel of await walk(root)){const data=await readFile(path.join(root,rel));await mkdir(path.dirname(path.join(tmp,rel)),{recursive:true,mode:0o700});await writeFile(path.join(tmp,rel),data,{mode:0o600});files.push({path:rel,bytes:data.length,sha256:sha(data)});}
      const manifest:Manifest={format:1,createdAt,files};
      await writeFile(path.join(tmp,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
      await rename(tmp,dir);
      return{dir,manifest};
    }catch(e){await rm(tmp,{recursive:true,force:true});throw e;}
  }finally{await release();}
}
// Checks a backup completely before anything is replaced: every file present with the recorded checksum, every snapshot one the server would accept.
export async function verifyBackup(dir:string):Promise<Manifest>{
  let manifest:Manifest;
  try{manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));}catch{throw new Error('manifest.json이 없거나 읽을 수 없습니다. Cloud Atlas 백업 폴더가 아닙니다.');}
  if(manifest.format!==1||!Array.isArray(manifest.files))throw new Error('지원하지 않는 백업 형식입니다.');
  for(const f of manifest.files){
    if(path.isAbsolute(f.path)||f.path.split(/[\\/]/).includes('..'))throw new Error(`백업 목록에 허용되지 않는 경로가 있습니다: ${f.path}`);
    let data:Buffer;try{data=await readFile(path.join(dir,f.path));}catch{throw new Error(`백업에 파일이 없습니다: ${f.path}`);}
    if(sha(data)!==f.sha256)throw new Error(`백업 파일이 손상됐습니다: ${f.path}`);
    if(/^(azure|aws|gcp|kubernetes)\.json$/.test(f.path)||/^history[\\/]/.test(f.path)){try{validateSnapshot(JSON.parse(data.toString('utf8')));}catch(e){throw new Error(`스냅샷 형식이 올바르지 않습니다: ${f.path} (${e instanceof Error?e.message.split('\n')[0]:''})`);}}
  }
  return manifest;
}
// The current folder is set aside, never deleted, so audit lines written after the backup can still be recovered by hand.
// The new folder is assembled beside the old one and swapped in with two renames.
export async function restoreData(root:string,backup:string,now=new Date()):Promise<{restored:number;previous?:string}>{
  const manifest=await verifyBackup(backup);
  const exists=await stat(root).then(()=>true,()=>false);
  const release=exists?await new FileSnapshotStore(root).lock():async()=>{};
  if(!release)throw new Error('수집이 진행 중이라 복구하지 않습니다. 서버를 멈추거나 수집이 끝난 뒤 다시 실행하세요.');
  const staging=`${root}.restoring-${stamp(now.toISOString())}`,previous=exists?`${root}.before-restore-${stamp(now.toISOString())}`:undefined;
  try{
    await mkdir(staging,{recursive:true,mode:0o700});
    for(const f of manifest.files){await mkdir(path.dirname(path.join(staging,f.path)),{recursive:true,mode:0o700});await cp(path.join(backup,f.path),path.join(staging,f.path));}
    if(previous)await rename(root,previous);
    await rename(staging,root);
    return{restored:manifest.files.length,previous};
  }catch(e){await rm(staging,{recursive:true,force:true});throw e;}
  finally{await release();}
}
