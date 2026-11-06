import {useEffect,useMemo,useState} from 'react';
import {AlertTriangle,ArrowUpRight,Download,RefreshCw} from 'lucide-react';
import type {Activity,AuditEvent,Snapshot} from '../../shared/schema';
import {inScope,type Focus} from '../../shared/hierarchy';
import {Kpi} from '../charts';
import {Columns,Donut,HBars,PROVIDER_COLOR,PROVIDER_LABEL} from '@/ui/viz';
type Tab='portal'|'cloud';
const ACTION:Record<AuditEvent['action'],string>={login:'로그인',login_failed:'로그인 실패',logout:'로그아웃',denied:'접근 거부',view:'화면 조회',open:'리소스 열람',collect:'수집 실행',export:'내보내기'};
const PAGE:Record<string,string>={dashboard:'대시보드',findings:'조치 항목',changes:'변경 이력',scopes:'관리 범위',map:'토폴로지',inventory:'리소스',network:'네트워크',security:'노출·방화벽',iam:'IAM',cost:'비용',audit:'접근 로그',portal:'포털 데이터'};
// Daily columns group actions into what an auditor scans for.
const BUCKET:Record<AuditEvent['action'],string>={login:'login',logout:'login',view:'view',open:'open',collect:'change',export:'change',login_failed:'bad',denied:'bad'};
const BUCKETS=[{key:'login',label:'로그인·로그아웃',color:'var(--accent)'},{key:'view',label:'화면 조회',color:'#7c93c9'},{key:'open',label:'리소스 열람',color:'var(--path)'},{key:'change',label:'수집·내보내기',color:'var(--amber)'},{key:'bad',label:'실패·거부',color:'var(--warn)'}];
const KIND:Record<Activity['kind'],{label:string;color:string}>={write:{label:'생성·변경',color:'var(--accent)'},delete:{label:'삭제',color:'var(--warn)'},action:{label:'작업 실행',color:'var(--amber)'}};
// Rule changes open or close paths into the network, so they are called out on their own.
const SENSITIVE=/securityRules|SecurityGroup(Ingress|Egress)|firewalls|firewallRules|RoleAssignment|setIamPolicy|AttachRolePolicy|PutRolePolicy|CreateAccessKey|listKeys/i;
const day=(iso:string)=>iso.slice(5,10).replace('-','/');
const when=(iso:string)=>new Date(iso).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const lastDays=(n:number,now=Date.now())=>Array.from({length:n},(_,i)=>new Date(now-(n-1-i)*86_400_000).toISOString().slice(0,10));
function perDay<T>(rows:T[],at:(r:T)=>string,key:(r:T)=>string,keys:string[],days:number){
  const out=lastDays(days).map(d=>({x:day(d),d,...Object.fromEntries(keys.map(k=>[k,0]))})) as Record<string,any>[],idx=new Map(out.map((o,i)=>[o.d,i]));
  for(const r of rows){const i=idx.get(at(r).slice(0,10));if(i!==undefined)out[i][key(r)]++;}
  return out;
}
const top=<T,>(rows:T[],key:(r:T)=>string|undefined,n=8)=>{const m=new Map<string,number>();for(const r of rows){const k=key(r);if(k)m.set(k,(m.get(k)??0)+1);}return [...m].sort((a,b)=>b[1]-a[1]).slice(0,n);};
// Five or more failures from one source within ten minutes look like guessing, not a typo.
function bursts(events:AuditEvent[]){
  const fails=events.filter(e=>e.action==='login_failed').sort((a,b)=>a.at.localeCompare(b.at)),out:{from:string;at:string;count:number}[]=[];
  for(let i=0;i<fails.length;){const src=fails[i].ip??fails[i].actor;let j=i;while(j<fails.length&&(fails[j].ip??fails[j].actor)===src&&Date.parse(fails[j].at)-Date.parse(fails[i].at)<=600_000)j++;if(j-i>=5)out.push({from:src,at:fails[i].at,count:j-i});i=j>i?j:i+1;}
  return out;
}
const csv=(rows:string[][])=>rows.map(r=>r.map(c=>/[",\n]/.test(c)?`"${c.replace(/"/g,'""')}"`:c).join(',')).join('\n');
export function AuditPage({snapshot,focus,openResource,onCsv}:{snapshot:Snapshot;focus:Focus;openResource:(id:string)=>void;onCsv:(content:string,name:string)=>void}){
  const [tab,setTab]=useState<Tab>('portal'),[days,setDays]=useState(14);
  return <div className="page"><header className="page-head"><div><h1>접근 로그</h1><p>{snapshot.mode==='mock'?'예시 기록입니다. ':''}포털에 누가 들어와 무엇을 봤는지, 클라우드에서 누가 무엇을 바꿨는지 확인합니다.</p></div>
    <div className="page-actions"><div className="segmented" role="tablist" aria-label="기록 종류">{([['portal','포털 접근'],['cloud','클라우드 변경']] as const).map(([k,l])=><button key={k} role="tab" aria-selected={tab===k} className={tab===k?'active':''} onClick={()=>setTab(k)}>{l}</button>)}</div>
      <label className="scenario"><span>기간</span><select value={days} onChange={e=>setDays(Number(e.target.value))}>{[1,7,14,30].map(d=><option key={d} value={d}>최근 {d}일</option>)}</select></label></div></header>
    {tab==='portal'?<PortalLog days={days} mock={snapshot.mode==='mock'} byName={new Map(snapshot.resources.map(r=>[r.name,r.id]))} openResource={openResource} onCsv={onCsv}/>:<CloudLog snapshot={snapshot} focus={focus} days={days} openResource={openResource} onCsv={onCsv}/>}
  </div>;
}
function PortalLog({days,mock,byName,openResource,onCsv}:{days:number;mock:boolean;byName:Map<string,string>;openResource:(id:string)=>void;onCsv:(content:string,name:string)=>void}){
  const [events,setEvents]=useState<AuditEvent[]|null>(null),[writes,setWrites]=useState<{failures:number;lastFailureAt?:string}|null>(null),[error,setError]=useState(''),[who,setWho]=useState('all'),[action,setAction]=useState('all'),[q,setQ]=useState(''),[tick,setTick]=useState(0);
  useEffect(()=>{let stale=false;setError('');fetch(`/api/audit?days=${days}`).then(async r=>{if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error??'기록을 불러오지 못했습니다.');return r.json();}).then(b=>{if(!stale){setEvents(b.events);setWrites(b.writes?.failures?b.writes:null);}}).catch(e=>{if(!stale){setEvents([]);setError(e.message);}});return()=>{stale=true;};},[days,tick]);
  const all=events??[],people=[...new Set(all.map(e=>e.actor))].sort();
  const shown=all.filter(e=>(who==='all'||e.actor===who)&&(action==='all'||e.action===action)&&(!q||`${e.actor} ${e.target??''} ${e.detail??''} ${e.ip??''}`.toLowerCase().includes(q.toLowerCase())));
  const daily=useMemo(()=>perDay(all,e=>e.at,e=>BUCKET[e.action],BUCKETS.map(b=>b.key),Math.min(days,30)),[all,days]),alarms=bursts(all);
  const humans=new Set(all.filter(e=>e.action==='login'||e.action==='view').map(e=>e.actor)),failed=all.filter(e=>e.action==='login_failed'||e.action==='denied').length;
  if(error)return <div className="panel empty-panel" role="alert"><p>{error}</p><p className="muted small">접근 로그는 auditor 역할이 있는 전체 범위(*) 토큰만 볼 수 있습니다.</p></div>;
  if(!events)return <div className="skeleton" role="status"><RefreshCw className="spin"/>기록을 불러오는 중입니다.</div>;
  const exportCsv=()=>onCsv(csv([['time','actor','action','target','detail','ip','agent'],...shown.map(e=>[e.at,e.actor,e.action,e.target??'',e.detail??'',e.ip??'',e.agent??''])]),'cloud-atlas-portal-audit.csv');
  return <>
    {mock&&<p className="muted small page-notice">예시 기록에 이 브라우저에서 방금 한 조회가 함께 보입니다. 실제 운영에서는 서버의 data/audit에 월별로 쌓이고 IP와 브라우저 정보도 남습니다.</p>}
    {writes&&<div className="notice warn page-notice" role="alert"><AlertTriangle size={15}/><p>서버가 접근 기록을 {writes.failures}번 남기지 못했습니다{writes.lastFailureAt?` (마지막 ${when(writes.lastFailureAt)})`:''}. 그동안의 기록은 빠져 있을 수 있습니다. 서버의 데이터 폴더 권한과 디스크 공간을 확인하세요.</p></div>}
    {alarms.length>0&&<div className="notice warn page-notice"><AlertTriangle size={15}/><p>로그인 실패가 몰린 구간이 {alarms.length}번 있습니다: {alarms.map(a=>`${when(a.at)} ${a.from}에서 ${a.count}회`).join(', ')}. 토큰이 유출됐거나 추측 시도일 수 있습니다.</p></div>}
    <section className="kpi-row" aria-label="포털 접근 지표"><Kpi label="접속한 사람" value={String(humans.size)} hint={`최근 ${days}일`}/><Kpi label="로그인 실패·거부" value={String(failed)} tone={failed?'warn':undefined} hint={alarms.length?`몰림 ${alarms.length}회`:'몰림 없음'}/><Kpi label="화면 조회" value={String(all.filter(e=>e.action==='view').length)}/><Kpi label="리소스 열람" value={String(all.filter(e=>e.action==='open').length)}/><Kpi label="수집·내보내기" value={String(all.filter(e=>e.action==='collect'||e.action==='export').length)}/></section>
    <div className="dash-grid">
      <section className="panel span-3"><header className="panel-head"><h2>일별 활동</h2></header><Columns data={daily} series={BUCKETS}/></section>
      <section className="panel"><header className="panel-head"><h2>사용자별 활동</h2></header><HBars data={top(all,e=>e.actor).map(([k,v])=>({key:k,label:k,value:v}))} labelWidth={120} onPick={setWho}/></section>
      <section className="panel"><header className="panel-head"><h2>많이 본 화면</h2></header><HBars data={top(all.filter(e=>e.action==='view'),e=>e.target).map(([k,v])=>({key:k,label:PAGE[k]??k,value:v,color:'#7c93c9'}))}/></section>
      <section className="panel"><header className="panel-head"><h2>많이 열람한 리소스 <small>누르면 지도에서 보기</small></h2></header><HBars data={top(all.filter(e=>e.action==='open'),e=>e.target).map(([k,v])=>({key:k,label:k,value:v,color:'var(--path)'}))} labelWidth={130} onPick={k=>{const id=byName.get(k)??k;openResource(id);}}/></section>
      <section className="panel span-3"><header className="panel-head wrap"><h2>기록 <span className="count">{shown.length}</span></h2><div className="table-tools"><select aria-label="사용자" value={who} onChange={e=>setWho(e.target.value)}><option value="all">모든 사용자</option>{people.map(p=><option key={p}>{p}</option>)}</select><select aria-label="행동" value={action} onChange={e=>setAction(e.target.value)}><option value="all">모든 행동</option>{Object.entries(ACTION).map(([k,l])=><option key={k} value={k}>{l}</option>)}</select><input type="search" aria-label="기록 검색" placeholder="대상, IP 검색" value={q} onChange={e=>setQ(e.target.value)}/><button className="button" onClick={()=>setTick(t=>t+1)} aria-label="새로고침"><RefreshCw size={14}/></button><button className="button" onClick={exportCsv}><Download size={14}/>CSV</button></div></header>
        <div className="table-wrap tall"><table className="data-table"><thead><tr><th>시각</th><th>사용자</th><th>행동</th><th>대상</th><th>상세</th>{!mock&&<th>IP</th>}</tr></thead><tbody>{shown.slice(0,400).map(e=><tr key={e.id} className={e.action==='login_failed'||e.action==='denied'?'row-warn':''}><td className="mono nowrap">{when(e.at)}</td><td>{e.actor}</td><td><span className={`tag a-${BUCKET[e.action]}`}>{ACTION[e.action]}</span></td><td>{e.action==='open'&&byName.has(e.target??'')?<button className="table-link" onClick={()=>openResource(byName.get(e.target!)!)}>{e.target}<ArrowUpRight size={12}/></button>:PAGE[e.target??'']??e.target??'—'}</td><td className="muted">{e.detail??''}</td>{!mock&&<td className="mono">{e.ip??''}</td>}</tr>)}</tbody></table>{!shown.length&&<p className="muted small empty-row">조건에 맞는 기록이 없습니다.</p>}{shown.length>400&&<p className="muted small empty-row">최근 400건만 표시합니다. 전체는 CSV로 받으세요.</p>}</div></section>
    </div></>;
}
function CloudLog({snapshot,focus,days,openResource,onCsv}:{snapshot:Snapshot;focus:Focus;days:number;openResource:(id:string)=>void;onCsv:(content:string,name:string)=>void}){
  const [who,setWho]=useState('all'),[kind,setKind]=useState('all'),[q,setQ]=useState(''),since=Date.now()-days*86_400_000;
  const ids=useMemo(()=>new Set(snapshot.resources.map(r=>r.id)),[snapshot]);
  const all=useMemo(()=>snapshot.activity.filter(a=>inScope(focus,a.provider,a.scope)&&Date.parse(a.at)>=since),[snapshot,focus,since]);
  const shown=all.filter(a=>(who==='all'||a.actor===who)&&(kind==='all'||(kind==='sensitive'?SENSITIVE.test(a.operation):kind==='failed'?a.outcome==='failed':a.kind===kind))&&(!q||`${a.actor} ${a.targetName} ${a.label} ${a.operation} ${a.ip??''}`.toLowerCase().includes(q.toLowerCase())));
  const providers=['azure','aws','gcp'].filter(p=>all.some(a=>a.provider===p)),daily=useMemo(()=>perDay(all,a=>a.at,a=>a.provider,providers,Math.min(days,30)),[all,days,providers.join()]);
  const sensitive=all.filter(a=>SENSITIVE.test(a.operation)),people=[...new Set(all.map(a=>a.actor))].sort(),actors=new Set(all.map(a=>a.actor));
  const exportCsv=()=>onCsv(csv([['time','provider','actor','actor_type','operation','kind','target','scope','outcome','ip','source'],...shown.map(a=>[a.at,a.provider,a.actor,a.actorType,a.operation,a.kind,a.targetName,snapshot.scopeLabels[a.scope]??a.scope,a.outcome,a.ip??'',a.source])]),'cloud-atlas-cloud-activity.csv');
  if(!snapshot.activity.length)return <div className="panel empty-panel"><p>아직 수집한 클라우드 변경 기록이 없습니다.</p><p className="muted small">Azure Activity Log, AWS CloudTrail, GCP Admin Activity 감사 로그에서 최근 7일의 생성·변경·삭제를 읽습니다. Azure는 Reader, AWS는 cloudtrail:LookupEvents, GCP는 roles/logging.viewer 권한이 필요합니다.</p></div>;
  return <>
    {sensitive.length>0&&<div className="notice warn page-notice"><AlertTriangle size={15}/><p>방화벽·보안 그룹·권한처럼 접근 경로를 바꾸는 변경이 {sensitive.length}건 있습니다. 아래 필터에서 "민감한 변경"으로 모아 볼 수 있습니다.</p></div>}
    <section className="kpi-row" aria-label="클라우드 변경 지표"><Kpi label="변경 기록" value={String(all.length)} hint={`최근 ${days}일 · 최대 7일 수집`}/><Kpi label="삭제" value={String(all.filter(a=>a.kind==='delete').length)} tone={all.some(a=>a.kind==='delete')?'warn':undefined}/><Kpi label="민감한 변경" value={String(sensitive.length)} tone={sensitive.length?'warn':undefined} onClick={()=>setKind('sensitive')}/><Kpi label="실패한 시도" value={String(all.filter(a=>a.outcome==='failed').length)} onClick={()=>setKind('failed')}/><Kpi label="변경한 주체" value={String(actors.size)} hint={`사람 ${new Set(all.filter(a=>a.actorType==='user').map(a=>a.actor)).size} · 서비스 ${new Set(all.filter(a=>a.actorType==='service').map(a=>a.actor)).size}`}/></section>
    <div className="dash-grid">
      <section className="panel span-2"><header className="panel-head"><h2>일별 변경</h2></header><Columns data={daily} series={providers.map(p=>({key:p,label:PROVIDER_LABEL[p],color:PROVIDER_COLOR[p]}))}/></section>
      <section className="panel"><header className="panel-head"><h2>변경 종류</h2></header><Donut data={(Object.keys(KIND) as Activity['kind'][]).map(k=>({key:k,label:KIND[k].label,value:all.filter(a=>a.kind===k).length,color:KIND[k].color}))} unit="건" onPick={setKind}/></section>
      <section className="panel"><header className="panel-head"><h2>누가 많이 바꿨나</h2></header><HBars data={top(all,a=>a.actor).map(([k,v])=>({key:k,label:k.length>28?`…${k.slice(-27)}`:k,value:v}))} labelWidth={170} onPick={setWho}/></section>
      <section className="panel span-2"><header className="panel-head"><h2>많이 바뀐 리소스 <small>누르면 지도에서 보기</small></h2></header><HBars data={top(all,a=>a.target||undefined).map(([k,v])=>({key:k,label:all.find(a=>a.target===k)?.targetName??k,value:v,color:PROVIDER_COLOR[all.find(a=>a.target===k)?.provider??'']}))} labelWidth={150} onPick={k=>{if(ids.has(k))openResource(k);}}/></section>
      <section className="panel span-3"><header className="panel-head wrap"><h2>기록 <span className="count">{shown.length}</span></h2><div className="table-tools"><select aria-label="주체" value={who} onChange={e=>setWho(e.target.value)}><option value="all">모든 주체</option>{people.map(p=><option key={p}>{p}</option>)}</select><select aria-label="변경 종류" value={kind} onChange={e=>setKind(e.target.value)}><option value="all">모든 종류</option><option value="sensitive">민감한 변경</option><option value="failed">실패한 시도</option>{Object.entries(KIND).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select><input type="search" aria-label="기록 검색" placeholder="리소스, 작업, IP 검색" value={q} onChange={e=>setQ(e.target.value)}/><button className="button" onClick={exportCsv}><Download size={14}/>CSV</button></div></header>
        <div className="table-wrap tall"><table className="data-table"><thead><tr><th>시각</th><th>클라우드</th><th>주체</th><th>작업</th><th>대상</th><th>범위</th><th>결과</th></tr></thead><tbody>{shown.slice(0,400).map(a=><tr key={a.id} className={a.outcome==='failed'?'row-warn':''}><td className="mono nowrap">{when(a.at)}</td><td>{PROVIDER_LABEL[a.provider]}</td><td title={a.ip?`IP ${a.ip}`:undefined}>{a.actor}<small className="muted block">{a.actorType==='user'?'사람':a.actorType==='service'?'서비스':''}</small></td><td><span className={`tag k-${a.kind}`}>{KIND[a.kind].label}</span> {a.label}{SENSITIVE.test(a.operation)&&<span className="tag a-bad">민감</span>}</td><td>{ids.has(a.target)?<button className="table-link" onClick={()=>openResource(a.target)}>{a.targetName}<ArrowUpRight size={12}/></button>:a.targetName||'—'}</td><td>{snapshot.scopeLabels[a.scope]??a.scope}</td><td>{a.outcome==='failed'?<span className="tag a-bad">실패</span>:'성공'}</td></tr>)}</tbody></table>{!shown.length&&<p className="muted small empty-row">조건에 맞는 기록이 없습니다.</p>}</div>
        <p className="source-note">출처: Azure Activity Log, AWS CloudTrail 관리 이벤트, GCP Admin Activity 감사 로그. 읽기 전용 호출은 제외했습니다.</p></section>
    </div></>;
}
