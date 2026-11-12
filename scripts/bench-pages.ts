import {performance} from 'node:perf_hooks';
import {mkdtemp,readdir,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {validateSnapshot} from '../shared/schema.ts';
import {ResourcePage,ActivityPage} from '../shared/page-contracts.ts';
import {resourcePage,activityPage} from '../server/pages.ts';
import {FileSnapshotStore} from '../server/store.ts';
const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-12T12:00:00Z',resources:Array.from({length:10000},(_,i)=>({id:`vm-${i}`,nativeId:`vm-${i}`,name:`service-${i%83}-worker-${i}`,provider:'aws',scope:`scope-${i%10}`,region:`region-${i%3}`,kind:'compute',type:'AWS::EC2::Instance',status:'running',source:'synthetic benchmark',specs:{'인스턴스':'fake-size','vCPU':'4','메모리':'16 GiB',description:`synthetic-config-${i}-${'x'.repeat(i%300)}`}})),links:[],warnings:[],scopes:Array.from({length:10},(_,i)=>`scope-${i}`),activity:Array.from({length:100000},(_,i)=>({id:`event-${i}`,provider:'aws',scope:`scope-${i%10}`,at:`2026-11-${String(11-i%7).padStart(2,'0')}T${String(i%24).padStart(2,'0')}:00:00Z`,actor:`actor-${i%521}`,actorType:'service',operation:i%7?'CreateResource':'PutRolePolicy',label:`synthetic change ${i}`,kind:'write',target:`vm-${i%10000}`,targetName:`worker-${i%10000}`,outcome:'ok',source:'synthetic benchmark'}))});
const measure=(read:()=>unknown)=>{const values:number[]=[];for(let i=0;i<20;i++){const start=performance.now();read();values.push(performance.now()-start);}values.sort((a,b)=>a-b);return{medianMs:+values[10].toFixed(2),p95Ms:+values[18].toFixed(2)};};
const full=JSON.stringify(snapshot),resources=JSON.stringify(resourcePage(snapshot,new URLSearchParams())),activity=JSON.stringify(activityPage(snapshot,new URLSearchParams()));
const root=await mkdtemp(path.join(tmpdir(),'atlas-bench-pages-'));
try{
  const store=new FileSnapshotStore(root);await store.save('aws',snapshot);await store.save('aws',{...snapshot,collectedAt:'2026-11-12T13:00:00Z'});
  const bytes=async(dir:string):Promise<number>=>{let total=0;for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);total+=entry.isDirectory()?await bytes(file):(await stat(file)).size;}return total;};
  console.log(JSON.stringify({resources:10000,events:100000,iterations:20,fullBytes:Buffer.byteLength(full),resourcePageBytes:Buffer.byteLength(resources),activityPageBytes:Buffer.byteLength(activity),resourceParseAndValidate:measure(()=>ResourcePage.parse(JSON.parse(resources))),activityParseAndValidate:measure(()=>ActivityPage.parse(JSON.parse(activity))),fullParseAndValidate:measure(()=>validateSnapshot(JSON.parse(full))),twoLegacySnapshotsBytes:Buffer.byteLength(full)*2,twoGenerationsOnDiskBytes:await bytes(root)},null,2));
}finally{await rm(root,{recursive:true,force:true});}
