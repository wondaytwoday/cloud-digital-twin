import {appendFile,mkdir,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {AuditEventSchema,type AuditEvent} from '../shared/schema.js';
// Portal audit trail. Live mode appends one JSON line per event to a monthly file next to the snapshots; mock mode keeps a short list in memory,
// because the public demo has no disk to write and should not keep visitors' addresses.
const root=()=>join(process.env.SNAPSHOT_DIR??'data','audit');
const isLive=()=>process.env.DATA_MODE==='live';
const memory:AuditEvent[]=[];
const recent=new Map<string,number>();
// The same person reopening the same thing within a minute is one visit, not many.
const DEDUPE_MS=60_000;
export function actorOf(req:Request,name?:string){
  if(name)return name;
  if(isLive()&&process.env.ATLAS_LOOPBACK_ONLY==='1')return 'localhost';
  return isLive()?'익명':'방문자';
}
export async function audit(req:Request,event:Omit<AuditEvent,'id'|'at'|'ip'|'agent'>){
  const key=`${event.actor}|${event.action}|${event.target??''}`,now=Date.now();
  if(['view','open','denied'].includes(event.action)){const last=recent.get(key);if(last&&now-last<DEDUPE_MS)return;recent.set(key,now);if(recent.size>5000)recent.clear();}
  const full:AuditEvent={id:randomUUID(),at:new Date(now).toISOString(),...event,...(isLive()?{ip:req.ip,agent:String(req.headers['user-agent']??'').slice(0,160)}:{})};
  if(!isLive()){memory.unshift(full);memory.length=Math.min(memory.length,500);return;}
  try{await mkdir(root(),{recursive:true});await appendFile(join(root(),`${full.at.slice(0,7)}.jsonl`),JSON.stringify(full)+'\n');}
  catch(e){console.error('Audit write failed:',e instanceof Error?e.message:'unknown');}
}
// Reads the months that overlap the window, newest first. A damaged line is skipped, not fatal.
export async function readAudit(days=30,now=new Date()):Promise<AuditEvent[]>{
  const since=now.getTime()-days*86_400_000;
  if(!isLive())return memory.filter(e=>Date.parse(e.at)>=since);
  let files:string[]=[];try{files=(await readdir(root())).filter(f=>/^\d{4}-\d{2}\.jsonl$/.test(f));}catch{return [];}
  const months=new Set<string>();for(let t=since;t<=now.getTime()+86_400_000;t+=86_400_000*27)months.add(new Date(t).toISOString().slice(0,7));months.add(now.toISOString().slice(0,7));
  const out:AuditEvent[]=[];
  for(const f of files.filter(f=>months.has(f.slice(0,7)))){for(const line of (await readFile(join(root(),f),'utf8')).split('\n')){if(!line)continue;try{const e=AuditEventSchema.parse(JSON.parse(line));if(Date.parse(e.at)>=since)out.push(e);}catch{/* skip */}}}
  return out.sort((a,b)=>b.at.localeCompare(a.at));
}
export const resetAuditMemory=()=>{memory.length=0;recent.clear();};
