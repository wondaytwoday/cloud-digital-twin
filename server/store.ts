import {copyFile,mkdir,readdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateSnapshot,type Snapshot} from '../shared/schema.js';
import type {CollectionStatus} from './runner.js';
// The seam for a real database: everything else only sees this interface.
export interface SnapshotStore{
  latest(provider:string):Promise<Snapshot|null>;
  previous(provider:string):Promise<Snapshot|null>;
  save(provider:string,snapshot:Snapshot):Promise<void>;
  readStatus():Promise<CollectionStatus|null>;
  writeStatus(status:CollectionStatus):Promise<void>;
}
const HISTORY_LIMIT=30;
export class FileSnapshotStore implements SnapshotStore{
  constructor(private root=process.env.SNAPSHOT_DIR??'data'){}
  private read=async(file:string)=>{try{return validateSnapshot(JSON.parse(await readFile(file,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
  latest(provider:string){return this.read(path.join(this.root,`${provider}.json`));}
  private history=async(provider:string)=>{try{return (await readdir(path.join(this.root,'history',provider))).filter(f=>f.endsWith('.json')).sort();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}};
  async previous(provider:string){const files=await this.history(provider),last=files[files.length-1];return last?this.read(path.join(this.root,'history',provider,last)):null;}
  async readStatus(){try{return JSON.parse(await readFile(path.join(this.root,'status.json'),'utf8')) as CollectionStatus;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
  async writeStatus(status:CollectionStatus){await mkdir(this.root,{recursive:true,mode:0o700});const file=path.join(this.root,'status.json'),tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(status),{mode:0o600});await rename(tmp,file);}
  // Written atomically and only after a validated collection, so a failed run never replaces the last good snapshot.
  async save(provider:string,snapshot:Snapshot){
    const current=path.join(this.root,`${provider}.json`),dir=path.join(this.root,'history',provider);
    await mkdir(dir,{recursive:true,mode:0o700});
    const existing=await this.latest(provider);
    const temporary=`${current}.${randomUUID()}.tmp`;
    try{
      await writeFile(temporary,JSON.stringify(validateSnapshot(snapshot),null,2),{mode:0o600});
      if(existing)await copyFile(current,path.join(dir,`${existing.collectedAt.replace(/[:.]/g,'-')}.json`));
      await rename(temporary,current);
    }finally{await rm(temporary,{force:true});}
    for(const old of (await this.history(provider)).slice(0,-HISTORY_LIMIT))await rm(path.join(dir,old));
  }
}
