import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,writeFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import ts from 'typescript';

test('compiled serverless entry runs in native Node ESM without the tsx resolver',async()=>{
  const root=await mkdtemp(join(tmpdir(),'atlas-native-esm-'));
  try{
    await writeFile(join(root,'package.json'),'{"type":"module"}');
    await symlink(join(process.cwd(),'node_modules'),join(root,'node_modules'),'dir');
    const compile=async(relative:string)=>{
      await mkdir(join(root,relative),{recursive:true});
      for(const entry of await readdir(relative,{withFileTypes:true})){
        const name=join(relative,entry.name);
        if(entry.isDirectory())await compile(name);
        else if(name.endsWith('.ts')){
          const source=await readFile(name,'utf8');
          await writeFile(join(root,name.replace(/\.ts$/,'.js')),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
        }else if(name.endsWith('.json'))await writeFile(join(root,name),await readFile(name));
      }
    };
    for(const folder of ['api','server','shared'])await compile(folder);
    const code=`
      const {default:app}=await import(${JSON.stringify(pathToFileURL(join(root,'api/index.js')).href)});
      const server=app.listen(0,'127.0.0.1');
      await new Promise(resolve=>server.once('listening',resolve));
      try {
        const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/health');
        if(!response.ok)throw new Error('Health status '+response.status);
        console.log(JSON.stringify(await response.json()));
      } finally {server.close();}
    `;
    const env:NodeJS.ProcessEnv={...process.env,DATA_MODE:'mock',ATLAS_COLLECTOR:'0',VERCEL:'1'};delete env.NODE_OPTIONS;
    const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{env,timeout:20_000});
    assert.deepEqual(JSON.parse(result.stdout),{ok:true,mode:'mock',collector:false,serverless:true});
  }finally{await rm(root,{recursive:true,force:true});}
});
