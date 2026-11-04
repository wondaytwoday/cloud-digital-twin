import {useRef} from 'react';
import {ChevronDown,FolderTree,Layers3,X} from 'lucide-react';
import type {Snapshot} from '../shared/schema';
import type {Focus,ScopeIndex} from '../shared/hierarchy';
import {ProviderFilter} from './charts';
import {ProviderMark} from './graph';
import {ScopeTree} from './ScopeTree';
const NAMES:Record<string,string>={azure:'Azure',aws:'AWS',gcp:'Google Cloud'};
const ORDER=['azure','aws','gcp'] as const;
type Panel={snapshot:Snapshot;index:ScopeIndex;active:string;allLabel:string;action?:string;onPick:(tab:string)=>void};
export function ScopePanel({snapshot,index,active,allLabel,action,onPick}:Panel){
  return <><button className={`side-provider ${active==='all'?'is-active':''}`} onClick={()=>onPick('all')}><Layers3 size={16}/>{allLabel}<b>{snapshot.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external').length}</b></button>{ORDER.filter(p=>index.roots[p].length).map(p=><div className="side-group" key={p}><button className={`side-provider ${active===`provider:${p}`?'is-active':''}`} onClick={()=>onPick(`provider:${p}`)}><ProviderMark provider={p}/>{NAMES[p]}<b>{snapshot.resources.filter(r=>r.provider===p&&r.scope!=='external').length}</b></button><ScopeTree compact index={index} nodes={index.roots[p]} activeId={active} action={action} onOpen={onPick}/></div>)}</>;
}
// The same selection as the map's tabs, so a scope chosen on any page follows you to every other page.
export function ScopeBar({snapshot,index,active,focus,label,onPick,onHome}:{snapshot:Snapshot;index:ScopeIndex;active:string;focus:Focus;label:string;onPick:(tab:string)=>void;onHome:()=>void}){
  const pop=useRef<HTMLDetailsElement>(null),present=ORDER.filter(p=>snapshot.resources.some(r=>r.provider===p));
  const pick=(tab:string)=>{pop.current?.removeAttribute('open');onPick(tab);};
  return <div className="scope-bar" role="region" aria-label="공통 범위 필터"><ProviderFilter value={focus.provider} present={present} onChange={v=>pick(v==='all'?'all':`provider:${v}`)}/>
    <details ref={pop} className="menu-pop scope-picker"><summary className="button" aria-label={`관리 범위 선택, 현재 ${label}`}><FolderTree size={14}/><span>{label}</span><ChevronDown size={14}/></summary><div className="scope-pop"><ScopePanel snapshot={snapshot} index={index} active={active} allLabel="전체 범위" action="범위로 좁히기" onPick={pick}/></div></details>
    {active!=='all'&&<button className="link-button small" onClick={()=>pick('all')}><X size={13}/>필터 해제</button>}
    <button className="link-button small scope-home" onClick={onHome}>관리 범위 전체 보기</button></div>;
}
