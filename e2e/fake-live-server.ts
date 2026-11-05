// A real server in live mode whose cloud drivers read fixtures. Nothing here contacts a cloud.
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.SNAPSHOT_DIR=mkdtempSync(path.join(tmpdir(),'atlas-live-'));process.env.DATA_MODE='live';process.env.ATLAS_COLLECTOR='1';process.env.ATLAS_COLLECT_MINUTES='0';
const {configureCollector}=await import('../server/runner.ts'),{mockSnapshot}=await import('../server/mock.ts');
const fromScenario=async(id:'web-tier'|'single-vm',incomplete:string[]=[])=>{
  const s=await mockSnapshot(id);
  await new Promise(r=>setTimeout(r,Number(process.env.FAKE_COLLECT_MS??1500)));
  return{resources:s.resources.map(r=>({...r,metrics:undefined,iam:[]})),links:s.links.filter(l=>l.kind!=='simulation'),warnings:incomplete.length?['AWS: 권한이나 설정 때문에 읽지 못한 항목: ListClusters']:[],scopeLabels:s.scopeLabels,hierarchy:s.hierarchy,incomplete};
};
const reporting=(run:()=>Promise<any>)=>async({report}:{report?:(s:any,p?:any)=>void})=>{report?.('scopes',{state:'done',detail:'구독 2개'});report?.('resources',{detail:'자원 1,000개 읽음',done:1,total:2});const result=await run();report?.('resources',{state:'done',detail:'자원 2,000개'});report?.('iam',{state:'done'});report?.('cost',{state:'skipped',detail:'24시간에 한 번만 조회합니다'});return result;};
configureCollector({
  azure:{detect:async()=>'Azure 자격 증명',collect:reporting(()=>fromScenario('web-tier'))},
  aws:{detect:async()=>'계정 123456789012',collect:reporting(()=>fromScenario('single-vm',['123456789012']))},
  gcp:{detect:async()=>{throw new Error('Could not load the default credentials');},collect:()=>{throw new Error('호출되면 안 됩니다');}},
});
await import('../server/index.ts');
