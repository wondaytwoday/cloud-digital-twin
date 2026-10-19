import express from 'express';
import path from 'node:path';
import app from './app';
const port=Number(process.env.PORT??4317);
if(process.env.NODE_ENV==='production'){app.use(express.static('dist'));app.get('/{*path}',(_req,res)=>res.sendFile(path.resolve('dist/index.html')));}
else{const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
app.listen(port,'127.0.0.1',()=>console.log(`Cloud Atlas: http://127.0.0.1:${port} · ${process.env.DATA_MODE??'mock'} · localhost only`));
