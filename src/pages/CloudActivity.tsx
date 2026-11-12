import {activityIdentity} from '../../shared/activity';
import {useMemo,useState} from 'react';
import {ArrowUpRight,Download,RefreshCw} from 'lucide-react';
import type {Activity,Snapshot} from '../../shared/schema';
import type {Focus} from '../../shared/hierarchy';
import {ActivityPage,sensitiveActivity} from '../../shared/page-contracts';
import {scopeQuery,useServerPage} from '../useServerPage';
import {useSearchQuery} from '../useSearchQuery';
import {Kpi} from '../charts';
import {Columns,Donut,PROVIDER_COLOR,PROVIDER_LABEL} from '@/ui/viz';
const labels={write:'생성·변경',delete:'삭제',action:'작업 실행'};
const when=(at:string)=>new Date(at).toLocaleString('ko-KR');
const csv=(rows:string[][])=>rows.map(row=>row.map(value=>`"${value.replace(/"/g,'""')}"`).join(',')).join('\n');
export function CloudActivity({snapshot,focus,days,openResource,onCsv}:{snapshot:Snapshot;focus:Focus;days:number;openResource:(id:string)=>void;onCsv:(content:string,name:string)=>void}){
  const [actor,setActor]=useState('all'),[kind,setKind]=useState('all'),[query,setQuery]=useState(''),[composing,setComposing]=useState(false),[exporting,setExporting]=useState(false),[exportError,setExportError]=useState('');
  const settled=useSearchQuery(query,composing),params=scopeQuery(focus);
  params.set('scenario',snapshot.scenario??'standard');params.set('days',String(days));params.set('actor',actor);params.set('kind',kind);params.set('q',settled);
  const page=useServerPage('/api/activity',params,ActivityPage,snapshot),data=page.value;
  const ids=useMemo(()=>new Set(snapshot.resources.map(r=>r.id)),[snapshot]);
  const exportCsv=async()=>{
    setExporting(true);setExportError('');
    try{
      const rows:Activity[]=[];let cursor:string|undefined;
      do{const query=new URLSearchParams(params);if(cursor)query.set('cursor',cursor);const response=await fetch(`/api/activity?${query}`),body=await response.json();if(!response.ok)throw new Error(body.error??'기록을 내보내지 못했습니다.');const result=ActivityPage.parse(body);rows.push(...result.rows);cursor=result.nextCursor;}while(cursor);
      onCsv(csv([['time','provider','actor','actor_type','operation','kind','target','scope','outcome','ip','source'],...rows.map(a=>[a.at,a.provider,a.actor,a.actorType,a.operation,a.kind,a.targetName,snapshot.scopeLabels[a.scope]??a.scope,a.outcome,a.ip??'',a.source])]),'cloud-atlas-cloud-activity.csv');
    }catch(e){setExportError(e instanceof Error?e.message:'기록을 내보내지 못했습니다.');}finally{setExporting(false);}
  };
  const daily=new Map<string,Record<string,string|number>>();
  for(const item of data?.summary.daily??[]){let row=daily.get(item.day);if(!row){row={x:item.day.slice(5)};daily.set(item.day,row);}row[item.provider]=item.count;}
  return <>
    <section className="panel" aria-busy={page.loading}><header className="panel-head wrap"><h2>클라우드 변경 기록</h2><div className="table-tools"><select aria-label="주체" value={actor} onChange={e=>setActor(e.target.value)}><option value="all">모든 주체</option>{actor!=='all'&&!data?.actors.includes(actor)&&<option>{actor}</option>}{data?.actors.map(name=><option key={name}>{name}</option>)}</select><select aria-label="변경 종류" value={kind} onChange={e=>setKind(e.target.value)}><option value="all">모든 종류</option><option value="sensitive">민감한 변경</option><option value="failed">실패한 시도</option>{Object.entries(labels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><input type="search" aria-label="기록 검색" placeholder="리소스, 작업, IP 검색" value={query} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} onChange={e=>setQuery(e.target.value)}/><button className="button" onClick={exportCsv} disabled={exporting||!data}><Download size={14}/>{exporting?'내보내는 중':'CSV'}</button></div></header>
      <p className="muted small">최근 {days}일 · 스냅샷 시각 기준. 수집기는 최근 7일을 조회합니다. 기록이 없다는 사실은 변경이 없었음을 보장하지 않습니다.</p>
      {data&&data.coverage.incompleteScopes>0&&<p className="notice warn" role="status">활동 기록 완료를 확인하지 못한 범위 {data.coverage.incompleteScopes}개{data.coverage.limitedScopes?` · 조회 상한 도달 ${data.coverage.limitedScopes}개`:''}. 이전 기록이 있으면 함께 유지합니다.</p>}
      {exportError&&<p role="alert">{exportError}</p>}
      {data&&page.loading&&<p className="refresh-notice" role="status">기록을 갱신하고 있습니다.</p>}{page.error&&<div role="alert"><p>{page.error}</p><button className="button" onClick={page.retry}>다시 시도</button></div>}{!data&&!page.error&&<div className="skeleton" role="status"><RefreshCw className="spin"/>변경 기록을 불러오는 중입니다.</div>}{data&&<>
        <div className="table-wrap tall"><table className="data-table"><thead><tr><th>시각</th><th>클라우드</th><th>주체</th><th>작업</th><th>대상</th><th>범위</th><th>결과</th></tr></thead><tbody>{data.rows.map(a=><tr key={activityIdentity(a)}><td>{when(a.at)}</td><td>{PROVIDER_LABEL[a.provider]}</td><td title={a.ip?`IP ${a.ip}`:undefined}>{a.actor}</td><td>{labels[a.kind]} · {a.label}{sensitiveActivity.test(a.operation)&&<span className="tag a-bad">민감</span>}</td><td>{ids.has(a.target)?<button className="table-link" onClick={()=>openResource(a.target)}>{a.targetName}<ArrowUpRight size={12}/></button>:a.targetName||'—'}</td><td>{snapshot.scopeLabels[a.scope]??a.scope}</td><td>{a.outcome==='failed'?'실패':'성공'}</td></tr>)}</tbody></table>{!data.rows.length&&<p className="empty-row">조건에 맞는 기록이 없습니다. 수집 항목과 권한을 확인하세요.</p>}</div>
        <div className="page-actions" role="group" aria-label="활동 기록 페이지"><button className="button" disabled={!page.index} onClick={page.previous}>이전 페이지</button><span>{page.index+1} / {Math.max(1,Math.ceil(data.total/100))} · 전체 {data.total}건</span><button className="button" disabled={!data.nextCursor} onClick={page.next}>다음 페이지</button></div>
      </>}
    </section>
    {data&&<><section className="kpi-row" aria-label="클라우드 변경 지표"><Kpi label="변경 기록" value={String(data.summary.total)}/><Kpi label="민감한 변경" value={String(data.summary.sensitive)} onClick={()=>setKind('sensitive')}/><Kpi label="실패한 시도" value={String(data.summary.failed)} onClick={()=>setKind('failed')}/><Kpi label="변경한 주체" value={String(data.summary.actors)} hint={data.summary.actors>200?'주체 필터는 상위 200개를 표시합니다.':undefined}/></section><div className="dash-grid"><section className="panel"><header className="panel-head"><h2>일별 변경</h2></header><Columns data={[...daily.values()]} series={['azure','aws','gcp'].map(p=>({key:p,label:PROVIDER_LABEL[p],color:PROVIDER_COLOR[p]}))}/></section><section className="panel"><header className="panel-head"><h2>변경 종류</h2></header><Donut data={data.summary.kinds.map(k=>({key:k.kind,label:labels[k.kind],value:k.count,color:k.kind==='delete'?'var(--warn)':k.kind==='action'?'var(--amber)':'var(--accent)'}))} unit="건" onPick={setKind}/></section></div></>}
  </>;
}
