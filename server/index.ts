import express from 'express';
import path from 'node:path';
import app from './app.js';
// This listener binds to loopback below, which is what lets live mode run without configured access tokens.
process.env.ATLAS_LOOPBACK_ONLY='1';
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const port=Number(process.env.PORT??4317);
if(process.env.NODE_ENV==='production'){app.use((_req,res,next)=>{res.set('Content-Security-Policy',CSP);next();});app.use(express.static('dist'));app.get('/{*path}',(_req,res)=>res.sendFile(path.resolve('dist/index.html')));}
else{const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
app.listen(port,'127.0.0.1',()=>console.log(`Cloud Atlas: http://127.0.0.1:${port} · ${process.env.DATA_MODE??'mock'} · localhost only`));
