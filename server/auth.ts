import {createHash,timingSafeEqual} from 'node:crypto';
import type {NextFunction,Request,RequestHandler,Response} from 'express';
import {z} from 'zod';
import type {Snapshot} from '../shared/schema.js';
import {audit} from './audit.js';
const COOKIE='atlas_session';
// Scopes decide what a token can read; roles decide what it can do. Seeing everything grants no action by itself.
export const ROLES={operator:'수집 실행·상태 조회',auditor:'포털 접근 기록 조회'} as const;
export type Role=keyof typeof ROLES;
const AccessEntry=z.object({name:z.string(),tokenSha256:z.string().regex(/^[a-f0-9]{64}$/),scopes:z.array(z.string()).min(1),roles:z.array(z.enum(Object.keys(ROLES) as [Role,...Role[]])).default([])});
export type AccessEntry=z.infer<typeof AccessEntry>;
const sha256=(v:string)=>createHash('sha256').update(v).digest('hex');
export const accessEntries=(env:NodeJS.ProcessEnv=process.env):AccessEntry[]=>z.array(AccessEntry).parse(JSON.parse(env.ACCESS_TOKENS?.trim()||'[]'));
export function findEntry(token:string|undefined){
  if(!token)return undefined;
  const digest=Buffer.from(sha256(token));
  return accessEntries().find(e=>{const known=Buffer.from(e.tokenSha256);return known.length===digest.length&&timingSafeEqual(known,digest);});
}
const cookieToken=(req:Request)=>req.headers.cookie?.split(/;\s*/).find(c=>c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
export const requestToken=(req:Request)=>req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]??(cookieToken(req)?decodeURIComponent(cookieToken(req)!):undefined);
const attempts=new Map<string,{count:number;until:number}>();
const allowAttempt=(key:string)=>{const now=Date.now(),a=attempts.get(key);if(!a||a.until<now){attempts.set(key,{count:1,until:now+60_000});return true;}a.count++;return a.count<=10;};
const isLive=()=>process.env.DATA_MODE==='live';
// Real inventory reveals the whole network, so live mode fails closed unless access is configured or the server is loopback-only.
export const requireAccess:RequestHandler=(req:Request,res:Response,next:NextFunction)=>{
  if(!isLive())return next();
  if(accessEntries().length){const entry=findEntry(requestToken(req));if(!entry){audit(req,{actor:'인증 안 됨',action:'denied',target:req.path});res.status(401).json({error:'로그인이 필요합니다.'});return;}res.locals.access=entry;return next();}
  // Without a token, a page on any website could reach this through DNS rebinding unless the Host is checked too.
  if(process.env.ATLAS_LOOPBACK_ONLY==='1'){if(['127.0.0.1','localhost','[::1]'].includes(req.hostname))return next();res.status(403).json({error:'localhost로만 접근할 수 있습니다.'});return;}
  res.status(503).json({error:'접근 제어가 설정되지 않아 실제 데이터를 제공하지 않습니다. ACCESS_TOKENS를 설정하세요.'});
};
// Without an access entry there is one local user (mock data, or a loopback-only live server), who runs everything.
// A role also needs every scope: collection status and the access log speak about all scopes, which a restricted token must not read.
export const requireRole=(role:Role):RequestHandler=>(req,res,next)=>{
  const access=res.locals.access as AccessEntry|undefined;if(!access)return next();
  const refusal=!access.roles.includes(role)?{error:`${ROLES[role]}에는 ${role} 역할이 필요합니다.`,detail:`${role} 역할 없음`}:!access.scopes.includes('*')?{error:`${ROLES[role]}은 전체 범위(*) 토큰에만 허용됩니다.`,detail:`${role} 역할, 전체 범위 아님`}:undefined;
  if(refusal){audit(req,{actor:access.name,action:'denied',target:req.path,detail:refusal.detail});res.status(403).json({error:refusal.error});return;}
  next();
};
export function sessionRoutes(app:import('express').Express){
  app.get('/api/session',(req,res)=>{const required=isLive()&&accessEntries().length>0,entry=required?findEntry(requestToken(req)):undefined;res.json({required,authenticated:!required||!!entry,name:entry?.name,roles:entry?.roles});});
  app.post('/api/session',(req,res)=>{
    if(!allowAttempt(req.ip??'unknown')){audit(req,{actor:'알 수 없음',action:'login_failed',detail:'시도 횟수 초과'});res.status(429).json({error:'시도가 너무 많습니다. 잠시 후 다시 시도하세요.'});return;}
    const token=typeof req.body?.token==='string'?req.body.token:undefined;
    const entry=findEntry(token);
    if(!entry){audit(req,{actor:'알 수 없음',action:'login_failed',detail:'잘못된 토큰'});res.status(401).json({error:'접근 토큰이 올바르지 않습니다.'});return;}
    audit(req,{actor:entry.name,action:'login'});
    res.cookie(COOKIE,token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',path:'/api',maxAge:8*3600_000});res.json({ok:true});
  });
  app.delete('/api/session',(req,res)=>{const entry=findEntry(requestToken(req));if(entry)audit(req,{actor:entry.name,action:'logout'});res.clearCookie(COOKIE,{path:'/api'});res.json({ok:true});});
}
// Server-side, so a restricted user's browser never receives other scopes at all.
// Every field is listed on purpose: the type below fails to compile when the schema gains a field, so nothing reaches a restricted user until someone decides how to filter it.
export function restrictSnapshot(snapshot:Snapshot,scopes:string[]):Snapshot{
  if(scopes.includes('*'))return snapshot;
  const allowed=new Set(scopes),mine=(scope:string)=>allowed.has(scope);
  // Copied, so dropping a parent outside the user's scopes never edits the snapshot other requests read.
  const resources=snapshot.resources.filter(r=>mine(r.scope)).map(r=>({...r})),ids=new Set(resources.map(r=>r.id));
  for(const r of resources)if(r.parent&&!ids.has(r.parent))delete r.parent;
  // A route of the user's own may point at a device in a scope they cannot see: the address they configured stays, the device's ID does not.
  for(const r of resources)if(r.routes.some(x=>x.target&&!ids.has(x.target)))r.routes=r.routes.map(({target,...x})=>target&&!ids.has(target)?x:{...x,...(target?{target}:{})});
  const keep=new Set<string>();const nodes=new Map(snapshot.hierarchy.map(n=>[n.id,n]));
  for(const n of snapshot.hierarchy)if(n.scope&&mine(n.scope))for(let c:typeof n|undefined=n;c;c=c.parent?nodes.get(c.parent):undefined)keep.add(c.id);
  const incomplete=snapshot.incomplete.filter(mine);
  // A provider-wide status speaks for scopes this user cannot see, so only what holds for their own scopes is kept: no message, no total.
  const providerOf=new Map([...snapshot.hierarchy.filter(n=>n.scope).map(n=>[n.scope!,n.provider] as const),...resources.map(r=>[r.scope,r.provider] as const)]);
  const connections=snapshot.connections.flatMap(c=>{
    const own=[...allowed].filter(s=>providerOf.get(s)===c.provider);if(!own.length)return [];
    const status=c.status==='partial'&&!own.some(s=>incomplete.includes(s))?'collected':c.status;
    return [{provider:c.provider,status,api:c.api,scopes:own.length,...(c.collectedAt?{collectedAt:c.collectedAt}:{}),...(c.stale!==undefined?{stale:c.stale}:{}),...(c.datasets?{datasets:c.datasets}:{})}];
  });
  const restricted:{[K in keyof Required<Snapshot>]:Snapshot[K]}={
    version:snapshot.version,mode:snapshot.mode,scenario:snapshot.scenario,collectedAt:snapshot.collectedAt,costAt:snapshot.costAt,fx:snapshot.fx,ownership:snapshot.ownership,
    resources,links:snapshot.links.filter(l=>ids.has(l.source)&&ids.has(l.target)),hierarchy:snapshot.hierarchy.filter(n=>keep.has(n.id)),
    scopes:snapshot.scopes.filter(mine),scopeLabels:Object.fromEntries(Object.entries(snapshot.scopeLabels).filter(([k])=>mine(k))),incomplete,
    cost:snapshot.cost.filter(c=>mine(c.scope)),activity:snapshot.activity.filter(a=>mine(a.scope)),iam:snapshot.iam.filter(a=>mine(a.scope)),
    changes:snapshot.changes?{since:snapshot.changes.since,items:snapshot.changes.items.filter(c=>mine(c.scope))}:undefined,
    // Per kind of data and per cloud: it names no scope, and hiding it would make a failed read look like zero rows.
    coverage:snapshot.coverage,
    // Published provider ranges, not scope data.
    serviceTags:snapshot.serviceTags,serviceTagsAt:snapshot.serviceTagsAt,prefixLists:snapshot.prefixLists,
    // Cross references are resolved into links before a response is built, so none travel; an unresolved one is shown only for the user's own resource.
    crossRefs:undefined,unresolved:snapshot.unresolved?.filter(u=>ids.has(u.source)),
    // Collector warnings quote other scopes by ID and name, so none are passed on.
    warnings:[],connections,
  };
  return Object.fromEntries(Object.entries(restricted).filter(([,v])=>v!==undefined)) as Snapshot;
}
