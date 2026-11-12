import {activityIdentity} from '../shared/activity.js';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {ActivitySchema,SnapshotValidationError,validateSnapshot,validateSnapshotIntegrity,type Snapshot} from '../shared/schema.js';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const Chunk=z.object({file:z.string().regex(/^activity\/(azure|aws|gcp)\/[a-f0-9]{64}\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.json$/),hash:z.string().regex(/^[a-f0-9]{64}$/),count:z.number().int().min(1).max(1000)}).strict();
const Manifest=z.object({storageVersion:z.literal(2),snapshot:z.unknown(),activity:z.array(Chunk)}).strict();
// Saved exports remain version 1. This format is private to FileSnapshotStore.
export async function readStoredSnapshot(root:string,input:unknown):Promise<Snapshot>{
  if(!input||typeof input!=='object'||!('storageVersion' in input))return validateSnapshot(input);
  const manifest=Manifest.parse(input),core=validateSnapshot(manifest.snapshot);
  if(core.activity.length)throw new SnapshotValidationError('Stored activity must be in chunks');
  const activity:Snapshot['activity']=[],ids=new Set<string>();
  for(const part of manifest.activity){
    let body:string;
    try{body=await readFile(path.join(root,part.file),'utf8');}
    catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')throw new SnapshotValidationError('Referenced activity chunk is missing',{cause});throw cause;}
    if(sha(body)!==part.hash)throw new SnapshotValidationError('Activity chunk integrity check failed');
    const rows=z.array(ActivitySchema).parse(JSON.parse(body));
    if(rows.length!==part.count)throw new SnapshotValidationError('Activity chunk count mismatch');
    const [,provider,scopeHash,day,filename]=part.file.split('/');
    if(filename!==`${part.hash}.json`)throw new SnapshotValidationError('Activity chunk name mismatch');
    for(const row of rows){
      if(row.provider!==provider||sha(row.scope)!==scopeHash||row.at.slice(0,10)!==day)throw new SnapshotValidationError('Activity chunk partition mismatch');
      if(ids.has(activityIdentity(row)))throw new SnapshotValidationError('Duplicate stored activity ID');ids.add(activityIdentity(row));activity.push(row);
    }
  }
  return validateSnapshotIntegrity({...core,activity:activity.sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id))});
}
export async function storeSnapshotParts(root:string,provider:string,input:Snapshot){
  const snapshot=validateSnapshot(input);
  const groups=new Map<string,Snapshot['activity']>();
  const unique=new Map(snapshot.activity.map(row=>[activityIdentity(row),row]));
  for(const row of unique.values()){
    if(row.provider!==provider)throw new Error('Activity provider does not match snapshot');
    const day=row.at.slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(row.at)))throw new Error('Invalid activity date');
    const key=`activity/${provider}/${sha(row.scope)}/${day}`;
    (groups.get(key)??groups.set(key,[]).get(key)!).push(row);
  }
  const chunks:z.infer<typeof Chunk>[]=[];
  for(const [dir,rows] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
    rows.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
    await mkdir(path.join(root,dir),{recursive:true,mode:0o700});
    for(let offset=0;offset<rows.length;offset+=1000){
      const page=rows.slice(offset,offset+1000),body=JSON.stringify(page),hash=sha(body),file=`${dir}/${hash}.json`;
      try{const existing=await readFile(path.join(root,file),'utf8');if(sha(existing)!==hash)throw new Error('Existing activity chunk integrity check failed');}
      catch(e){
        if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
        const temporary=path.join(root,`${file}.${randomUUID()}.tmp`);
        try{await writeFile(temporary,body,{mode:0o600});await rename(temporary,path.join(root,file));}finally{await rm(temporary,{force:true});}
      }
      chunks.push({file,hash,count:page.length});
    }
  }
  return Manifest.parse({storageVersion:2,snapshot:{...snapshot,activity:[]},activity:chunks});
}
// Run at most daily from the store. Keep anything referenced by a current or
// retained historical generation; a grace day protects writes not published yet.
export async function pruneActivityParts(root:string,now=Date.now()){
  const files:string[]=[];
  for(const provider of ['azure','aws','gcp']){
    files.push(path.join(root,`${provider}.json`));
    try{for(const file of await readdir(path.join(root,'history',provider)))if(file.endsWith('.json'))files.push(path.join(root,'history',provider,file));}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  const referenced=new Set<string>();
  for(const file of files){
    try{const value=JSON.parse(await readFile(file,'utf8'));if(value.storageVersion!==undefined){const manifest=Manifest.parse(value);validateSnapshot(manifest.snapshot);for(const part of manifest.activity)referenced.add(part.file);}}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
  }
  const walk=async(dir:string):Promise<void>=>{
    let entries;try{entries=await readdir(path.join(root,dir),{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    for(const entry of entries){
      const relative=`${dir}/${entry.name}`;
      if(entry.isDirectory())await walk(relative);
      else if(entry.isFile()&&!referenced.has(relative)&&(await stat(path.join(root,relative))).mtimeMs<now-86_400_000)await rm(path.join(root,relative));
    }
  };
  await walk('activity');
}
