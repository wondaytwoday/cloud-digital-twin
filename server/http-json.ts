import {createHash} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import type {Request,Response} from 'express';
const zip=promisify(gzip);
const encoded=new WeakMap<object,{body:Buffer;digest:string;compressed?:Promise<Buffer>}>();
// The representation is built only after authentication and scope restriction.
export async function sendPrivateJson(req:Request,res:Response,value:unknown){
  let entry=value&&typeof value==='object'?encoded.get(value):undefined;
  if(!entry){
    const body=Buffer.from(JSON.stringify(value));entry={body,digest:createHash('sha256').update(body).digest('hex')};
    if(value&&typeof value==='object')encoded.set(value,entry);
  }
  const {body}=entry;
  const accepts=(req.get('Accept-Encoding')??'').split(',').some(s=>/^gzip(?:\s*;|\s*$)/i.test(s.trim())&&!/q=0(?:\.0*)?(?:\s|$)/i.test(s));
  const compressed=body.length>=1024&&accepts;
  const etag=`"${entry.digest}-${compressed?'gzip':'identity'}"`;
  res.set({'Cache-Control':'private, no-cache','ETag':etag,'Content-Type':'application/json; charset=utf-8'});
  res.vary('Cookie');res.vary('Authorization');res.vary('Accept-Encoding');
  if(req.get('If-None-Match')?.split(',').some(t=>t.trim().replace(/^W\//,'')===etag)){res.status(304).end();return;}
  if(compressed){res.set('Content-Encoding','gzip');entry.compressed??=zip(body);res.end(await entry.compressed);}
  else res.end(body);
}
