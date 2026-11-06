import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readdir,readFile,writeFile} from 'node:fs/promises';
import {hostname,tmpdir} from 'node:os';
import path from 'node:path';
import {mockSnapshot} from '../server/mock.ts';
import {FileSnapshotStore,historyTime} from '../server/store.ts';
import {toSnapshot} from '../server/runner.ts';
import {backupData,restoreData,verifyBackup} from '../server/backup.ts';

const snap=async(at:string)=>{const s=await mockSnapshot('single-vm');return{...toSnapshot({resources:s.resources.map(r=>({...r,metrics:undefined,iam:[]})),links:s.links.filter(l=>l.kind!=='simulation'),warnings:[],scopeLabels:s.scopeLabels,hierarchy:s.hierarchy}),collectedAt:at};};
const iso=(daysAgo:number)=>new Date(Date.now()-daysAgo*86_400_000).toISOString();
const temp=()=>mkdtemp(path.join(tmpdir(),'atlas-'));
// A data folder with what an operator would hate to lose: two runs, an audit line and the on-prem sites.
const seeded=async()=>{
  const root=path.join(await temp(),'data'),store=new FileSnapshotStore(root);
  await store.save('aws',await snap(iso(2)));await store.save('aws',await snap(iso(1)));
  await mkdir(path.join(root,'audit'),{recursive:true});await writeFile(path.join(root,'audit','2026-11.jsonl'),'{"line":1}\n');
  await writeFile(path.join(root,'onprem.json'),'[]');
  return{root,store};
};

test('history is kept by age, and the newest runs stay however old they are',async()=>{
  assert.equal(historyTime('2026-01-02T03-04-05-678Z.json'),Date.parse('2026-01-02T03:04:05.678Z'));assert.ok(Number.isNaN(historyTime('notes.json')));
  const root=await temp(),store=new FileSnapshotStore(root),saved=process.env.ATLAS_HISTORY_DAYS;process.env.ATLAS_HISTORY_DAYS='7';
  try{
    for(const d of [40,20,10,6,5,3])await store.save('aws',await snap(iso(d)));
    const kept=(await readdir(path.join(root,'history','aws'))).map(f=>Math.round((Date.now()-historyTime(f))/86_400_000));
    assert.deepEqual(kept,[6,5],'older than a week is gone; the current run is not in history');
    // Long pause: everything is old, but the last runs remain to compare against.
    const idle=await temp(),quiet=new FileSnapshotStore(idle);for(const d of [90,80,70,60])await quiet.save('aws',await snap(iso(d)));
    assert.equal((await readdir(path.join(idle,'history','aws'))).length,2);
    assert.equal((await quiet.previous('aws'))!.collectedAt.slice(0,10),iso(70).slice(0,10));
  }finally{if(saved===undefined)delete process.env.ATLAS_HISTORY_DAYS;else process.env.ATLAS_HISTORY_DAYS=saved;}
});
test('a restore brings back exactly what was backed up and keeps what it replaced',async()=>{
  const {root,store}=await seeded(),backups=await temp(),before=(await store.latest('aws'))!.collectedAt;
  const {dir,manifest}=await backupData(root,backups);
  assert.deepEqual(manifest.files.map(f=>f.path).sort(),['audit/2026-11.jsonl','aws.json',`history/aws/${(await readdir(path.join(root,'history','aws')))[0]}`,'onprem.json']);
  await store.save('aws',await snap(iso(0)));await writeFile(path.join(root,'aws.json'),'{"damaged":');
  const r=await restoreData(root,dir);
  assert.equal((await new FileSnapshotStore(root).latest('aws'))!.collectedAt,before);
  assert.equal(await readFile(path.join(root,'audit','2026-11.jsonl'),'utf8'),'{"line":1}\n');
  assert.equal(await readFile(path.join(r.previous!,'aws.json'),'utf8'),'{"damaged":','the replaced folder is set aside, not deleted');
});
test('a damaged or foreign backup is refused before anything changes',async()=>{
  const {root,store}=await seeded(),{dir}=await backupData(root,await temp()),current=(await store.latest('aws'))!.collectedAt;
  await writeFile(path.join(dir,'onprem.json'),'[{"tampered":true}]');
  await assert.rejects(restoreData(root,dir),/손상됐습니다: onprem\.json/);
  assert.equal((await store.latest('aws'))!.collectedAt,current);assert.ok(!(await readdir(path.dirname(root))).some(f=>f.includes('restoring')),'no half-built folder is left');
  const bad=(await backupData(root,await temp())).dir,manifest=JSON.parse(await readFile(path.join(bad,'manifest.json'),'utf8'));
  manifest.files.push({path:'../escape',bytes:0,sha256:''});await writeFile(path.join(bad,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(verifyBackup(bad),/허용되지 않는 경로/);
  await assert.rejects(verifyBackup(await temp()),/백업 폴더가 아닙니다/);
});
test('a snapshot the server would not read is caught when the backup is checked',async()=>{
  const {root}=await seeded(),{dir}=await backupData(root,await temp()),{createHash}=await import('node:crypto');
  const broken=JSON.stringify({version:1}),manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
  await writeFile(path.join(dir,'aws.json'),broken);manifest.files.find((f:{path:string})=>f.path==='aws.json').sha256=createHash('sha256').update(broken).digest('hex');
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(verifyBackup(dir),/스냅샷 형식이 올바르지 않습니다: aws\.json/);
});
test('backup and restore wait for a running collection, and a backup never goes inside the data folder',async()=>{
  const {root}=await seeded();
  await writeFile(path.join(root,'collect.lock'),JSON.stringify({pid:process.ppid,host:hostname(),at:new Date().toISOString(),id:'other'}));
  await assert.rejects(backupData(root,await temp()),/수집이 진행 중/);
  const {dir}=await backupData((await seeded()).root,await temp());
  await assert.rejects(restoreData(root,dir),/수집이 진행 중/);assert.ok(await readFile(path.join(root,'aws.json'),'utf8'),'the data folder is untouched');
  await assert.rejects(backupData(root,path.join(root,'backups')),/데이터 폴더 밖에/);
});
test('the command line checks a backup without changing anything',async()=>{
  const {root}=await seeded(),{dir}=await backupData(root,await temp());
  const run=spawnSync(process.execPath,['--import','tsx','server/backup-cli.ts','restore','--check',dir],{env:{...process.env,SNAPSHOT_DIR:root},encoding:'utf8',timeout:30_000});
  assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/정상 백업입니다/);
});
