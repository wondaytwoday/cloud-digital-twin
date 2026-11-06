import './env.js';
import {parseArgs} from 'node:util';
import {collectAzure,collectAws,collectGcp} from './collectors.js';
import {FileSnapshotStore} from './store.js';
import {checkCredentials,PROVIDERS,runCollection,toSnapshot} from './runner.js';
const {values}=parseArgs({options:{provider:{type:'string'},subscriptions:{type:'string'},regions:{type:'string'},parent:{type:'string'},roles:{type:'string'},check:{type:'boolean'},help:{type:'boolean'}}});
if(values.help){console.log('npm run check                    클라우드별 자격 증명만 확인. 자원은 읽지 않음\nnpm run collect                  로그인된 클라우드를 찾아 볼 수 있는 범위를 모두 수집\nnpm run collect -- --provider azure --subscriptions <id,id>   범위 좁히기\nnpm run collect -- --provider aws --regions ap-northeast-2 [--roles 이름=arn,이름=arn]\nnpm run collect -- --provider gcp --parent projects/<id>');process.exit(0);}
const list=(v?:string)=>v?.split(',').map(x=>x.trim()).filter(Boolean)??[];
try{
  const p=values.provider;
  if(values.check){
    const results=await checkCredentials();
    for(const r of results)console.log(`${r.ok?'연결됨':'안 됨 '}  ${r.provider.padEnd(5)}  ${r.detail}`);
    if(results.some(r=>r.ok))console.log('\n연결된 클라우드를 수집하려면 npm run live 를 실행하세요.');else{console.error('\n연결된 클라우드가 없습니다. 위 사유를 해결한 뒤 다시 확인하세요.');process.exitCode=1;}
  }else if(!p){
    const status=await runCollection(new FileSnapshotStore(),line=>console.log(line));
    const done=PROVIDERS.filter(x=>['ok','partial'].includes(status.providers[x].state));
    if(!done.length){console.error('수집된 클라우드가 없습니다. npm run check 로 클라우드별 사유를 확인하세요.');process.exitCode=1;}
    else console.log(`완료: ${done.join(', ')}. npm run live 로 확인하세요.`);
  }else{
    if(!['azure','aws','gcp'].includes(p))throw new Error('--provider azure|aws|gcp 필요');
    const subs=list(values.subscriptions),regions=list(values.regions);
    if(subs.some(x=>!/^[-a-f0-9]{36}$/i.test(x)))throw new Error('--subscriptions에는 구독 UUID를 넣으세요.');
    if(regions.some(x=>!/^[-a-z0-9]+$/.test(x)))throw new Error('--regions 형식이 올바르지 않습니다.');
    if(p==='gcp'&&!/^(projects|folders|organizations)\/[a-zA-Z0-9-]+$/.test(values.parent??''))throw new Error('--parent projects/<id> 또는 folders/<id>, organizations/<id> 필요');
    const roles=list(values.roles).map(x=>{const [label,roleArn]=x.split('=');if(!label||!roleArn?.startsWith('arn:aws:iam::'))throw new Error('--roles는 이름=역할ARN 형식이어야 합니다.');return{label,roleArn};});
    console.log(`${p}: 지정한 범위에서 지원 자원을 읽습니다. 실패하면 기존 스냅샷을 유지합니다.`);
    const store=new FileSnapshotStore(),release=await store.lock();
    if(!release)throw new Error('다른 프로세스가 이 데이터 폴더에서 수집 중입니다. 끝난 뒤 다시 실행하세요.');
    try{
      const snapshot=toSnapshot(p==='azure'?await collectAzure(subs):p==='aws'?await collectAws(regions,roles):await collectGcp(values.parent!),new Date().toISOString());
      await store.save(p,snapshot);
      console.log(`저장: ${p} · ${snapshot.resources.length}개 자원 / ${snapshot.links.length}개 구성 관계`);
    }finally{await release();}
  }
}catch(e){console.error(e instanceof Error?e.message:'수집 실패');process.exitCode=1;}
