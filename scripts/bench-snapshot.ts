// Synthetic inputs only. No credentials, cloud calls or existing snapshots are read.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {ResourceSchema} from '../shared/schema.ts';
import {projectSnapshot} from '../shared/presentation.ts';
import {compactInventory} from '../server/inventory.ts';
import {toSnapshot} from '../server/runner.ts';
import {FileSnapshotStore} from '../server/store.ts';
import {snapshotCache} from '../server/snapshot-cache.ts';
import {liveSnapshot} from '../server/app.ts';
const resources=Array.from({length:10000},(_,i)=>ResourceSchema.parse({id:`aws:fake-${i}`,nativeId:`fake-${i}`,name:`fake-${i}`,provider:'aws',kind:i<2000?'compute':'configuration',auxiliary:i>=2000,type:i<2000?'AWS::EC2::Instance':'ssm:association',scope:'111111111111',region:'fake-region',source:'synthetic benchmark',specs:{description:'synthetic configuration '.repeat(10)}}));
const input={resources,links:[],warnings:[],scopeLabels:{},collectedScopes:['111111111111']};
const activity=Array.from({length:2000},(_,i)=>({id:`fake-event-${i}`,provider:'aws' as const,at:'2026-11-10T00:00:00Z',actor:'fake-actor',actorType:'service' as const,operation:'FakeWrite',label:'synthetic activity',kind:'write' as const,target:'aws:fake-0',targetName:'fake-0',scope:'111111111111',outcome:'ok' as const,source:'synthetic benchmark'}));
const before=toSnapshot({...input,activity}),after=toSnapshot({...compactInventory(input),activity});
const pretty=Buffer.byteLength(JSON.stringify(before,null,2)),compact=Buffer.byteLength(JSON.stringify(before)),reduced=Buffer.byteLength(JSON.stringify(after)),compressed=gzipSync(JSON.stringify(after)).length;
const summary=Buffer.byteLength(JSON.stringify(projectSnapshot(after,'scopes'))),dashboard=Buffer.byteLength(JSON.stringify(projectSnapshot(after,'dashboard')));
const root=await mkdtemp(path.join(tmpdir(),'atlas-bench-')),previousRoot=process.env.SNAPSHOT_DIR;process.env.SNAPSHOT_DIR=root;
try{
  const store=new FileSnapshotStore(root);await store.save('aws',after);
  const cached=snapshotCache(liveSnapshot);await cached(store);
  const measure=async(work:()=>Promise<unknown>)=>{const times:number[]=[];for(let i=0;i<20;i++){const start=performance.now();await work();times.push(performance.now()-start);}return Number(times.sort((a,b)=>a-b)[10].toFixed(3));};
  console.log(JSON.stringify({synthetic:{core:2000,auxiliary:8000,activity:2000},bytes:{pretty,compact,reduced,compressed,scopeSummary:summary,dashboard},resourcesAfter:after.resources.length,medianMs:{uncached:await measure(()=>liveSnapshot(store)),cached:await measure(()=>cached(store))}},null,2));
}finally{if(previousRoot===undefined)delete process.env.SNAPSHOT_DIR;else process.env.SNAPSHOT_DIR=previousRoot;await rm(root,{recursive:true,force:true});}
