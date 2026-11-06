import {useEffect,useMemo,useState} from 'react';
import {ArrowRight,Boxes,KeyRound,Minus,Network,PenLine,Plus,ShieldAlert,Users} from 'lucide-react';
import type {AuditEvent,Snapshot} from '../../shared/schema';
import {money,summarizeCost} from '../../shared/cost';
import {useCostCurrency} from '../currency';
import {exposures,health,isWideInbound} from '../../shared/topology';
import {allRules,cidrOverlaps,hybridLinks} from '../../shared/network';
import {CATEGORIES,categoryOf,fleetTotals} from '../../shared/capacity';
import type {Finding,Severity} from '../../shared/findings';
import {iamInScope,inScope,type Focus} from '../../shared/hierarchy';
import {ProviderMark} from '../graph';
import {CostTrend,Kpi} from '../charts';
import {FindingList} from './Findings';
import {Columns,Donut,ShareBar,Spark,PROVIDER_COLOR,PROVIDER_LABEL,SEVERITY_COLOR} from '@/ui/viz';
export type Go=(view:'findings'|'changes'|'map'|'iam'|'cost'|'network'|'security'|'inventory'|'audit',id?:string)=>void;
const changeIcon={added:Plus,removed:Minus,changed:PenLine};
const SEVERITY:Record<Severity,string>={critical:'긴급',high:'높음',medium:'보통',info:'참고'};
const HEALTH=[{key:'ok',label:'정상',color:'var(--path)'},{key:'warn',label:'이상',color:'var(--warn)'},{key:'stopped',label:'중지',color:'var(--faint)'},{key:'unknown',label:'권한 없음',color:'var(--amber)'},{key:'neutral',label:'구성만 수집',color:'var(--line-strong)'}] as const;
const CATEGORY_COLOR:Record<string,string>={compute:'var(--accent)',container:'#7c93c9',data:'var(--path)',network:'var(--peering)',security:'var(--amber)',service:'var(--line-strong)'};
const gib=(v:number)=>v>=1024?`${(v/1024).toFixed(1)} TiB`:`${Math.round(v)} GiB`;
const days7=(now=Date.now())=>Array.from({length:7},(_,i)=>new Date(now-(6-i)*86_400_000).toISOString().slice(0,10));
// Admins see who used the portal; others simply get no card, since the log is restricted on the server.
function usePortalAudit(){
  const [events,setEvents]=useState<AuditEvent[]|null>(null);
  useEffect(()=>{let stale=false;fetch('/api/audit?days=7').then(r=>r.ok?r.json():null).then(b=>{if(!stale)setEvents(b?.events??null);}).catch(()=>{});return()=>{stale=true;};},[]);
  return events;
}
function Card({title,sub,to,go,className='',children}:{title:string;sub?:string;to?:Parameters<Go>[0];go:Go;className?:string;children:React.ReactNode}){
  return <section className={`panel ${className}`}><header className="panel-head"><h2>{title}{sub&&<small>{sub}</small>}</h2>{to&&<button className="link-button" onClick={()=>go(to)}>자세히<ArrowRight size={14}/></button>}</header>{children}</section>;
}
export function Dashboard({snapshot,focus,list,go,openFinding}:{snapshot:Snapshot;focus:Focus;list:Finding[];go:Go;openFinding:(f:Finding)=>void}){
  const present=['azure','aws','gcp'].filter(p=>(focus.provider==='all'||p===focus.provider)&&snapshot.resources.some(r=>r.provider===p));
  const resources=useMemo(()=>snapshot.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external'&&inScope(focus,r.provider,r.scope)),[snapshot,focus]);
  const {currency,fx}=useCostCurrency(snapshot),cost=useMemo(()=>summarizeCost(snapshot.cost.filter(c=>inScope(focus,c.provider,c.scope)),undefined,fx,currency),[snapshot,focus,fx,currency]);
  const fmt=(v:number)=>money(v,currency),iam=snapshot.iam.filter(a=>iamInScope(focus,a)),portal=usePortalAudit();
  const real=resources.filter(r=>r.kind!=='subnet'&&r.kind!=='firewall'),vms=resources.filter(r=>r.kind==='compute'),fleet=fleetTotals(vms);
  const urgent=list.filter(f=>f.severity==='critical'||f.severity==='high').length;
  const exposed=exposures(snapshot.resources,snapshot.links).filter(e=>inScope(focus,e.resource.provider,e.resource.scope));
  const rules=allRules(snapshot.resources).filter(({policy})=>inScope(focus,policy.provider,policy.scope)),wide=rules.filter(({rule})=>isWideInbound(rule)).length;
  const principals=new Map(iam.map(a=>[`${a.provider}|${a.principal}`,a])),privileged=new Set(iam.filter(a=>a.privileged).map(a=>`${a.provider}|${a.principal}`)).size,external=new Set(iam.filter(a=>a.external).map(a=>`${a.provider}|${a.principal}`)).size;
  const networks=resources.filter(r=>r.kind==='network'),hybrid=hybridLinks(snapshot.resources,snapshot.links).filter(h=>inScope(focus,h.target.provider,h.target.scope)),overlaps=cidrOverlaps(snapshot.resources).filter(o=>inScope(focus,o.a.provider,o.a.scope)||inScope(focus,o.b.provider,o.b.scope));
  const peerings=snapshot.links.filter(l=>l.kind==='peering'&&resources.some(r=>r.id===l.source));
  const activity=snapshot.activity.filter(a=>inScope(focus,a.provider,a.scope)),week=days7();
  const changes=(snapshot.changes?.items??[]).filter(c=>inScope(focus,c.provider,c.scope));
  const headline=cost.projected??cost.currentTotal,delta=cost.previousTotal?(headline-cost.previousTotal)/cost.previousTotal:null;
  const warnCount=real.filter(r=>health(r.status)==='warn').length;
  const byCloud=present.map(p=>({cloud:PROVIDER_LABEL[p],...Object.fromEntries(CATEGORIES.map(c=>[c.id,resources.filter(r=>r.provider===p&&r.kind!=='subnet'&&categoryOf(r.kind)===c.id).length]))}));
  const dailyActivity=week.map(d=>({x:d.slice(5).replace('-','/'),...Object.fromEntries(present.map(p=>[p,activity.filter(a=>a.provider===p&&a.at.startsWith(d)).length]))}));
  const logins=portal?week.map(d=>new Set(portal.filter(e=>e.at.startsWith(d)&&(e.action==='login'||e.action==='view')).map(e=>e.actor)).size):[];
  const failedLogins=portal?.filter(e=>e.action==='login_failed').length??0;
  return <div className="page"><header className="page-head"><div><h1>통합 대시보드</h1><p>{snapshot.mode==='mock'?'예시 데이터입니다. 자원, 사용률, 비용, IAM, 기록 모두 실제 값이 아닙니다.':`수집 시각 ${new Date(snapshot.collectedAt).toLocaleString('ko-KR')}`}</p></div>
      <div className="page-actions"><ul className="conn-chips" aria-label="클라우드 연결">{snapshot.connections.filter(c=>c.provider!=='onprem').map(c=><li key={c.provider} className={`conn-${c.status}`}><ProviderMark provider={c.provider}/>{PROVIDER_LABEL[c.provider]}<small>{({demo:'예시',collected:'수집됨',partial:'일부',missing:'미연결',failed:'실패',unauthenticated:'로그인 필요',running:'수집 중'} as Record<string,string>)[c.status]}</small></li>)}</ul><button className="button primary" onClick={()=>go('map')}><Network size={15}/>토폴로지 보기</button></div></header>
    <section className="kpi-row" aria-label="주요 지표">
      <Kpi label="리소스" value={real.length.toLocaleString('ko-KR')} hint={warnCount?`이상 ${warnCount}개`:`범위 ${new Set(resources.map(r=>r.scope)).size}개`} tone={warnCount?'bad':undefined} onClick={()=>go('inventory')}/>
      <Kpi label="VM" value={String(fleet.count)} hint={`실행 ${fleet.running} · vCPU ${fleet.vcpu} · ${gib(fleet.memoryGiB)}`} onClick={()=>go('inventory')}/>
      <Kpi label={cost.projected!==null?'이번 달 예상 비용':'최근 월 비용'} value={fmt(headline)} hint={delta===null?'지난달 데이터 없음':`지난달 대비 ${delta>0?'+':''}${Math.round(delta*100)}%`} onClick={()=>go('cost')}/>
      <Kpi label="조치 필요" value={String(urgent)} hint={`전체 ${list.length}건 · 긴급·높음`} tone={urgent?'bad':undefined} onClick={()=>go('findings')}/>
      <Kpi label="공인 노출 후보" value={String(exposed.length)} hint={`넓은 인바운드 ${wide}개`} tone={exposed.length?'warn':undefined} onClick={()=>go('security')}/>
      <Kpi label="특권 주체" value={String(privileged)} hint={`외부 ${external} · 전체 ${principals.size}`} tone={external?'warn':undefined} onClick={()=>go('iam')}/>
      <Kpi label="클라우드 변경" value={String(activity.length)} hint={`최근 7일 · 삭제 ${activity.filter(a=>a.kind==='delete').length}`} onClick={()=>go('audit')}/>
    </section>
    <div className="dash-grid">
      <Card title="클라우드별 리소스" sub="분류별" to="inventory" go={go} className="span-2"><Columns xKey="cloud" height={190} data={byCloud} series={CATEGORIES.map(c=>({key:c.id,label:c.label,color:CATEGORY_COLOR[c.id]}))}/></Card>
      <Card title="리소스 상태" to="inventory" go={go}><Donut data={HEALTH.map(h=>({key:h.key,label:h.label,value:real.filter(r=>health(r.status)===h.key).length,color:h.color}))} unit="자원" onPick={()=>go('inventory')}/></Card>
      <Card title="월별 비용" sub={currency==='KRW'?'원화':'달러'} to="cost" go={go} className="span-2"><CostTrend summary={cost} compact/></Card>
      <Card title="클라우드별 비용" sub={cost.projected!==null?'이번 달 예상':'최근 월'} to="cost" go={go}><Donut data={Object.entries(cost.providerTotals).map(([p,t])=>({key:p,label:PROVIDER_LABEL[p]??p,value:t.projected??t.current,color:PROVIDER_COLOR[p]}))} format={fmt} center={money(headline,currency).replace(/\s/g,'')}/></Card>
      <Card title="우선 조치" sub={`${list.length}건`} to="findings" go={go} className="span-2"><FindingList items={list} onOpen={openFinding} limit={6}/></Card>
      <Card title="조치 심각도" to="findings" go={go}><Donut data={(Object.keys(SEVERITY) as Severity[]).map(s=>({key:s,label:SEVERITY[s],value:list.filter(f=>f.severity===s).length,color:SEVERITY_COLOR[s]}))} unit="항목" onPick={()=>go('findings')}/></Card>
      <Card title="보안" sub="노출과 권한" to="security" go={go}><div className="viz-stack">
        <Stat icon={ShieldAlert} label="공인 노출 후보" value={exposed.length} tone={exposed.length?'warn':undefined}/>
        <p className="muted small">인바운드 규칙 출발지</p><ShareBar parts={[{key:'wide',label:'전체 인터넷',value:wide,color:'var(--warn)'},{key:'narrow',label:'제한됨',value:rules.filter(({rule})=>/in/i.test(rule.direction)).length-wide,color:'var(--path)'}]}/>
        <p className="muted small">IAM 주체</p><ShareBar parts={[{key:'priv',label:'특권',value:privileged,color:'var(--warn)'},{key:'rest',label:'일반',value:principals.size-privileged,color:'var(--accent)'}]}/>
        <Stat icon={KeyRound} label="외부 주체" value={external} tone={external?'warn':undefined}/></div></Card>
      <Card title="네트워크" sub="연결 구성" to="network" go={go}><div className="viz-stack">
        <Stat icon={Network} label="네트워크" value={networks.length} hint={`서브넷 ${resources.filter(r=>r.kind==='subnet').length}`}/>
        <Stat icon={Network} label="피어링" value={peerings.length}/>
        <p className="muted small">사내망 연결 {hybrid.length}개</p><ShareBar parts={[{key:'ok',label:'정상',value:hybrid.filter(h=>health(h.target.status)==='ok'||health(h.target.status)==='neutral').length,color:'var(--path)'},{key:'warn',label:'이상',value:hybrid.filter(h=>health(h.target.status)==='warn').length,color:'var(--warn)'},{key:'off',label:'중지',value:hybrid.filter(h=>health(h.target.status)==='stopped').length,color:'var(--faint)'}]}/>
        <Stat icon={Network} label="주소 대역 중복" value={overlaps.length} tone={overlaps.length?'warn':undefined}/></div></Card>
      <Card title="VM 용량" sub="실행 중 기준" to="inventory" go={go}><table className="data-table compact-table"><thead><tr><th>클라우드</th><th className="num">VM</th><th className="num">vCPU</th><th className="num">메모리</th><th className="num">GPU</th></tr></thead><tbody>{present.map(p=>{const t=fleetTotals(vms.filter(v=>v.provider===p));return <tr key={p}><td><span className="cell-mark"><i style={{background:PROVIDER_COLOR[p]}}/>{PROVIDER_LABEL[p]}</span></td><td className="num">{t.running}/{t.count}</td><td className="num">{t.vcpu}</td><td className="num">{gib(t.memoryGiB)}</td><td className="num">{t.gpus}</td></tr>;})}</tbody></table>
        {vms.some(v=>v.metrics)&&<><p className="muted small viz-gap">평균 사용률 {snapshot.mode==='mock'?'(예시)':''}</p><ShareBar format={v=>`${v}%`} parts={[{key:'cpu',label:'CPU',value:Math.round(vms.filter(v=>v.metrics).reduce((n,v)=>n+v.metrics!.cpu,0)/vms.filter(v=>v.metrics).length),color:'var(--accent)'},{key:'mem',label:'메모리',value:Math.round(vms.filter(v=>v.metrics).reduce((n,v)=>n+v.metrics!.memory,0)/vms.filter(v=>v.metrics).length),color:'var(--path)'}]}/></>}</Card>
      <Card title="클라우드 변경 기록" sub="최근 7일 · 누가 무엇을 바꿨나" to="audit" go={go} className="span-2">{activity.length?<Columns data={dailyActivity} height={170} series={present.map(p=>({key:p,label:PROVIDER_LABEL[p],color:PROVIDER_COLOR[p]}))}/>:<p className="muted small">아직 수집한 변경 기록이 없습니다.</p>}</Card>
      {portal?<Card title="포털 접근" sub="최근 7일" to="audit" go={go}><div className="viz-stack"><Stat icon={Users} label="접속한 사람" value={new Set(portal.filter(e=>e.action==='login'||e.action==='view').map(e=>e.actor)).size}/><p className="muted small">일별 접속자</p><Spark values={logins} height={48}/><Stat icon={ShieldAlert} label="로그인 실패·거부" value={failedLogins+(portal.filter(e=>e.action==='denied').length)} tone={failedLogins?'warn':undefined}/></div></Card>
        :<Card title="최근 변경" sub="수집 회차 비교" to="changes" go={go}><ChangeList changes={changes}/></Card>}
      {portal&&<Card title="최근 변경" sub="수집 회차 비교" to="changes" go={go} className="span-3"><ChangeList changes={changes}/></Card>}
    </div></div>;
}
function Stat({icon:Icon,label,value,hint,tone}:{icon:typeof Boxes;label:string;value:number;hint?:string;tone?:'warn'}){
  return <div className={`stat-line ${tone?'is-warn':''}`}><Icon size={15}/><span>{label}{hint&&<small>{hint}</small>}</span><strong>{value.toLocaleString('ko-KR')}</strong></div>;
}
function ChangeList({changes}:{changes:NonNullable<Snapshot['changes']>['items']}){
  return changes.length?<ul className="change-rows">{changes.slice(0,6).map(c=>{const Icon=changeIcon[c.kind];return <li key={c.id+c.kind} className={`change-${c.kind}`}><Icon size={14}/><span>{c.name}<small>{c.detail}</small></span></li>})}</ul>:<p className="muted small">직전 수집과 비교한 변경이 없습니다.</p>;
}
