import express from 'express';
import {readFile} from 'node:fs/promises';
import {mockSnapshot} from './mock';
import {validateSnapshot,type Snapshot} from '../shared/schema';
const app=express();
if(process.env.DATA_MODE&&!['mock','live'].includes(process.env.DATA_MODE))throw new Error('DATA_MODE must be mock or live');
app.disable('x-powered-by');
app.get('/api/health',(_req,res)=>res.json({ok:true,mode:process.env.DATA_MODE??'mock'}));
app.get('/api/topology',async(_req,res)=>{
  res.set('Cache-Control','no-store');
  try{
    if(process.env.DATA_MODE!=='live'){res.json(mockSnapshot());return;}
    const snapshots:Snapshot[]=[],warnings:string[]=[];
    for(const p of ['azure','aws','gcp']){
      try{const s=validateSnapshot(JSON.parse(await readFile(`data/${p}.json`,'utf8')));if(s.mode!=='live'||s.resources.some(r=>r.provider!==p))throw new Error(`${p}: invalid provider snapshot`);snapshots.push(s);warnings.push(`${p}: 마지막 수집 ${s.collectedAt}`);}
      catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')warnings.push(`${p}: 아직 수집한 스냅샷이 없습니다.`);else throw e;}
    }
    if(!snapshots.length){res.status(503).json({error:'실제 스냅샷이 없습니다. npm run collect로 먼저 수집하세요. 목데이터로 자동 대체하지 않습니다.'});return;}
    res.json(validateSnapshot({version:1,mode:'live',collectedAt:snapshots.map(s=>s.collectedAt).sort()[0],resources:snapshots.flatMap(s=>s.resources),links:snapshots.flatMap(s=>s.links),warnings:[...warnings,...snapshots.flatMap(s=>s.warnings)],scopes:snapshots.flatMap(s=>s.scopes)}));
  }catch(e){console.error('Snapshot load failed:',e instanceof Error?e.message:'unknown');res.status(500).json({error:'스냅샷 형식 또는 참조가 올바르지 않습니다. 서버 로그와 수집 결과를 확인하세요.'});}
});
app.use('/api',(_req,res)=>res.status(404).json({error:'API not found'}));
export default app;
