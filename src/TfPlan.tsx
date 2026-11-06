import {useRef,useState} from 'react';
import {ArrowUpRight,FileJson,Info,X} from 'lucide-react';
import type {Snapshot} from '../shared/schema';
import {planImpact,type PlanAction,type PlanReport} from '../shared/tfplan';
import {ProviderMark} from './graph';
import {Kpi} from './charts';
const ACTION:Record<PlanAction,{label:string;tone:string}>={delete:{label:'삭제',tone:'removed'},replace:{label:'교체',tone:'removed'},update:{label:'변경',tone:'changed'},create:{label:'생성',tone:'added'}};
const HOW={id:'ID 일치',parent:'상위 자원',reference:'참조'};
const MAX_BYTES=50*1024*1024;
// For the demo only: a plan written against the sample estate, so the panel can be tried without a Terraform workspace.
function samplePlan(s:Snapshot){
  const nsg=s.resources.find(r=>r.provider==='azure'&&r.kind==='firewall'&&s.links.some(l=>l.kind==='policy'&&l.source===r.id)),gw=s.resources.find(r=>r.provider==='azure'&&r.kind==='gateway'),sg=s.resources.find(r=>r.provider==='aws'&&r.kind==='firewall');
  const rc=(address:string,actions:string[],before:object|null,after:object|null)=>({address,mode:'managed',type:address.split('.')[0],change:{actions,before,after}});
  return JSON.stringify({format_version:'1.2',terraform_version:'1.9.5',resource_changes:[
    ...(nsg?[rc('azurerm_network_security_rule.allow_ssh',['update'],{id:`${nsg.nativeId}/securityRules/AllowSSH`,destination_port_range:'443'},{id:`${nsg.nativeId}/securityRules/AllowSSH`,destination_port_range:'22'})]:[]),
    ...(gw?[rc('azurerm_virtual_network_gateway.hub',['delete'],{id:gw.nativeId},null)]:[]),
    ...(sg?[rc('aws_security_group_rule.https',['create'],null,{security_group_id:sg.nativeId.split('/').pop(),from_port:443,to_port:443,cidr_blocks:['0.0.0.0/0']})]:[]),
    rc('aws_route.default',['create'],null,{route_table_id:'rtb-0example',destination_cidr_block:'0.0.0.0/0'}),
  ]});
}
// A Terraform plan, read in this browser only, laid against the last collection: what each change touches and what sits behind it.
export function TfPlanPanel({snapshot,openResource}:{snapshot:Snapshot;openResource:(id:string)=>void}){
  const [report,setReport]=useState<PlanReport|null>(null),[name,setName]=useState(''),[error,setError]=useState(''),input=useRef<HTMLInputElement>(null);
  const run=(text:string,label:string)=>{try{setReport(planImpact(snapshot,text));setName(label);setError('');}catch(e){setReport(null);setError(e instanceof Error?e.message:'plan을 읽지 못했습니다.');}};
  const pick=async(file?:File)=>{if(!file)return;if(file.size>MAX_BYTES){setError('50MB보다 큰 plan은 읽지 않습니다.');return;}run(await file.text(),file.name);if(input.current)input.current.value='';};
  const affected=report?new Set(report.changes.flatMap(c=>c.candidates.map(x=>x.resource.id))).size:0,matched=report?.changes.filter(c=>c.subjects.length).length??0;
  return <section className="panel tfplan" aria-label="Terraform plan 영향 후보"><header className="panel-head wrap"><h2>Terraform plan 영향 후보{name&&<small>{name}</small>}</h2><div className="table-tools">
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={e=>pick(e.target.files?.[0])}/>
      {snapshot.mode==='mock'&&<button className="button" onClick={()=>run(samplePlan(snapshot),'예시 plan')}>예시 plan으로 보기</button>}
      <button className="button primary" onClick={()=>input.current?.click()}><FileJson size={14}/>plan JSON 열기</button>
      {report&&<button className="icon-button" onClick={()=>{setReport(null);setName('');}} aria-label="결과 지우기"><X size={14}/></button>}</div></header>
    <div className="notice"><Info size={15}/><p><code>terraform show -json plan.tfplan</code> 출력을 여세요. plan에는 비밀 값이 평문으로 있을 수 있어 <b>이 브라우저에서만 읽고 서버로 보내거나 저장하지 않습니다.</b> 결과는 마지막 수집의 구성과 대조한 <b>후보</b>이며, 실제로 통신이 끊기는지는 판정하지 않습니다. 볼 수 있는 범위의 자원과만 대조합니다.</p></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {report&&<>
      <section className="kpi-row" aria-label="plan 요약"><Kpi label="변경" value={String(report.changes.length)} hint={report.ignored?`조회·변경 없음 ${report.ignored}건 제외`:undefined}/><Kpi label="수집 자원과 대조됨" value={String(matched)} hint={`못 찾음 ${report.changes.length-matched}`} tone={report.changes.length-matched?'warn':undefined}/><Kpi label="영향 후보 자원" value={String(affected)} hint="중복 제외"/><Kpi label="삭제·교체" value={String(report.changes.filter(c=>c.action==='delete'||c.action==='replace').length)} tone={report.changes.some(c=>c.action==='delete'||c.action==='replace')?'bad':undefined}/></section>
      {report.changes.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>동작</th><th>Terraform 주소</th><th>대상 자원</th><th>영향 후보</th></tr></thead><tbody>{report.changes.map(c=><tr key={c.address}>
        <td><span className={`change-kind change-${ACTION[c.action].tone}`}>{ACTION[c.action].label}</span></td>
        <td className="mono">{c.address}</td>
        <td>{c.subjects.length?c.subjects.map(x=><button key={x.resource.id} className="table-link" onClick={()=>openResource(x.resource.id)} title={HOW[x.how]}><ProviderMark provider={x.resource.provider}/>{x.resource.name}<ArrowUpRight size={12}/></button>):<span className="muted small">{c.note}</span>}</td>
        <td>{c.candidates.length?<details><summary>{c.candidates.length}개{c.candidates.length>=200?' 이상':''}</summary><ul className="plan-candidates">{c.candidates.slice(0,30).map(x=><li key={x.resource.id}><button className="table-link" onClick={()=>openResource(x.resource.id)}>{x.resource.name}</button><small>{x.why}</small></li>)}{c.candidates.length>30&&<li className="muted small">외 {c.candidates.length-30}개</li>}</ul></details>:<span className="muted small">—</span>}</td>
      </tr>)}</tbody></table></div>:<p className="muted small empty-note">이 plan에는 바뀌는 자원이 없습니다.</p>}
    </>}
  </section>;
}
