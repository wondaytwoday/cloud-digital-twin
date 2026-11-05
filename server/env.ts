import {existsSync,readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
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
