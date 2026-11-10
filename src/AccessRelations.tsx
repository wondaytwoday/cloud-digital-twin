import {useMemo,useState} from 'react';
import type {Snapshot} from '../shared/schema';
import {iamInScope,inScope,type Focus} from '../shared/hierarchy';
import {isWideInbound} from '../shared/topology';

// These are configured references and role assignments, never observed traffic or effective grants.
export function AccessRelations({snapshot,focus,selected,onSelect}:{snapshot:Snapshot;focus:Focus;selected:string|null;onSelect:(id:string)=>void}){
  const [page,setPage]=useState(0);
  const byId=useMemo(()=>new Map(snapshot.resources.map(r=>[r.id,r])),[snapshot]);
  const rows=useMemo(()=>{
    const rows:{id:string;from:string;to:string;label:string;details:string;target?:string;risk:boolean}[]=[];
    const ancestors=new Set<string>();for(let r=selected?byId.get(selected):undefined;r;r=r.parent?byId.get(r.parent):undefined)ancestors.add(r.id);
    for(const link of snapshot.links){
      if(!['policy','reference'].includes(link.kind))continue;
      const from=byId.get(link.source),to=byId.get(link.target);
      if(!to||!inScope(focus,to.provider,to.scope)||selected&&!ancestors.has(link.target)&&link.source!==selected)continue;
      rows.push({id:link.id,from:from?.name??link.source,to:to.name,label:link.kind==='policy'?'정책 적용':'구성 참조',target:to.id,risk:!!from?.rules.some(isWideInbound),details:`${link.evidence}\n${(from?.rules??[]).map(r=>`${r.action} ${r.direction} ${r.protocol}/${r.ports}: ${r.source} → ${r.destination}`).join('\n')}`});
    }
    for(const assignment of snapshot.iam){
      if(!iamInScope(focus,assignment))continue;
      if(selected&&(assignment.targetResource?assignment.targetResource!==selected:assignment.scope!==byId.get(selected)?.scope))continue;
      rows.push({id:assignment.id,from:assignment.principal,to:assignment.targetResource?byId.get(assignment.targetResource)?.name??'미수집 대상 자원':assignment.scopeName??snapshot.scopeLabels[assignment.scope]??assignment.scope,label:`역할 할당 · ${assignment.role}`,target:assignment.targetResource&&byId.has(assignment.targetResource)?assignment.targetResource:undefined,risk:assignment.privileged||assignment.external,details:`${assignment.source}\n대상: ${assignment.targetResource??assignment.scopeName??assignment.scope}\n역할: ${assignment.role}\n조건·상속·거부 정책을 반영한 실효 권한이 아닙니다.`});
    }
    return rows;
  },[snapshot,focus,selected,byId]);
  const last=Math.max(0,Math.ceil(rows.length/100)-1),current=Math.min(page,last);
  return <section className="access-relations" aria-label="접근 관계도"><header><h2>접근·구성 관계 {rows.length}개</h2><p>정책 적용, 구성 참조, 역할 할당 근거입니다. 실제 통신·도달 가능 여부·실효 권한을 뜻하지 않습니다.</p>{selected&&<button className="button" onClick={()=>onSelect('')}>범위 전체 관계 보기</button>}</header>
    {!rows.length&&<p>이 범위에서 수집된 접근·구성 관계가 없습니다. 관계를 추정해 추가하지 않습니다.</p>}
    <div className="access-rows">{rows.slice(current*100,(current+1)*100).map(r=><details key={r.id} className="access-row"><summary><span>{r.from}</span><span className={r.risk?'access-evidence is-risk':'access-evidence'}>{r.label} → · 근거 보기{r.risk?' · 검토 필요':''}</span><span>{r.to}</span></summary><pre>{r.details}</pre>{r.target&&<button className="link-button" onClick={()=>onSelect(r.target!)}>대상 자원 선택</button>}</details>)}</div>
    {last>0&&<div className="page-actions"><button className="button" disabled={!current} onClick={()=>setPage(n=>Math.max(0,n-1))}>이전 관계</button><span>{current+1} / {last+1}</span><button className="button" disabled={current>=last} onClick={()=>setPage(n=>n+1)}>다음 관계</button></div>}
  </section>;
}
