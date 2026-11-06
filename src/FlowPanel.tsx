import {useMemo} from 'react';
import {AlertTriangle,ArrowUpRight,CircleCheck,CircleHelp,CircleX,Info,ShieldCheck,X} from 'lucide-react';
import type {Resource,Snapshot} from '../shared/schema';
import type {FlowResult,Protocol,Verdict} from '../shared/flow';
import {identityEvidence} from '../shared/relations';
import {ResourcePicker,type Picking} from './Detail';
import {kindNames} from './graph';
export type FlowState={from:string;to:string;protocol:Protocol;port?:number};
// The verdict is spelled out and carries its own icon, so it never depends on colour.
export const VERDICT:Record<Verdict,{label:string;icon:typeof CircleCheck;tone:string}>={allowed:{label:'구성상 허용',icon:CircleCheck,tone:'ok'},blocked:{label:'구성상 차단',icon:CircleX,tone:'bad'},unknown:{label:'판단 불가',icon:CircleHelp,tone:'warn'}};
const POLICY_VERDICT={allow:'허용',deny:'차단',unknown:'판단 불가'};
const HOP_LABEL:Record<string,string>={source:'출발',nic:'NIC',subnet:'서브넷',route:'경로 선택',appliance:'경유 장비',peering:'피어링',gateway:'게이트웨이',endpoint:'엔드포인트',service:'서비스',destination:'도착',internet:'인터넷',onprem:'사내망',loadbalancer:'로드밸런서'};
export function FlowPanel({snapshot,state,result,picking,activeHop,onPick,onChange,onSelect,onClose}:{snapshot:Snapshot;state:FlowState;result:FlowResult;picking:Picking;activeHop:string|null;onPick:(p:Picking)=>void;onChange:(next:FlowState)=>void;onSelect:(id:string)=>void;onClose:()=>void}){
  const options=useMemo(()=>snapshot.resources.filter(r=>!['firewall','subnet','external','identity','disk','serviceaccount','namespace'].includes(r.kind)&&r.scope!=='external').sort((a,b)=>a.name.localeCompare(b.name)),[snapshot]);
  const v=VERDICT[result.status],Icon=v.icon,source=snapshot.resources.find(r=>r.id===state.from),target=result.to.service??result.to.resource;
  const identities=source?identityEvidence(snapshot,source,target):[];
  const when=(iso?:string)=>iso?new Date(iso).toLocaleString('ko-KR'):'미수집';
  return <aside className="inspector flow-panel" aria-label="두 자원 사이 분석"><div className="inspector-head"><span>경로·정책 분석</span><button className="icon-button" onClick={onClose} aria-label="분석 닫기"><X size={16}/></button></div><div className="inspector-body">
    <ResourcePicker label="출발" value={state.from} options={options} onChange={id=>onChange({...state,from:id})} picking={picking==='from'} onPick={()=>onPick(picking==='from'?null:'from')}/>
    <ResourcePicker label="목적지" value={state.to} options={options} onChange={id=>onChange({...state,to:id})} picking={picking==='to'} onPick={()=>onPick(picking==='to'?null:'to')}/>
    <div className="flow-query"><label>프로토콜<select value={state.protocol} onChange={e=>onChange({...state,protocol:e.target.value as Protocol})}>{(['tcp','udp','icmp','any'] as const).map(p=><option key={p} value={p}>{p.toUpperCase()}</option>)}</select></label>
      <label>목적지 포트<input type="number" min={1} max={65535} value={state.port??''} disabled={state.protocol==='icmp'} onChange={e=>onChange({...state,port:e.target.value?Number(e.target.value):undefined})}/></label></div>
    {picking&&<p className="pick-hint" role="status">지도에서 {picking==='from'?'출발':'목적지'} 자원을 누르세요.</p>}
    <div className={`verdict verdict-${v.tone}`} role="status"><Icon size={18}/><div><strong>{v.label}{result.completeness==='partial'&&result.status==='allowed'?' · 부분 평가':''}</strong><p>{result.summary}</p></div></div>
    <p className="small muted">관측 통신: 미연동 (흐름 로그를 연결하지 않아 실제 통신 여부는 표시하지 않습니다)</p>
    <h3>구성상 후보 경로 <span className="count">{result.path.length}</span></h3>
    <ol className="hops flow-hops">{result.path.map((h,i)=><li key={i} className={`hop-${h.kind}`}><button disabled={!h.id} className={activeHop===h.id?'is-active':''} aria-current={activeHop===h.id?'step':undefined} onClick={()=>h.id&&onSelect(h.id)}><span className="hop-tag">{HOP_LABEL[h.kind]??h.kind}</span><span>{h.label}<small>{h.evidence}</small>{h.basis==='inferred'&&<small className="basis">Atlas 추론</small>}{h.basis==='declared'&&<small className="basis">수동 등록</small>}</span></button></li>)}</ol>
    <h3><ShieldCheck size={14}/>평가한 정책 <span className="count">{result.policies.length}</span></h3>
    {result.policies.length?result.policies.map((p,i)=><div className={`rule-card policy-${p.verdict}`} key={i}><div className="rule-top"><span className={`badge ${p.verdict==='deny'?'red':p.verdict==='unknown'?'amber':''}`}>{POLICY_VERDICT[p.verdict]}</span><b>{p.policy?<button className="table-link" onClick={()=>onSelect(p.policy!)}>{p.name}<ArrowUpRight size={12}/></button>:p.name}</b></div>
      <small className="muted">{p.at} · {p.direction==='inbound'?'인바운드':p.direction==='outbound'?'아웃바운드':'경유'}</small>
      {p.rule&&<p className="small mono">{p.rule.name} · 우선순위 {p.rule.priority??'-'} · {p.rule.action} · {p.rule.protocol} {p.rule.ports} · {p.rule.source} → {p.rule.destination}</p>}
      <p className="small">{p.reason}</p></div>):<p className="muted small">이 경로에 적용된 정책을 찾지 못했습니다. 정책이 없다는 뜻인지, 볼 수 없는 범위에 있는지 구분하지 않습니다.</p>}
    <h3>응답 경로</h3><p className={`small ${result.returnPath.status==='unknown'?'warn-text':''}`}>{VERDICT[result.returnPath.status].label}: {result.returnPath.notes.join(' ')}</p>
    {(result.gaps.length>0||result.conditions.length>0)&&<><h3><AlertTriangle size={14}/>확인하지 않은 것</h3><ul className="flow-gaps">{result.gaps.map((g,i)=><li key={`g${i}`} className={g.undecided?'decisive':''}>{g.undecided?'판정을 막음: ':'범위 밖: '}{g.text}</li>)}{result.conditions.map((c,i)=><li key={`c${i}`}>조건: {c}</li>)}</ul></>}
    {identities.length>0&&<><h3>실행 신원·권한 근거</h3>{identities.map(e=><div className="rule-card" key={e.identity.id}><div className="rule-top"><b><button className="table-link" onClick={()=>onSelect(e.identity.id)}>{e.identity.name}<ArrowUpRight size={12}/></button></b><small className="muted">{e.via}</small></div>
      {target&&<p className="small">{target.name}에 대한 역할 할당: {e.onTarget.length?e.onTarget.map(a=>a.role).join(', '):'찾지 못함'}</p>}
      <p className="small muted">이 신원의 역할 할당 {e.assignments.length}개{e.assignments.length?`: ${e.assignments.slice(0,4).map(a=>a.role).join(', ')}${e.assignments.length>4?' 외':''}`:''}</p>
      <p className="small muted">평가하지 않은 항목: {e.unevaluated.join(', ')}</p></div>)}<p className="small muted">역할 할당은 권한의 근거일 뿐이며, 요청한 작업이 허용되는지 판정한 결과가 아닙니다.</p></>}
    <div className="notice"><Info size={15}/><p>분석 {when(result.analyzedAt)} · 데이터 기준 {Object.entries(result.dataAt).map(([p,t])=>`${p} ${when(t)}`).join(', ')||'예시 데이터'}. 구성 데이터로 계산한 결과이며 실제 패킷 전달을 보장하지 않습니다.</p></div>
    {result.to.resource&&<p className="small muted">목적지 해석: {result.to.label} → {kindNames[result.to.resource.kind as Resource['kind']]} {result.to.ip??''}</p>}
  </div></aside>;
}
