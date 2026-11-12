import {useEffect,useState,useRef} from 'react';
import {z} from 'zod';
import {ArrowUpRight,RefreshCw} from 'lucide-react';
import {ResourcePage} from '../../shared/page-contracts';
import {ResourceSchema,ResourceKind,type Snapshot,type Resource} from '../../shared/schema';
import {CATEGORIES,categoryOf} from '../../shared/capacity';
import type {Focus} from '../../shared/hierarchy';
import type {ResourcePreferences,SortKey} from '../resource-preferences';
import {scopeQuery,useServerPage} from '../useServerPage';
import {kindNames} from '../graph';
import {statusLabel} from '../../shared/status';
import {health} from '../../shared/topology';
import {CollectionNotice} from '../CollectionNotice';
import {Kpi} from '../charts';
import {HBars,PROVIDER_LABEL} from '@/ui/viz';
const healthLabels={ok:'정상',warn:'이상',stopped:'중지',unknown:'권한 없음',neutral:'상태 미확인·구성만 수집'};
const Detail=z.object({version:z.literal(1),resource:ResourceSchema});
export function ServerResources({snapshot,focus,query,onOpen,preferences}:{snapshot:Snapshot;focus:Focus;query:string;onOpen:(r:Resource)=>void;preferences:ResourcePreferences}){
  const {category,setCategory,showAuxiliary,setShowAuxiliary,kind,setKind,state,setState,sort,setSort}=preferences;
  const [detailError,setDetailError]=useState(''),[detail,setDetail]=useState<Resource|null>(null),request=useRef<AbortController|null>(null);
  useEffect(()=>{setDetail(null);setDetailError('');return()=>request.current?.abort();},[snapshot,focus]);
  const params=scopeQuery(focus);params.set('scenario',snapshot.scenario??'standard');params.set('q',query);params.set('category',category);params.set('kind',kind);params.set('state',state);params.set('sort',sort.key);params.set('dir',String(sort.dir));params.set('auxiliary',showAuxiliary?'1':'0');
  const page=useServerPage('/api/resources',params,ResourcePage,snapshot),data=page.value;
  useEffect(()=>{if(kind!=='all'&&category!=='all'&&categoryOf(kind as Resource['kind'])!==category)setKind('all');},[category,kind,setKind]);
  const open=async(id:string)=>{
    setDetailError('');request.current?.abort();const controller=new AbortController();request.current=controller;
    try{const params=new URLSearchParams({id,scenario:snapshot.scenario??'standard'}),response=await fetch(`/api/resource?${params}`,{signal:controller.signal}),body=await response.json();if(!response.ok)throw new Error(body.error??'자원을 읽지 못했습니다.');const resource=Detail.parse(body).resource;if(controller.signal.aborted)return;if(['network','subnet','endpoint','gateway','appliance','loadbalancer','nat','onprem','external','firewall','compute','database','cluster'].includes(resource.kind))onOpen(resource);else setDetail(resource);}
    catch(e){if(controller.signal.aborted)return;setDetailError(e instanceof Error?e.message:'자원을 읽지 못했습니다.');}
  };
  const header=(key:SortKey,label:string)=><th aria-sort={sort.key===key?(sort.dir===1?'ascending':'descending'):undefined}><button className="link-button" onClick={()=>setSort(old=>({key,dir:old.key===key&&old.dir===1?-1:1}))}>{label}{sort.key===key?(sort.dir===1?' ↑':' ↓'):''}</button></th>;
  return <div className="page" aria-busy={page.loading}><header className="page-head"><div><h1>리소스</h1><p>종류별 현황과 VM 용량을 확인합니다. 목록은 한 페이지에 최대 100개를 표시합니다.</p></div><label><input type="checkbox" checked={showAuxiliary} onChange={e=>setShowAuxiliary(e.target.checked)}/> 구성 부속물 포함</label></header>
    <CollectionNotice snapshot={snapshot} focus={focus}/>
    {detail&&<section className="panel resource-details" aria-label="자원 상세"><header className="panel-head"><h2>{detail.name}</h2><button className="button" onClick={()=>setDetail(null)}>상세 닫기</button></header><dl><dt>유형</dt><dd>{detail.type}</dd><dt>상태</dt><dd title={detail.status}>{statusLabel(detail.status)}</dd><dt>원본 ID</dt><dd>{detail.nativeId}</dd><dt>출처</dt><dd>{detail.source}</dd>{Object.entries(detail.specs).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></section>}

    {showAuxiliary&&!!snapshot.inventorySummary.length&&<details className="collection-notice" open><summary>구성 요소 요약</summary><ul>{snapshot.inventorySummary.filter(s=>(focus.provider==='all'||s.provider===focus.provider)&&(!focus.scopes||focus.scopes.has(s.scope))).slice(0,100).map(s=><li key={`${s.provider}:${s.scope}:${s.type}`}>{s.type}: {s.count}개 · 예시: {s.examples.map(e=>e.name).join(', ')}{s.retained?' · 이전 요약 유지':''}</li>)}</ul></details>}

    <div className="segmented resource-tabs" role="tablist" aria-label="리소스 종류"><button role="tab" aria-selected={category==='all'} onClick={()=>setCategory('all')}>전체{data?` ${data.summary.total}`:''}</button>{CATEGORIES.map(c=><button key={c.id} role="tab" aria-selected={category===c.id} onClick={()=>setCategory(c.id)}>{c.label}{data?` ${data.summary.kinds.filter(k=>categoryOf(k.kind)===c.id).reduce((n,k)=>n+k.count,0)}`:''}</button>)}</div>
    <div className="table-tools"><label>유형 <select value={kind} onChange={e=>setKind(e.target.value)}><option value="all">전체</option>{ResourceKind.options.filter(k=>category==='all'||categoryOf(k)===category).map(k=><option key={k} value={k}>{kindNames[k]}</option>)}</select></label><label>상태 <select value={state} onChange={e=>setState(e.target.value)}><option value="all">전체</option>{Object.entries(healthLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label></div>
    {data&&page.loading&&<p className="refresh-notice" role="status">목록을 갱신하고 있습니다.</p>}
    {page.error&&<div className="notice warn" role="alert"><p>{page.error}</p><button className="button" onClick={page.retry}>다시 시도</button></div>}{!data&&!page.error&&<div className="skeleton" role="status"><RefreshCw className="spin"/>리소스 목록을 불러오는 중입니다.</div>}{data&&<>
      <section className="kpi-row" aria-label="리소스 현황"><Kpi label="전체 자원" value={data.summary.total.toLocaleString('ko-KR')}/><Kpi label="VM" value={String(data.summary.vm)}/><Kpi label="vCPU" value={data.summary.capacityTargets&&!data.summary.vcpuKnown?'미확인':String(data.summary.vcpu)} hint={data.summary.capacityTargets>data.summary.vcpuKnown?`미확인 ${data.summary.capacityTargets-data.summary.vcpuKnown}대는 합계에서 제외`:'중지 VM 제외'}/><Kpi label="메모리" value={data.summary.capacityTargets&&!data.summary.memoryKnown?'미확인':`${data.summary.memoryGiB.toLocaleString('ko-KR')} GiB`} hint={data.summary.capacityTargets>data.summary.memoryKnown?`미확인 ${data.summary.capacityTargets-data.summary.memoryKnown}대는 합계에서 제외`:'중지 VM 제외'}/></section>
      {!!data.summary.sizeIssues.length&&<p className="notice warn" role="status">VM 용량 확인 필요 · {data.summary.sizeIssues.map(i=>`${i.reason} ${i.count}대`).join(' / ')}. 미확인 값은 합계에서 제외합니다.</p>}
      {category==='compute'&&<><section className="kpi-row"><Kpi label="확인된 VM 디스크" value={`${data.summary.diskGiB.toLocaleString('ko-KR')} GiB`} hint="알 수 없는 디스크 크기 제외"/><Kpi label="확인된 GPU" value={String(data.summary.gpus)} hint={`${data.summary.gpuHosts}대 · 모델/개수 미확인 제외`}/></section><section className="panel"><header className="panel-head"><h2>VM 크기 상위 20개</h2></header><HBars data={data.summary.sizes.map(s=>({key:s.name,label:s.name,value:s.count}))} labelWidth={160}/></section></>}
      {category==='data'&&<section className="panel"><header className="panel-head"><h2>데이터베이스 종류 상위 20개</h2></header><HBars data={data.summary.engines.map(s=>({key:s.name,label:s.name,value:s.count}))} labelWidth={160}/></section>}
      {!!data.summary.unknownTypes.length&&<details className="collection-notice"><summary>미분류 타입 상위 {data.summary.unknownTypes.length}개</summary><ul>{data.summary.unknownTypes.map(t=><li key={t.name}>{t.name}: {t.count}개</li>)}</ul></details>}
      <div className="dash-grid"><section className="panel span-2"><header className="panel-head"><h2>유형별 자원</h2></header><HBars data={data.summary.kinds.map(k=>({key:k.kind,label:kindNames[k.kind],value:k.count}))} onPick={k=>setCategory(categoryOf(k as Resource['kind']))}/></section><section className="panel"><header className="panel-head"><h2>클라우드별 자원</h2></header><HBars data={data.summary.providers.map(p=>({key:p.provider,label:PROVIDER_LABEL[p.provider],value:p.count}))}/></section></div>
      <section className="panel"><header className="panel-head wrap"><h2>리소스 목록 <span className="count">{data.total}</span></h2></header>
        {detailError&&<p role="alert">{detailError}</p>}
        <div className="table-wrap"><table className="data-table"><thead><tr>{header('name','리소스')}{header('provider','클라우드')}{header('kind','유형')}{header('size','크기·종류')}{header('scope','소유 범위')}{header('address','주소')}{header('region','위치')}{header('status','상태')}</tr></thead><tbody>{data.rows.map(r=><tr key={r.id}><td><button className="table-link" onClick={()=>open(r.id)}>{r.name}<ArrowUpRight size={12}/></button></td><td>{PROVIDER_LABEL[r.provider]}</td><td>{kindNames[r.kind]}</td><td>{r.size??'—'}</td><td>{snapshot.scopeLabels[r.scope]??r.scope}</td><td>{r.ip??r.cidr??'—'}</td><td>{r.region}</td><td><span className={`status h-${health(r.status)}`} title={r.status}>{statusLabel(r.status)}</span></td></tr>)}</tbody></table>{!data.rows.length&&<p className="empty-row">조건에 맞는 자원이 없습니다.</p>}</div>
        <div className="page-actions" role="group" aria-label="리소스 페이지"><button className="button" disabled={!page.index} onClick={page.previous}>이전 페이지</button><span>{page.index+1} / {Math.max(1,Math.ceil(data.total/100))} · 전체 {data.total}개</span><button className="button" disabled={!data.nextCursor} onClick={page.next}>다음 페이지</button></div>
      </section>
    </>}
  </div>;
}
