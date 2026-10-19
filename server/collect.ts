import {parseArgs} from 'node:util';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {collectAzure,collectAws,collectGcp} from './collectors.js';
import {validateSnapshot} from '../shared/schema.js';
const {values}=parseArgs({options:{provider:{type:'string'},subscriptions:{type:'string'},regions:{type:'string'},parent:{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('npm run collect -- --provider azure --subscriptions <id,id>\nnpm run collect -- --provider aws --regions ap-northeast-2\nnpm run collect -- --provider gcp --parent projects/<id>');process.exit(0);}
try{
  const p=values.provider;if(!['azure','aws','gcp'].includes(p??''))throw new Error('--provider azure|aws|gcp 필요');
  const subs=values.subscriptions?.split(',').map(x=>x.trim()).filter(Boolean)??[];
  const regions=values.regions?.split(',').map(x=>x.trim()).filter(Boolean)??[];
  if(p==='azure'&&(!subs.length||subs.some(x=>!/^[-a-f0-9]{36}$/i.test(x))))throw new Error('--subscriptions에 구독 UUID 필요');
  if(p==='aws'&&(!regions.length||regions.some(x=>!/^[-a-z0-9]+$/.test(x))))throw new Error('--regions 필요');
  if(p==='gcp'&&!/^(projects|folders|organizations)\/[a-zA-Z0-9-]+$/.test(values.parent??''))throw new Error('--parent projects/<id> 또는 folders/<id>, organizations/<id> 필요');
  console.log(`${p}: 명시한 범위에서 지원 자원을 읽습니다. 실패하면 기존 스냅샷을 유지합니다.`);
  const result=p==='azure'?await collectAzure(subs):p==='aws'?await collectAws(regions):await collectGcp(values.parent!);
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:new Date().toISOString(),...result,scopes:p==='azure'?subs:p==='aws'?regions:[values.parent!]});
  await mkdir('data',{recursive:true,mode:0o700});
  await writeFile(`data/${p}.tmp`,JSON.stringify(snapshot,null,2),{mode:0o600});await rename(`data/${p}.tmp`,`data/${p}.json`);
  console.log(`저장: data/${p}.json · ${snapshot.resources.length}개 자원 / ${snapshot.links.length}개 구성 관계`);
  console.log('DATA_MODE=live npm run dev 로 실행한 뒤 데이터 다시 불러오기를 누르세요.');
}catch(e){console.error(e instanceof Error?e.message:'수집 실패');process.exitCode=1;}
