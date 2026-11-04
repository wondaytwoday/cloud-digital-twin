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
configureCollector({
  azure:{detect:async()=>'Azure 자격 증명',collect:()=>fromScenario('web-tier')},
  aws:{detect:async()=>'계정 123456789012',collect:()=>fromScenario('single-vm',['123456789012'])},
  gcp:{detect:async()=>{throw new Error('Could not load the default credentials');},collect:()=>{throw new Error('호출되면 안 됩니다');}},
});
await import('../server/index.ts');
