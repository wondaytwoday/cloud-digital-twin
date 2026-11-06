import './env.js';
import {backupData,restoreData,verifyBackup} from './backup.js';
// npm run backup -- <대상 폴더> · npm run restore -- <백업 폴더> · npm run restore -- --check <백업 폴더>
const root=process.env.SNAPSHOT_DIR??'data',[command,...rest]=process.argv.slice(2),check=rest[0]==='--check',target=check?rest[1]:rest[0];
try{
  if(!target)throw new Error(command==='backup'?'사용법: npm run backup -- <백업을 둘 폴더>':'사용법: npm run restore -- [--check] <백업 폴더>');
  if(command==='backup'){const {dir,manifest}=await backupData(root,target);console.log(`백업 완료: ${dir} (파일 ${manifest.files.length}개)`);}
  else if(command==='restore'&&check){const m=await verifyBackup(target);console.log(`정상 백업입니다: ${m.createdAt} 시점, 파일 ${m.files.length}개. 아무것도 바꾸지 않았습니다.`);}
  else if(command==='restore'){const r=await restoreData(root,target);console.log(`복구 완료: 파일 ${r.restored}개.${r.previous?` 이전 데이터는 ${r.previous}에 남겨 두었습니다.`:''} 서버를 다시 시작하세요.`);}
  else throw new Error('backup 또는 restore를 지정하세요.');
}catch(e){console.error(e instanceof Error?e.message:'실패');process.exitCode=1;}
