import {test,expect} from '@playwright/test';
import {createServer as httpServer,request as httpRequest} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import app from '../server/app';

for(const mode of ['localhost','127.0.0.1','https-proxy'] as const)test(`production session persists over ${mode}`,async({browser})=>{
  const root=await mkdtemp(path.join(tmpdir(),'atlas-cookie-')),keys=['DATA_MODE','NODE_ENV','ACCESS_TOKENS','SNAPSHOT_DIR'] as const,old=Object.fromEntries(keys.map(k=>[k,process.env[k]])),trust=app.get('trust proxy');
  process.env.DATA_MODE='live';process.env.NODE_ENV='production';process.env.SNAPSHOT_DIR=root;process.env.ACCESS_TOKENS=JSON.stringify([{name:'synthetic-local-user',tokenSha256:createHash('sha256').update('synthetic-local-token').digest('hex'),scopes:['*']}]);
  const backend=httpServer((req,res)=>{if(req.url==='/session-probe'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Session test</title><h1>Local session test</h1>');}else app(req,res);});
  await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));const port=(backend.address() as AddressInfo).port;
  let proxy:ReturnType<typeof httpsServer>|undefined;
  const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();
  try{
    let url=`http://${mode==='localhost'?'localhost':'127.0.0.1'}:${port}`;
    if(mode==='https-proxy'){
      execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(root,'key.pem'),'-out',path.join(root,'cert.pem'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
      app.set('trust proxy',['loopback']);
      proxy=httpsServer({key:await readFile(path.join(root,'key.pem')),cert:await readFile(path.join(root,'cert.pem'))},(req,res)=>{
        const upstream=httpRequest({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-proto':'https'}},reply=>{res.writeHead(reply.statusCode??500,reply.headers);reply.pipe(res);});upstream.on('error',()=>{res.statusCode=502;res.end();});req.pipe(upstream);
      });
      await new Promise<void>(resolve=>proxy!.listen(0,'127.0.0.1',resolve));url=`https://localhost:${(proxy.address() as AddressInfo).port}`;
    }
    await page.goto(url+'/session-probe');
    expect(await page.evaluate(async()=>{const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'synthetic-local-token'})});return response.status;})).toBe(200);
    const session=await page.evaluate(async()=>fetch('/api/session').then(r=>r.json()));expect(session.authenticated).toBe(true);expect(session.name).toBe('synthetic-local-user');
    const cookie=(await context.cookies()).find(c=>c.name==='atlas_session');expect(cookie?.httpOnly).toBe(true);expect(cookie?.secure).toBe(true);expect(cookie?.sameSite).toBe('Strict');
    await page.evaluate(async()=>fetch('/api/session',{method:'DELETE'}));expect((await page.evaluate(async()=>fetch('/api/session').then(r=>r.json()))).authenticated).toBe(false);
  }finally{
    await context.close();app.set('trust proxy',trust);proxy?.closeAllConnections();if(proxy)await new Promise<void>(resolve=>proxy!.close(()=>resolve()));backend.closeAllConnections();await new Promise<void>(resolve=>backend.close(()=>resolve()));for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}await rm(root,{recursive:true,force:true});
  }
});
