import {existsSync,readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import http from 'node:http';
// A value already in the shell wins, then .env.local, then .env. Vercel's own tokens stay out of a process that talks to clouds.
export function loadEnvFiles(env:NodeJS.ProcessEnv=process.env,files=['.env.local','.env']){
  const loaded:string[]=[];
  for(const file of files){
    if(!existsSync(file))continue;
    for(const [key,value] of Object.entries(parseEnv(readFileSync(file,'utf8'))))if(env[key]===undefined&&!key.startsWith('VERCEL_')){env[key]=value;loaded.push(key);}
  }
  return loaded;
}
loadEnvFiles();
// Cloud SDKs honour HTTPS_PROXY on their own; Node's fetch, which the ARM and Graph calls use, only does once told to.
const proxied=['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy'].some(k=>process.env[k]);
if(proxied&&typeof (http as any).setGlobalProxyFromEnv==='function')(http as any).setGlobalProxyFromEnv(process.env);
