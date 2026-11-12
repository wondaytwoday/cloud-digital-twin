import {performance} from 'node:perf_hooks';
import {validateSnapshot} from '../shared/schema.js';
import {projectSnapshot} from '../shared/presentation.js';
import {ViewCache} from '../shared/view-transport.js';
import {viewTransport} from '../server/view-transport.js';

// Synthetic configuration only: no files, credentials, SDKs or external calls.
const count=10_000;
const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-12T00:00:00Z',scopes:['fake'],warnings:[],links:[],resources:Array.from({length:count},(_,i)=>({id:`vm-${i}`,nativeId:`vm-${i}`,name:`service-${i%997}-${i}`,provider:'aws',scope:'fake',region:`r-${i%5}`,kind:'compute',type:'AWS::EC2::Instance',status:'running',source:'synthetic benchmark',specs:{'인스턴스':`size-${i%23}`,...Object.fromEntries(Array.from({length:12},(_,n)=>[`field-${n}`,`${i*31+n}`]))}}))});
const client=new ViewCache();client.decode(viewTransport(projectSnapshot(snapshot,'map'),undefined));
const full=JSON.stringify(projectSnapshot(snapshot,'inventory'));
const reused=JSON.stringify(viewTransport(projectSnapshot(snapshot,'inventory'),client.revision));
const measure=(work:()=>unknown)=>{
  const times:number[]=[];
  for(let i=0;i<20;i++){const start=performance.now();work();times.push(performance.now()-start);}
  times.sort((a,b)=>a-b);return{medianMs:+times[10].toFixed(2),p95Ms:+times[18].toFixed(2)};
};
console.log(JSON.stringify({resources:count,iterations:20,fullBytes:Buffer.byteLength(full),reuseBytes:Buffer.byteLength(reused),full:measure(()=>validateSnapshot(JSON.parse(full))),reuse:measure(()=>client.decode(JSON.parse(reused)))},null,2));
