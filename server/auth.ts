import {createHash,timingSafeEqual} from 'node:crypto';
import type {NextFunction,Request,RequestHandler,Response} from 'express';
import {z} from 'zod';
import type {Snapshot} from '../shared/schema.js';
import {audit} from './audit.js';
import {LoginAttempts} from './login-attempts.js';
const COOKIE='atlas_session';
const AccessEntry=z.object({name:z.string(),tokenSha256:z.string().regex(/^[a-f0-9]{64}$/),scopes:z.array(z.string()).min(1)});
export type AccessEntry=z.infer<typeof AccessEntry>;
const sha256=(v:string)=>createHash('sha256').update(v).digest('hex');
export const accessEntries=():AccessEntry[]=>z.array(AccessEntry).parse(JSON.parse(process.env.ACCESS_TOKENS??'[]'));
export function findEntry(token:string|undefined){
  if(!token)return undefined;
  const digest=Buffer.from(sha256(token));
  return accessEntries().find(e=>{const known=Buffer.from(e.tokenSha256);return known.length===digest.length&&timingSafeEqual(known,digest);});
}
const cookieToken=(req:Request)=>req.headers.cookie?.split(/;\s*/).find(c=>c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
export function requestToken(req:Request){
  const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if(bearer)return bearer;
  const cookie=cookieToken(req);
  try{return cookie?decodeURIComponent(cookie):undefined;}catch{return undefined;}
}
const attempts=new LoginAttempts();
const isLive=()=>process.env.DATA_MODE==='live';
// Real inventory reveals the whole network, so live mode fails closed unless access is configured or the server is loopback-only.
export const requireAccess:RequestHandler=(req:Request,res:Response,next:NextFunction)=>{
  if(!isLive())return next();
  if(accessEntries().length){const entry=findEntry(requestToken(req));if(!entry){audit(req,{actor:'인증 안 됨',action:'denied',target:req.path});res.status(401).json({error:'로그인이 필요합니다.'});return;}res.locals.access=entry;return next();}
  // Without a token, a page on any website could reach this through DNS rebinding unless the Host is checked too.
  if(process.env.ATLAS_LOOPBACK_ONLY==='1'){if(['127.0.0.1','localhost','[::1]'].includes(req.hostname))return next();res.status(403).json({error:'localhost로만 접근할 수 있습니다.'});return;}
  res.status(503).json({error:'접근 제어가 설정되지 않아 실제 데이터를 제공하지 않습니다. ACCESS_TOKENS를 설정하세요.'});
};
export const requireAdmin:RequestHandler=(_req,res,next)=>{const access=res.locals.access as AccessEntry|undefined;if(access&&!access.scopes.includes('*')){res.status(403).json({error:'전체 범위 권한이 필요합니다.'});return;}next();};
export function sessionRoutes(app:import('express').Express){
  app.get('/api/session',(req,res)=>{const required=isLive()&&accessEntries().length>0,entry=required?findEntry(requestToken(req)):undefined;res.json({required,authenticated:!required||!!entry,name:entry?.name});});
  app.post('/api/session',(req,res)=>{
    if(!attempts.allow(req.ip??'unknown')){audit(req,{actor:'알 수 없음',action:'login_failed',detail:'시도 횟수 초과'});res.status(429).json({error:'시도가 너무 많습니다. 잠시 후 다시 시도하세요.'});return;}
    const token=typeof req.body?.token==='string'?req.body.token:undefined;
    const entry=findEntry(token);
    if(!entry){audit(req,{actor:'알 수 없음',action:'login_failed',detail:'잘못된 토큰'});res.status(401).json({error:'접근 토큰이 올바르지 않습니다.'});return;}
    audit(req,{actor:entry.name,action:'login'});
    res.cookie(COOKIE,token,{httpOnly:true,sameSite:'strict',secure:req.secure||process.env.NODE_ENV==='production',path:'/api',maxAge:8*3600_000});res.json({ok:true});
  });
  app.delete('/api/session',(req,res)=>{const entry=findEntry(requestToken(req));if(entry)audit(req,{actor:entry.name,action:'logout'});res.clearCookie(COOKIE,{path:'/api'});res.json({ok:true});});
}
// Server-side, so a restricted user's browser never receives other scopes at all.
export function restrictSnapshot(snapshot:Snapshot,scopes:string[]):Snapshot{
  if(scopes.includes('*'))return snapshot;
  const allowed=new Set(scopes),resources=snapshot.resources.filter(r=>allowed.has(r.scope)).map(r=>{
    const specs={...r.specs};delete specs['미수집 상위 참조'];return{...r,specs};
  }),ids=new Set(resources.map(r=>r.id));
  for(const r of resources)if(r.parent&&!ids.has(r.parent))delete r.parent;
  const keep=new Set<string>();const nodes=new Map(snapshot.hierarchy.map(n=>[n.id,n]));
  for(const n of snapshot.hierarchy)if(n.scope&&allowed.has(n.scope))for(let c:typeof n|undefined=n;c;c=c.parent?nodes.get(c.parent):undefined)keep.add(c.id);
  const visibleProviders=new Set([
    ...resources.map(r=>r.provider),
    ...snapshot.cost.filter(c=>allowed.has(c.scope)).map(c=>c.provider),
    ...snapshot.hierarchy.filter(n=>n.scope&&allowed.has(n.scope)).map(n=>n.provider),
    ...snapshot.collectionGaps.filter(g=>allowed.has(g.scope)).map(g=>g.provider),
  ]);
  const costCoverage=snapshot.costCoverage
    .map(c=>({...c,failedScopes:c.failedScopes.filter(s=>allowed.has(s))}))
    .filter(c=>visibleProviders.has(c.provider)||c.failedScopes.length>0)
    .map(c=>({...c,state:c.state==='partial'&&!c.failedScopes.length?'complete' as const:c.state}));
  return{...snapshot,itemCollection:snapshot.itemCollection.filter(r=>allowed.has(r.scope)),inventorySummary:snapshot.inventorySummary.filter(s=>allowed.has(s.scope)),scopeCollectedAt:Object.fromEntries(Object.entries(snapshot.scopeCollectedAt).filter(([scope])=>allowed.has(scope))),costCoverage,collectionGaps:snapshot.collectionGaps.filter(g=>allowed.has(g.scope)),incomplete:snapshot.incomplete.filter(s=>allowed.has(s)),resources,links:snapshot.links.filter(l=>ids.has(l.source)&&ids.has(l.target)),hierarchy:snapshot.hierarchy.filter(n=>keep.has(n.id)),cost:snapshot.cost.filter(c=>allowed.has(c.scope)),activity:snapshot.activity.filter(a=>allowed.has(a.scope)),iam:snapshot.iam.filter(a=>allowed.has(a.scope)),scopes:snapshot.scopes.filter(s=>allowed.has(s)),connections:[],warnings:[],changes:snapshot.changes?{since:snapshot.changes.since,items:snapshot.changes.items.filter(c=>allowed.has(c.scope))}:undefined,scopeLabels:Object.fromEntries(Object.entries(snapshot.scopeLabels).filter(([k])=>allowed.has(k)))};
}
