import {copyFile,mkdir,open,readdir,readFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {validateSnapshot,type Snapshot} from '../shared/schema.js';
import type {CollectionStatus} from './runner.js';
// The seam for a real database: everything else only sees this interface.
export interface SnapshotStore{
  latest(provider:string):Promise<Snapshot|null>;
  previous(provider:string):Promise<Snapshot|null>;
  save(provider:string,snapshot:Snapshot):Promise<void>;
  readStatus():Promise<CollectionStatus|null>;
  writeStatus(status:CollectionStatus):Promise<void>;
  // Resolves to a release function, or null while another process holds the lock.
  lock?():Promise<(()=>Promise<void>)|null>;
}
export const processAlive=(pid?:number)=>{if(!pid)return false;try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}};
// A lock from another host cannot be checked by PID, so it is trusted until it is clearly older than any run could take.
const FOREIGN_LOCK_HOURS=2;
const HISTORY_LIMIT=30;
// Flushed before it counts as written, so a crash right after a rename cannot leave an empty file in its place.
async function writeDurable(file:string,data:string){const handle=await open(file,'w',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}}
// The file operations a save depends on, injectable so tests can fail each step on purpose.
export type StoreFs={writeFile:(file:string,data:string)=>Promise<void>;copyFile:(from:string,to:string)=>Promise<void>;rename:(from:string,to:string)=>Promise<void>;rm:(file:string,options?:{force?:boolean})=>Promise<void>;mkdir:(dir:string,options:{recursive:true;mode:number})=>Promise<unknown>;readdir:(dir:string)=>Promise<string[]>;readFile:(file:string,encoding:'utf8')=>Promise<string>};
const nodeFs:StoreFs={writeFile:writeDurable,copyFile,rename,rm,mkdir,readdir,readFile};
export class FileSnapshotStore implements SnapshotStore{
  constructor(private root=process.env.SNAPSHOT_DIR??'data',private fs:StoreFs=nodeFs){}
  private read=async(file:string)=>{try{return validateSnapshot(JSON.parse(await this.fs.readFile(file,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
  latest(provider:string){return this.read(path.join(this.root,`${provider}.json`));}
  private history=async(provider:string)=>{try{return (await this.fs.readdir(path.join(this.root,'history',provider))).filter(f=>f.endsWith('.json')).sort();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}};
  async previous(provider:string){const files=await this.history(provider),last=files[files.length-1];return last?this.read(path.join(this.root,'history',provider,last)):null;}
  async readStatus(){try{return JSON.parse(await this.fs.readFile(path.join(this.root,'status.json'),'utf8')) as CollectionStatus;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
  async writeStatus(status:CollectionStatus){await this.fs.mkdir(this.root,{recursive:true,mode:0o700});const file=path.join(this.root,'status.json'),tmp=`${file}.${randomUUID()}.tmp`;try{await this.fs.writeFile(tmp,JSON.stringify(status));await this.fs.rename(tmp,file);}catch(e){await this.fs.rm(tmp,{force:true}).catch(()=>{});throw e;}}
  // Readiness: the folder can take a new snapshot. Only an error code comes back, never a path.
  async probe(){
    const file=path.join(this.root,`.probe-${randomUUID()}`);
    try{await this.fs.mkdir(this.root,{recursive:true,mode:0o700});await this.fs.writeFile(file,'');await this.fs.rm(file,{force:true});return{ok:true};}
    catch(e){return{ok:false,detail:(e as NodeJS.ErrnoException).code??'쓰기 실패'};}
  }
  // One collecting process per data folder on this host, so the server's timer and `npm run collect` never write the same files at once.
  // This is not a distributed lock: two hosts sharing a network folder are only kept apart by the age rule above.
  async lock(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    const file=path.join(this.root,'collect.lock'),me={pid:process.pid,host:hostname(),at:new Date().toISOString(),id:randomUUID()};
    for(let attempt=0;attempt<2;attempt++){
      try{const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(me));}finally{await handle.close();}
        return async()=>{try{if(JSON.parse(await readFile(file,'utf8')).id===me.id)await rm(file,{force:true});}catch{/* already gone */}};}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
      let held:{pid?:number;host?:string;at?:string}={};try{held=JSON.parse(await readFile(file,'utf8'));}catch{/* unreadable: treated as stale */}
      const live=held.host===me.host?processAlive(held.pid):Date.now()-Date.parse(held.at??'')<FOREIGN_LOCK_HOURS*3_600_000;
      if(live)return null;
      await rm(file,{force:true});
    }
    return null;
  }
  // The current file is only ever replaced by one rename of a complete, flushed copy. Until that rename, every step can fail and the last good snapshot is still what readers get.
  async save(provider:string,snapshot:Snapshot){
    const current=path.join(this.root,`${provider}.json`),dir=path.join(this.root,'history',provider),tmp=`${current}.${randomUUID()}.tmp`;
    // Validated here too, so nothing is written that latest() would then refuse to read.
    const body=JSON.stringify(validateSnapshot(snapshot),null,2);
    await this.fs.mkdir(dir,{recursive:true,mode:0o700});
    let archived:string|undefined;
    try{
      await this.fs.writeFile(tmp,body);
      // Copied, not moved: the current file stays in place while the new one is not yet there.
      const existing=await this.latest(provider).catch(()=>{console.error(`${provider}: 현재 스냅샷을 읽지 못해 이력에 남기지 않고 교체합니다.`);return null;});
      if(existing){const name=`${existing.collectedAt.replace(/[:.]/g,'-')}.json`;if(!(await this.history(provider)).includes(name)){archived=path.join(dir,name);await this.fs.copyFile(current,archived);}}
      await this.fs.rename(tmp,current);
    }catch(e){
      // A copy of the snapshot that is still current would read as "nothing changed" on the next diff.
      await Promise.all([tmp,...(archived?[archived]:[])].map(f=>this.fs.rm(f,{force:true}).catch(()=>{})));throw e;
    }
    // Pruning is housekeeping: a failure here leaves one extra file, never a missing snapshot.
    try{for(const old of (await this.history(provider)).slice(0,-HISTORY_LIMIT))await this.fs.rm(path.join(dir,old));}catch(e){console.error(`${provider}: 오래된 이력을 지우지 못했습니다.`,e instanceof Error?e.message:'');}
  }
}
