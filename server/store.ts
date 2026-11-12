import {readStoredSnapshot,storeSnapshotParts,pruneActivityParts} from './activity-storage.js';
import {copyFile,mkdir,readdir,readFile,rename,rm,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {positiveSetting} from './async.js';
import {randomUUID} from 'node:crypto';
import {type Snapshot} from '../shared/schema.js';
import type {CollectionStatus} from './runner.js';
// The seam for a real database: everything else only sees this interface.
export interface SnapshotStore{
  latest(provider:string):Promise<Snapshot|null>;
  previous(provider:string):Promise<Snapshot|null>;
  save(provider:string,snapshot:Snapshot):Promise<void>;
  readStatus():Promise<CollectionStatus|null>;
  writeStatus(status:CollectionStatus):Promise<void>;
  revision?():Promise<string>;
}
const HISTORY_LIMIT=30;
const saves=new Map<string,Promise<void>>(),lastPruned=new Map<string,number>();
export class FileSnapshotStore implements SnapshotStore{
  private stamps=new Map<string,{revision:string;collectedAt:string}>();
  constructor(private root=process.env.SNAPSHOT_DIR??'data'){}
  async revision(){
    const previous=await Promise.all(['azure','aws','gcp'].map(async provider=>{const files=await this.history(provider);return files.length?`history/${provider}/${files.at(-1)}`:`history/${provider}/missing`;}));
    const files=[...previous,'azure.json','aws.json','gcp.json','status.json','onprem.json','history/azure','history/aws','history/gcp'];
    return (await Promise.all(files.map(async file=>{try{const s=await stat(path.join(this.root,file));return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return '-';throw e;}}))).join('|');
  }
  private read=async(file:string)=>{
    try{
      const info=await stat(file),revision=`${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const value=await readStoredSnapshot(this.root,JSON.parse(await readFile(file,'utf8')));
      this.stamps.set(file,{revision,collectedAt:value.collectedAt});
      if(this.stamps.size>8)this.stamps.delete(this.stamps.keys().next().value!);
      return value;
    }catch(e){this.stamps.delete(file);if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  };
  private async collectedAt(file:string){
    try{
      const info=await stat(file),revision=`${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const saved=this.stamps.get(file);
      if(saved?.revision===revision)return saved.collectedAt;
      return (await this.read(file))?.collectedAt;
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
  }
  latest(provider:string){return this.read(path.join(this.root,`${provider}.json`));}
  private history=async(provider:string)=>{try{return (await readdir(path.join(this.root,'history',provider))).filter(f=>f.endsWith('.json')).sort();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}};
  async previous(provider:string){const files=await this.history(provider),last=files[files.length-1];return last?this.read(path.join(this.root,'history',provider,last)):null;}
  async readStatus(){try{return JSON.parse(await readFile(path.join(this.root,'status.json'),'utf8')) as CollectionStatus;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
  async writeStatus(status:CollectionStatus){await mkdir(this.root,{recursive:true,mode:0o700});const file=path.join(this.root,'status.json'),tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(status),{mode:0o600});await rename(tmp,file);}
  // Written atomically and only after a validated collection, so a failed run never replaces the last good snapshot.
  save(provider:string,snapshot:Snapshot){
    const key=path.resolve(this.root,provider),previous=saves.get(key)??Promise.resolve();
    const task=previous.catch(()=>{}).then(()=>this.saveGeneration(provider,snapshot));
    saves.set(key,task);void task.finally(()=>{if(saves.get(key)===task)saves.delete(key);}).catch(()=>{});return task;
  }
  private async saveGeneration(provider:string,snapshot:Snapshot){
    const current=path.join(this.root,`${provider}.json`),dir=path.join(this.root,'history',provider);
    await mkdir(dir,{recursive:true,mode:0o700});
    const existingAt=await this.collectedAt(current);
    const temporary=`${current}.${randomUUID()}.tmp`;
    try{
      await writeFile(temporary,JSON.stringify(await storeSnapshotParts(this.root,provider,snapshot)),{mode:0o600});
      if(existingAt)await copyFile(current,path.join(dir,`${existingAt.replace(/[:.]/g,'-')}.json`));
      await rename(temporary,current);
    }finally{await rm(temporary,{force:true});}
    const files=await this.history(provider),keep=new Set(files.slice(-2)),days=new Set<string>();
    const cutoff=Date.parse(snapshot.collectedAt)-positiveSetting(process.env.ATLAS_HISTORY_DAYS,30,365)*86_400_000;
    for(const file of [...files].reverse()){
      const day=file.slice(0,10);
      if(!days.has(day)&&Date.parse(day)>=cutoff&&keep.size<HISTORY_LIMIT){keep.add(file);days.add(day);}
    }
    for(const old of files)if(!keep.has(old))await rm(path.join(dir,old));
    const root=path.resolve(this.root);
    if(Date.now()-(lastPruned.get(root)??0)>86_400_000){
      try{await pruneActivityParts(this.root);lastPruned.set(root,Date.now());if(lastPruned.size>8)lastPruned.delete(lastPruned.keys().next().value!);}catch{/* A corrupt manifest must never trigger activity deletion. Retry later. */}
    }
  }
}
