import {useState} from 'react';
import {AlertTriangle,Building2,ChevronDown,ChevronRight,CircleOff,FolderClosed} from 'lucide-react';
import type {HierarchyNode} from '../shared/schema';
import {hierarchyIcon} from '../shared/iconKeys';
import {hierarchyNouns,type ScopeIndex} from '../shared/hierarchy';
import {iconUrl} from './icons';
export function ScopeIcon({node,size=18}:{node:HierarchyNode;size?:number}){
  const url=iconUrl(node.kind==='organization'&&node.provider==='aws'?'aws/organizations':hierarchyIcon[node.kind]);
  if(url)return <img className="csp-icon" src={url} width={size} height={size} alt="" aria-hidden="true" draggable={false}/>;
  const Glyph=node.kind==='folder'?FolderClosed:Building2;return <Glyph className="scope-glyph" size={size} aria-hidden="true"/>;
}
type Props={index:ScopeIndex;nodes:HierarchyNode[];activeId?:string;compact?:boolean;action?:string;onOpen:(id:string)=>void};
export function ScopeTree({index,nodes,activeId,compact,action='토폴로지 열기',onOpen}:Props){
  const [collapsed,setCollapsed]=useState<Set<string>>(new Set());
  const toggle=(id:string)=>setCollapsed(cur=>{const next=new Set(cur);next.has(id)?next.delete(id):next.add(id);return next;});
  const row=(n:HierarchyNode,depth:number)=>{
    const kids=index.children.get(n.id)??[],open=!collapsed.has(n.id),s=index.stats.get(n.id),empty=!s?.resources;
    return <li key={n.id}>
      <div className={`scope-row ${n.scope?'is-leaf':'is-group'} ${activeId===n.id?'is-active':''} ${empty?'is-empty':''}`} style={{paddingLeft:6+depth*(compact?12:18)}}>
        {kids.length?<button className="scope-chevron" aria-expanded={open} aria-label={`${n.name} ${open?'접기':'펼치기'}`} onClick={()=>toggle(n.id)}>{open?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>:<span className="scope-chevron-space"/>}
        <button className="scope-open" onClick={()=>onOpen(n.id)} aria-current={activeId===n.id?'page':undefined} title={`${hierarchyNouns[n.kind]} ${n.name}${n.scope&&n.scope!==n.name?` (${n.scope})`:''} ${action}`}>
          <ScopeIcon node={n} size={compact?16:20}/>
          <span className="scope-name"><strong>{n.name}</strong>{!compact&&<small>{hierarchyNouns[n.kind]}</small>}</span>
          <span className="scope-meta">
            {!!s?.warn&&<span className="meta-warn" title={`이상 ${s.warn}`}><AlertTriangle size={12}/>{s.warn}</span>}
            {!compact&&!!s?.stopped&&<span className="meta-stopped" title={`중지 ${s.stopped}`}><CircleOff size={12}/>{s.stopped}</span>}
            {empty?<em>미수집</em>:<b title={`자원 ${s?.resources}`}>{s?.resources}</b>}
          </span>
        </button>
      </div>
      {!!kids.length&&open&&<ul>{kids.map(c=>row(c,depth+1))}</ul>}
    </li>;
  };
  return <ul className={`scope-tree ${compact?'compact':''}`}>{nodes.map(n=>row(n,0))}</ul>;
}
