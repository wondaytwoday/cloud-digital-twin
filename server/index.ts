import './bootstrap.js';
import express from 'express';
import path from 'node:path';
import app from './app.js';
import {collectorEnabled,needsCollection,runCollection} from './runner.js';
import {FileSnapshotStore} from './store.js';
import {collectionSettings} from './settings.js';
// This listener binds to loopback below, which is what lets live mode run without configured access tokens.
process.env.ATLAS_LOOPBACK_ONLY='1';
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const port=Number(process.env.PORT??4317),envFound=['AZURE_CLIENT_ID','AWS_ACCESS_KEY_ID','AWS_PROFILE','GOOGLE_APPLICATION_CREDENTIALS'].filter(k=>process.env[k]);
if(process.env.NODE_ENV==='production'){app.use((_req,res,next)=>{res.set('Content-Security-Policy',CSP);next();});app.use(express.static('dist'));app.get('/{*path}',(_req,res)=>res.sendFile(path.resolve('dist/index.html')));}
else{const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
// Express hands a failed bind to this callback, so without the check a taken port still prints the success line and the user opens someone else's server.
const startCollector=async()=>{
  if(!collectorEnabled())return;
  const settings=collectionSettings(process.env,line=>console.warn(`[수집 설정] ${line}`));
  const minutes=settings.minutes,store=new FileSnapshotStore(),run=()=>runCollection(store,line=>console.log(`[수집] ${line}`)).catch(e=>console.error('[수집] 실패',e instanceof Error?e.message:'unknown'));
  console.log(`[수집 설정] 자동 주기 ${minutes===0?'중지':`${minutes}분`} · 제공자별 제한 ${settings.timeoutMinutes}분 · 비용 주기 ${settings.costHours}시간`);
  if(needsCollection(await store.readStatus(),minutes))run();
  if(minutes>0)setInterval(run,minutes*60_000).unref();
};
const listen=(at:number,tries:number)=>{app.listen(at,'127.0.0.1',e=>{
  if((e as NodeJS.ErrnoException|undefined)?.code==='EADDRINUSE'&&tries>0){console.log(`포트 ${at}은 다른 프로그램이 쓰고 있어 다음 포트를 시도합니다.`);listen(at+1,tries-1);return;}
  if(e){console.error(`서버를 시작하지 못했습니다 (포트 ${at}): ${e.message}`);process.exit(1);}
  console.log(`Cloud Atlas: http://127.0.0.1:${at} · ${process.env.DATA_MODE??'mock'} · localhost only`);
  if(process.env.DATA_MODE!=='live')console.log(`목데이터 모드입니다. 자격 증명을 넣어도 수집하지 않습니다. 실제 수집은 npm run live 로 실행하세요.${envFound.length?` (${envFound.join(', ')} 감지됨)`:''}`);
  startCollector();
});};
// An explicit PORT is a promise about the address, so only the default moves when it is taken.
listen(port,process.env.PORT?0:10);
