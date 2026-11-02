import {useState,useEffect,useMemo,useRef,useCallback} from 'react';
import {ReactFlow,ReactFlowProvider,Background,MiniMap,useReactFlow,useNodesInitialized,useStore,Panel,BackgroundVariant,type NodeMouseHandler} from '@xyflow/react';
import {Waypoints,Search,Plug,ArrowUpRight,RefreshCw,Download,Pause,Play,Plus,Minus,Scan,ShieldCheck,Network,Info,X,Check,Route,FolderTree,Table2,AlertTriangle,CircleOff,ChevronRight,PanelLeft,PanelLeftClose,Layers3,ArrowUp,ArrowDown} from 'lucide-react';
import {validateSnapshot,type Snapshot,type Resource} from '../shared/schema';
import {connectors} from '../shared/connectors';
import {isScenario,scenarios,type ScenarioId} from '../shared/scenarios';
import {adjacency,ancestors,distances,findPath,health,impactOf,ingressIds} from '../shared/topology';
import {buildScopeIndex,hierarchyNouns,type ScopeIndex} from '../shared/hierarchy';
import {ResourceNode,FrameNode,SummaryNode,RoutedEdge,ProviderMark,ResourceIcon,kindNames,type Emphasis,type FlowNode,type FlowEdge} from './graph';
import {computeTopology,defaultExpanded,providerNames,regionId,startingLevel,type Bundle,type Topology} from './layout';
import {EdgeDetail,ImpactPanel,PathPanel,ResourceDetail} from './Detail';
import {ScopeHome} from './ScopeHome';
import {ScopeIcon,ScopeTree} from './ScopeTree';
type View='home'|'map'|'inventory';
const nodeTypes={resource:ResourceNode,frame:FrameNode,summary:SummaryNode},edgeTypes={routed:RoutedEdge};
const LEVELS=['개요','서브넷','전체'],ALL='all';
const FIT_PADDING={top:'24px',right:'24px',bottom:'64px',left:'24px'} as const;
const EMPTY:Topology={nodes:[],edges:[],rollup:()=>undefined};
const shortProvider:Record<string,string>={azure:'Azure',aws:'AWS',gcp:'Google Cloud'};
type Route={scenario:ScenarioId;view:View;tab:string};
const readRoute=():Route=>{const q=new URLSearchParams(location.search),s=q.get('scenario'),v=q.get('view');return{scenario:isScenario(s)?s:'standard',view:v==='map'||v==='inventory'?v:'home',tab:q.get('scope')??ALL};};
const routeUrl=({scenario,view,tab}:Route)=>{const q=new URLSearchParams({scenario});if(view!=='home')q.set('view',view);if(tab!==ALL)q.set('scope',tab);return `${location.pathname}?${q}`;};
const focusOf=(index:ScopeIndex|null,tab:string):{provider:string;scopes:Set<string>|null}=>{
  if(tab.startsWith('provider:'))return{provider:tab.slice(9),scopes:null};
  const node=index?.nodes.get(tab);return node?{provider:node.provider,scopes:new Set(index!.scopesUnder(tab))}:{provider:'all',scopes:null};
};
const tabLabel=(index:ScopeIndex|null,tab:string)=>tab===ALL?'전체 지도':tab.startsWith('provider:')?shortProvider[tab.slice(9)]:index?.nodes.get(tab)?.name??tab;
function ConnectorDialog({close}:{close:()=>void}){
  const ref=useRef<HTMLDialogElement>(null),[provider,setProvider]=useState('azure'),[copied,setCopied]=useState(false);
  useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close()},[]);
  const connector=connectors.find(c=>c.provider===provider)!;
  return <dialog ref={ref} className="connector-dialog" onCancel={close} onClick={e=>{if(e.target===e.currentTarget)close()}}><div className="dialog-header"><div><h2>클라우드 연결</h2><p>아직 로그인한 계정이 없어 API 모양의 목데이터를 같은 수집 코드로 보여줍니다. 아래 순서로 인증하면 실제 자원으로 바뀝니다.</p></div><button className="icon-button" onClick={close} aria-label="연결 안내 닫기"><X size={18}/></button></div><div className="connector-tabs">{connectors.map(c=><button key={c.provider} className={provider===c.provider?'active':''} onClick={()=>{setProvider(c.provider);setCopied(false)}}><ProviderMark provider={c.provider}/>{c.name}</button>)}</div><div className="connector-body"><div className="connector-title"><h3>{connector.api}</h3><span className="badge amber">실계정 검증 전</span></div><p className="muted">{connector.auth}</p><div className="endpoint">{connector.endpoint}</div><h4>1. 인증 후 수집</h4><div className="code-box"><pre>{connector.command}</pre><button className="icon-button" aria-label="수집 명령 복사" onClick={async()=>{try{await navigator.clipboard.writeText(connector.command);setCopied(true)}catch{setCopied(false)}}}>{copied?<Check size={15}/>:<Download size={15}/>}</button></div><h4>2. 실제 데이터 모드로 실행</h4><div className="code-box"><pre>DATA_MODE=live npm run dev</pre></div><div className="connector-columns"><section><h4>필요 권한</h4>{connector.permissions.map(p=><p key={p} className="permission-line"><Check size={13}/>{p}</p>)}</section><section><h4>수집 대상</h4><p>{connector.coverage}</p></section></div><div className="notice"><Info size={15}/><p>{connector.missing}</p></div><p className="small muted">인증 정보는 브라우저에 입력하거나 저장하지 않습니다. 수집 결과는 서버의 data/ 폴더에 저장되며, 실제 모드에는 시뮬레이션 트래픽이 나타나지 않습니다.</p><a className="text-link" href={connector.docs} target="_blank" rel="noreferrer">공식 API 문서 <ArrowUpRight size={14}/></a></div></dialog>;
}
type SortKey='name'|'provider'|'kind'|'scope'|'address'|'region'|'status';
function Inventory({snapshot,rows,onOpen}:{snapshot:Snapshot;rows:Resource[];onOpen:(r:Resource)=>void}){
  const [kind,setKind]=useState('all'),[state,setState]=useState('all'),[sort,setSort]=useState<{key:SortKey;dir:1|-1}>({key:'name',dir:1});
  const value=(r:Resource,key:SortKey)=>key==='scope'?snapshot.scopeLabels[r.scope]??r.scope:key==='address'?r.ip??r.cidr??'':key==='kind'?kindNames[r.kind]:r[key];
  const shown=rows.filter(r=>(kind==='all'||r.kind===kind)&&(state==='all'||health(r.status)===state)).sort((a,b)=>sort.dir*value(a,sort.key).localeCompare(value(b,sort.key),'ko',{numeric:true}));
  const kinds=[...new Set(rows.map(r=>r.kind))].sort();
  const head=(key:SortKey,label:string)=><th aria-sort={sort.key===key?(sort.dir===1?'ascending':'descending'):undefined}><button onClick={()=>setSort(s=>({key,dir:s.key===key?(s.dir===1?-1:1):1}))}>{label}{sort.key===key&&(sort.dir===1?<ArrowUp size={12}/>:<ArrowDown size={12}/>)}</button></th>;
  return <><div className="inventory-bar"><span><strong>{shown.length}</strong> / {rows.length}개</span><label>유형 <select value={kind} onChange={e=>setKind(e.target.value)}><option value="all">전체</option>{kinds.map(k=><option key={k} value={k}>{kindNames[k]}</option>)}</select></label><label>상태 <select value={state} onChange={e=>setState(e.target.value)}><option value="all">전체</option><option value="ok">정상</option><option value="warn">이상</option><option value="stopped">중지</option><option value="unknown">권한 없음</option></select></label></div>
    <div className="inventory"><table><thead><tr>{head('name','리소스')}{head('provider','클라우드')}{head('kind','유형')}{head('scope','소유 범위')}{head('address','주소')}{head('region','위치')}{head('status','상태')}</tr></thead><tbody>{shown.map(r=><tr key={r.id}><td><button onClick={()=>onOpen(r)}><ResourceIcon resource={r} size={20}/>{r.name}<ArrowUpRight size={12}/></button></td><td>{shortProvider[r.provider]??'사내망'}</td><td>{kindNames[r.kind]}</td><td>{snapshot.scopeLabels[r.scope]??r.scope}</td><td className="mono">{r.ip??r.cidr??'—'}</td><td>{r.region}</td><td><span className={`status h-${health(r.status)}`}><i/>{r.status}</span></td></tr>)}</tbody></table>{!shown.length&&<div className="load-state">조건에 맞는 자원이 없습니다.</div>}</div></>;
}
function Workspace(){
  const initial=useRef(readRoute()).current;
  const [scenario,setScenario]=useState<ScenarioId>(initial.scenario),[view,setView]=useState<View>(initial.view),[tabs,setTabs]=useState<string[]>(initial.tab===ALL?[ALL]:[ALL,initial.tab]),[active,setActive]=useState(initial.tab);
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[layingOut,setLayingOut]=useState(false);
  const [level,setLevel]=useState(0),[expanded,setExpanded]=useState<Set<string>>(new Set()),[policy,setPolicy]=useState(false),[flow,setFlow]=useState(true),[playing,setPlaying]=useState(true);
  const [selected,setSelected]=useState<string|null>(null),[edge,setEdge]=useState<Bundle|null>(null),[trace,setTrace]=useState<{from:string;to:string}|null>(null),[impact,setImpact]=useState<string|null>(null);
  const [query,setQuery]=useState(''),[dialog,setDialog]=useState(false),[toast,setToast]=useState(''),[topology,setTopology]=useState<Topology>(EMPTY),[fitTick,setFitTick]=useState(0),[sideOpen,setSideOpen]=useState(true);
  const farOut=useStore(s=>s.transform[2]<.5),rf=useReactFlow(),nodesReady=useNodesInitialized(),pendingFit=useRef<{ids?:string[]}|null>({}),searchRef=useRef<HTMLInputElement>(null);
  const tabViews=useRef(new Map<string,{expanded:Set<string>;level:number}>());
  const load=useCallback(async()=>{setLoading(true);setError('');try{const response=await fetch(`/api/topology?scenario=${scenario}`);if(!response.ok){const body=await response.json();throw new Error(body.error??'데이터 요청 실패')}const data=validateSnapshot(await response.json());setSnapshot(data);if(data.mode==='live')setFlow(false);}catch(e){setError(e instanceof Error?e.message:'데이터를 불러오지 못했습니다.')}finally{setLoading(false)}},[scenario]);
  useEffect(()=>{load()},[load]);
  useEffect(()=>{if(toast){const t=setTimeout(()=>setToast(''),2500);return()=>clearTimeout(t)}},[toast]);
  const index=useMemo(()=>snapshot?buildScopeIndex(snapshot.hierarchy,snapshot.resources):null,[snapshot]);
  const focus=useMemo(()=>focusOf(index,active),[index,active]);
  const byId=useMemo(()=>new Map(snapshot?.resources.map(r=>[r.id,r])),[snapshot]);
  const graph=useMemo(()=>snapshot?adjacency(snapshot.resources,snapshot.links):new Map<string,Set<string>>(),[snapshot]);
  const inFocus=useCallback((r:Resource,f=focus)=>(f.provider==='all'||r.provider===f.provider)&&(!f.scopes||f.scopes.has(r.scope)),[focus]);
  const applyLevel=useCallback((data:Snapshot,l:number)=>{setLevel(l);setExpanded(defaultExpanded(data,l));pendingFit.current={};setFitTick(t=>t+1);},[]);
  const clearModes=useCallback(()=>{setTrace(null);setImpact(null);setEdge(null);setSelected(null);},[]);
  // Each tab remembers what was expanded, so moving between scopes never loses your place.
  const showTab=useCallback((data:Snapshot,idx:ScopeIndex,tab:string,from?:string)=>{
    if(from!==undefined)tabViews.current.set(from,{expanded,level});
    setActive(tab);clearModes();
    const saved=tabViews.current.get(tab);
    if(saved){setExpanded(saved.expanded);setLevel(saved.level);pendingFit.current={};setFitTick(t=>t+1);return;}
    const f=focusOf(idx,tab),count=data.resources.filter(r=>inFocus(r,f)).length;applyLevel(data,startingLevel(count));
  },[expanded,level,clearModes,applyLevel,inFocus]);
  const seeded=useRef<string|undefined>(undefined);
  useEffect(()=>{
    if(!snapshot||!index)return;const key=snapshot.scenario??'live';if(seeded.current===key)return;seeded.current=key;tabViews.current.clear();
    const valid=(t:string)=>t===ALL||t.startsWith('provider:')||index.nodes.has(t),tab=valid(active)?active:ALL;
    if(tab===ALL)setTabs([ALL]);showTab(snapshot,index,tab);
  },[snapshot,index,active,showTab]);
  useEffect(()=>{
    if(!snapshot||!expanded.size||view!=='map')return;
    let stale=false;setLayingOut(true);
    computeTopology(snapshot,{provider:focus.provider,scopes:focus.scopes,policy,flow,expanded}).then(t=>{if(!stale){setTopology(t);setLayingOut(false);}}).catch(e=>{console.error(e);if(!stale){setError('토폴로지를 배치하지 못했습니다.');setLayingOut(false);}});
    return()=>{stale=true};
  },[snapshot,view,focus,policy,flow,expanded]);
  const go=useCallback((next:Partial<Route>,replace=false)=>{const route={scenario,view,tab:active,...next};history[replace?'replaceState':'pushState'](null,'',routeUrl(route));},[scenario,view,active]);
  const openTab=useCallback((tab:string)=>{
    if(!snapshot||!index)return;
    setTabs(cur=>cur.includes(tab)?cur:[...cur,tab]);showTab(snapshot,index,tab,tab===active?undefined:active);setView('map');go({view:'map',tab});
  },[snapshot,index,showTab,active,go]);
  const closeTab=(tab:string)=>{setTabs(cur=>cur.filter(t=>t!==tab));tabViews.current.delete(tab);if(tab===active&&snapshot&&index){const remaining=tabs.filter(t=>t!==tab),next=remaining[remaining.length-1]??ALL;showTab(snapshot,index,next);go({tab:next},true);}};
  const changeView=(v:View)=>{setView(v);if(v==='home')clearModes();pendingFit.current={};go({view:v});};
  useEffect(()=>{
    const onPop=()=>{const r=readRoute();setView(r.view);if(r.scenario!==scenario){setScenario(r.scenario);setTabs(r.tab===ALL?[ALL]:[ALL,r.tab]);setActive(r.tab);return;}
      if(r.tab!==active&&snapshot&&index){setTabs(cur=>cur.includes(r.tab)?cur:[...cur,r.tab]);showTab(snapshot,index,r.tab,active);}else pendingFit.current={};};
    addEventListener('popstate',onPop);return()=>removeEventListener('popstate',onPop);
  },[scenario,active,snapshot,index,showTab]);
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      const typing=/INPUT|SELECT|TEXTAREA/.test((e.target as HTMLElement).tagName);
      if(e.key==='/'&&!typing){e.preventDefault();searchRef.current?.focus();}
      if(e.key==='Escape'&&!typing&&!dialog)clearModes();
    };
    addEventListener('keydown',onKey);return()=>removeEventListener('keydown',onKey);
  },[dialog,clearModes]);
  const path=useMemo(()=>trace?findPath(graph,trace.from,[trace.to]):[],[graph,trace]);
  const impactResult=useMemo(()=>snapshot&&impact?impactOf(snapshot.resources,snapshot.links,impact):null,[snapshot,impact]);
  function toggle(id:string){setLevel(-1);setExpanded(cur=>{const next=new Set(cur);next.has(id)?next.delete(id):next.add(id);return next;});pendingFit.current={ids:[id]};}
  const stableToggle=useRef(toggle);stableToggle.current=toggle;
  const onToggle=useCallback((id:string)=>stableToggle.current(id),[]);
  // Separate from layout so highlighting never re-runs ELK or moves anything.
  const decorated=useMemo(()=>{
    const {rollup}=topology,emphasisOf=new Map<string,Emphasis>();let focusMode=false;
    const mark=(id:string|undefined,e:Emphasis)=>{if(id&&emphasisOf.get(id)!=='removed')emphasisOf.set(id,e);};
    const keepAncestors=(id:string|undefined)=>{for(const a of id?ancestors(byId,id):[])if(!emphasisOf.has(a))emphasisOf.set(a,'normal');};
    const edgeState=new Map<string,Emphasis>();
    if(trace&&path.length){focusMode=true;const seq=path.map(rollup).filter((x,i,a):x is string=>!!x&&x!==a[i-1]);seq.forEach(id=>{mark(id,'path');keepAncestors(id)});for(let i=0;i<seq.length-1;i++)edgeState.set([seq[i],seq[i+1]].sort().join('|'),'path');}
    else if(impactResult){focusMode=true;impactResult.lost.forEach(id=>{mark(rollup(id),'impact');keepAncestors(rollup(id))});impactResult.removed.forEach(id=>{mark(rollup(id),'removed');keepAncestors(rollup(id))});}
    else if(edge){focusMode=true;edgeState.set(edge.id,'focus');mark(edge.source,'focus');mark(edge.target,'focus');keepAncestors(edge.source);keepAncestors(edge.target);}
    else if(selected){const own=rollup(selected);if(own){focusMode=true;mark(own,'focus');keepAncestors(own);for(const b of topology.edges)if(b.source===own||b.target===own){edgeState.set(b.id,'focus');const other=b.source===own?b.target:b.source;mark(other,'focus');keepAncestors(other);}}}
    const placed=new Map(topology.nodes.map(n=>[n.id,n])),frameAncestors=new Set<string>();
    for(const id of emphasisOf.keys())for(let p=placed.get(id)?.item.parent;p;p=placed.get(p)?.item.parent)frameAncestors.add(p);
    const nodes:FlowNode[]=topology.nodes.map(n=>{
      const framed=!!n.item.variant&&!n.collapsed,emphasis=emphasisOf.get(n.id)??(focusMode&&!frameAncestors.has(n.id)?'dim':'normal');
      return{id:n.id,type:framed?'frame':n.item.variant?'summary':'resource',position:{x:n.x,y:n.y},width:n.width,height:n.height,measured:{width:n.width,height:n.height},zIndex:framed?n.depth:20,draggable:false,connectable:false,data:{...n,emphasis,onToggle,scopeLabel:n.item.resource&&n.item.variant==='network'?snapshot?.scopeLabels[n.item.resource.scope]??n.item.resource.scope:undefined}};
    });
    const edges:FlowEdge[]=topology.edges.map(b=>{
      const emphasis=edgeState.get(b.id)??(focusMode?'dim':'normal');
      return{id:b.id,source:b.source,target:b.target,type:'routed',zIndex:10,selected:edge?.id===b.id,data:{bundle:b,emphasis,animate:flow&&playing&&b.hasFlow&&emphasis!=='dim',showLabel:emphasis!=='dim'&&(b.kind==='hybrid'||b.kind==='peering'||b.links.filter(l=>l.kind!=='simulation').length>1||emphasis==='focus')}};
    });
    return{nodes,edges};
  },[topology,trace,path,impactResult,edge,selected,flow,playing,byId,snapshot,onToggle]);
  // Keyed on the layout, not highlighting: a fit waits for the layout it was requested for.
  useEffect(()=>{
    if(view!=='map'||!pendingFit.current||!topology.nodes.length||!nodesReady)return;
    const t=setTimeout(()=>{
      const ids=pendingFit.current?.ids?.filter(i=>topology.nodes.some(n=>n.id===i));pendingFit.current=null;
      if(ids?.length)rf.fitView({nodes:ids.map(id=>({id})),padding:FIT_PADDING,maxZoom:Math.max(rf.getZoom(),.9),duration:300});
      else rf.fitView({padding:FIT_PADDING,duration:300,maxZoom:1});
    },70);
    return()=>clearTimeout(t);
  },[topology,nodesReady,view,fitTick,rf]);
  const reveal=(ids:string[])=>{setLevel(-1);setExpanded(cur=>{const next=new Set(cur);for(const id of ids){const r=byId.get(id);if(r){next.add(`provider:${r.provider}`);next.add(regionId(r));}for(const a of ancestors(byId,id)){next.add(a);const up=byId.get(a);if(up)next.add(regionId(up));}}return next;});};
  const toAllTab=()=>{if(active!==ALL&&snapshot&&index){setTabs(cur=>cur.includes(ALL)?cur:[ALL,...cur]);tabViews.current.set(active,{expanded,level});setActive(ALL);}};
  const focusResource=(r:Resource)=>{setTrace(null);setImpact(null);setEdge(null);setSelected(r.id);setQuery('');if(view!=='map'){setView('map');go({view:'map'});}if(!inFocus(r)&&r.provider!=='onprem')toAllTab();reveal([r.id]);pendingFit.current={ids:[r.id]};};
  const selectById=(id:string)=>{const r=byId.get(id);if(r)focusResource(r);};
  const startTrace=(id:string)=>{if(!snapshot)return;const nearest=findPath(graph,id,ingressIds(snapshot.resources)),farthest=[...distances(graph,[id]).entries()].sort((a,b)=>b[1]-a[1])[0]?.[0],to=nearest[nearest.length-1]??farthest??id;setImpact(null);setEdge(null);setTrace({from:id,to});toAllTab();const hops=findPath(graph,id,[to]);reveal(hops);pendingFit.current={ids:hops};};
  const changeTrace=(from:string,to:string)=>{setTrace({from,to});const hops=findPath(graph,from,[to]);reveal(hops);pendingFit.current={ids:hops};};
  const startImpact=(id:string)=>{setTrace(null);setEdge(null);setImpact(id);toAllTab();pendingFit.current={};setFitTick(t=>t+1);};
  const onNodeClick:NodeMouseHandler<FlowNode>=(_,n)=>{const r=n.data.item.resource;if(r){setEdge(null);setImpact(null);setTrace(null);setSelected(r.id);}else if(n.data.item.variant)stableToggle.current(n.id);};
  const onNodeDoubleClick:NodeMouseHandler<FlowNode>=(_,n)=>{if(n.data.expandable&&n.data.item.resource)stableToggle.current(n.id);};
  const changeScenario=(id:ScenarioId)=>{setScenario(id);setTabs([ALL]);setActive(ALL);clearModes();setQuery('');setTopology(EMPTY);history.pushState(null,'',routeUrl({scenario:id,view,tab:ALL}));};
  const exportSnapshot=()=>{if(!snapshot)return;const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`cloud-atlas-${snapshot.scenario??snapshot.mode}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setToast('스냅샷을 내보냈습니다.')};
  const q=query.trim().toLowerCase();
  const matches=useMemo(()=>q&&snapshot?snapshot.resources.filter(r=>`${r.name} ${r.ip??''} ${r.cidr??''} ${r.type} ${snapshot.scopeLabels[r.scope]??''}`.toLowerCase().includes(q)):[],[snapshot,q]);
  const scopeMatches=useMemo(()=>q&&snapshot?snapshot.hierarchy.filter(n=>`${n.name} ${n.nativeId}`.toLowerCase().includes(q)).slice(0,5):[],[snapshot,q]);
  const inventoryRows=useMemo(()=>(q?matches:snapshot?.resources??[]).filter(r=>inFocus(r)),[matches,snapshot,q,inFocus]);
  const resource=selected?byId.get(selected):undefined;
  const edgeKinds=new Set(topology.edges.map(e=>e.kind)),hasFlows=!!snapshot?.links.some(l=>l.kind==='simulation'),live=snapshot?.mode==='live';
  const crumbs=index&&active!==ALL?(active.startsWith('provider:')?[{id:active,name:providerNames[active.slice(9)]}]:[{id:`provider:${index.nodes.get(active)?.provider}`,name:providerNames[index.nodes.get(active)?.provider??'']},...index.pathTo(active)]):[];
  const stats=useMemo(()=>{const real=snapshot?.resources.filter(r=>r.kind!=='firewall'&&r.kind!=='subnet')??[];return{stopped:real.filter(r=>health(r.status)==='stopped').length,warn:real.filter(r=>health(r.status)==='warn').length};},[snapshot]);
  const scopePath=resource&&index?index.pathTo(`${resource.provider}:scope:${resource.scope}`):[];
  const panel=!snapshot||view!=='map'?null:trace?<PathPanel snapshot={snapshot} from={trace.from} to={trace.to} path={path} onChange={changeTrace} onSelect={id=>setSelected(id)} onClose={()=>setTrace(null)}/>:impact&&impactResult?<ImpactPanel snapshot={snapshot} id={impact} lost={impactResult.lost} onSelect={selectById} onClose={()=>setImpact(null)}/>:edge?<EdgeDetail bundle={edge} snapshot={snapshot} onSelect={id=>{setEdge(null);setSelected(id)}} onClose={()=>setEdge(null)}/>:resource?<ResourceDetail resource={resource} snapshot={snapshot} onSelect={selectById} onClose={()=>setSelected(null)} onTrace={startTrace} onImpact={startImpact} canImpact={ingressIds(snapshot.resources).length>0} scopePath={scopePath} onOpenScope={openTab}/>:null;
  const sidebar=index&&snapshot&&sideOpen&&<aside className="sidebar side-toggle-hide" aria-label="관리 범위 탐색"><div className="side-head">관리 범위<button className="icon-button" onClick={()=>setSideOpen(false)} aria-label="범위 패널 접기"><PanelLeftClose size={16}/></button></div><div className="side-scroll"><button className={`side-provider ${active===ALL?'is-active':''}`} onClick={()=>openTab(ALL)}><Layers3 size={16}/>전체 지도<b>{snapshot.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external').length}</b></button>{(['azure','aws','gcp'] as const).filter(p=>index.roots[p].length).map(p=><div className="side-group" key={p}><button className={`side-provider ${active===`provider:${p}`?'is-active':''}`} onClick={()=>openTab(`provider:${p}`)}><ProviderMark provider={p}/>{shortProvider[p]}<b>{snapshot.resources.filter(r=>r.provider===p&&r.scope!=='external').length}</b></button><ScopeTree compact index={index} nodes={index.roots[p]} activeId={active} onOpen={openTab}/></div>)}</div></aside>;
  const toolbar=snapshot&&<div className="bar-tools"><span className="bar-label">상세</span><div className="segmented" role="group" aria-label="상세 수준">{LEVELS.map((l,i)=><button key={l} className={level===i?'active':''} aria-pressed={level===i} onClick={()=>applyLevel(snapshot,i)}>{l}</button>)}</div><span className="tool-sep"/><button className={`tool ${policy?'on':''}`} aria-pressed={policy} onClick={()=>setPolicy(!policy)} title="NSG·보안 그룹·방화벽 규칙을 적용 관계로 표시"><ShieldCheck size={14}/>정책</button>{hasFlows&&<button className={`tool ${flow?'on':''}`} aria-pressed={flow} disabled={live} title={live?'실제 로그 연동 전입니다.':'시연용 트래픽 표시'} onClick={()=>setFlow(!flow)}><Waypoints size={14}/>트래픽</button>}{flow&&hasFlows&&<button className="tool icon" onClick={()=>setPlaying(!playing)} aria-label={playing?'트래픽 일시정지':'트래픽 재생'}>{playing?<Pause size={12}/>:<Play size={12}/>}</button>}<span className="tool-sep"/><button className={`tool ${trace?'on':''}`} aria-pressed={!!trace} onClick={()=>{if(trace)setTrace(null);else{const start=selected&&byId.get(selected)?.kind!=='firewall'?selected:snapshot.resources.find(r=>r.kind==='compute'&&health(r.status)==='ok'&&inFocus(r))?.id??snapshot.resources.find(r=>r.kind==='compute')?.id??snapshot.resources[0].id;startTrace(start);}}}><Route size={14}/>경로 추적</button><details className="legend-pop"><summary>범례</summary><div className="legend">{edgeKinds.has('hybrid')&&<span><i className="line hybrid"/>전용선·VPN</span>}{edgeKinds.has('peering')&&<span><i className="line peering"/>피어링</span>}{edgeKinds.has('attachment')&&<span><i className="line attachment"/>연결</span>}{policy&&<span><i className="line policy"/>정책 적용</span>}{flow&&hasFlows&&<span><i className="line flow"/>시연 트래픽</span>}{stats.warn>0&&<span><AlertTriangle size={12} className="ico-warn"/>이상</span>}{stats.stopped>0&&<span><CircleOff size={12}/>중지</span>}</div></details>{layingOut&&<span className="tool-busy" role="status"><RefreshCw size={13} className="spin"/>배치 중</span>}</div>;
  const body=error?<div className="load-state" role="alert"><AlertTriangle size={30}/><h2>데이터를 불러오지 못했습니다</h2><p>{error}</p><button className="button" onClick={load}>다시 시도</button></div>:!snapshot||!index?<div className="skeleton" role="status"><RefreshCw className="spin"/>인프라 데이터를 불러오는 중입니다.</div>:view==='home'?<ScopeHome snapshot={snapshot} index={index} onOpen={openTab} onConnect={()=>setDialog(true)} onSelectResource={selectById}/>:<div className="work">{sidebar}<main className="stage">
      <div className="map-tabs" role="tablist" aria-label="열린 범위">{!sideOpen&&<button className="icon-button side-toggle-hide" onClick={()=>setSideOpen(true)} aria-label="범위 패널 펼치기"><PanelLeft size={16}/></button>}{tabs.map(t=>{const node=index.nodes.get(t);return <div key={t} className={`map-tab ${t===active?'active':''}`}><button role="tab" aria-selected={t===active} onClick={()=>{if(t!==active)openTab(t)}} title={tabLabel(index,t)}>{t===ALL?<Layers3 size={14}/>:t.startsWith('provider:')?<ProviderMark provider={t.slice(9)}/>:node&&<ScopeIcon node={node} size={15}/>}<span>{tabLabel(index,t)}</span></button>{t!==ALL&&<button className="tab-close" onClick={()=>closeTab(t)} aria-label={`${tabLabel(index,t)} 탭 닫기`}><X size={13}/></button>}</div>})}</div>
      <div className="map-bar"><nav className="crumbs" aria-label="현재 범위"><button onClick={()=>changeView('home')}>관리 범위</button>{crumbs.length===0&&<><ChevronRight size={13}/><span aria-current="page" className="crumb-now">전체 지도</span></>}{crumbs.map((c,i)=><span key={c.id} style={{display:'contents'}}><ChevronRight size={13}/><button aria-current={i===crumbs.length-1?'page':undefined} onClick={()=>openTab(c.id)}>{c.name}</button></span>)}</nav>{view==='map'&&topology.nodes.length>0&&toolbar}</div>
      {view==='inventory'?<Inventory snapshot={snapshot} rows={inventoryRows} onOpen={focusResource}/>:<div className={`canvas ${farOut?'lod-far':''}`}><ReactFlow nodes={decorated.nodes} edges={decorated.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeClick={onNodeClick} onNodeDoubleClick={onNodeDoubleClick} onEdgeClick={(_,e)=>{setEdge(e.data!.bundle);setSelected(null);setImpact(null);setTrace(null);}} onPaneClick={clearModes} minZoom={.03} maxZoom={1.8} nodesConnectable={false} nodesDraggable={false} edgesReconnectable={false} elevateNodesOnSelect={false} elevateEdgesOnSelect={false} zoomOnDoubleClick={false} onlyRenderVisibleElements={decorated.nodes.length>200} deleteKeyCode={null} proOptions={{hideAttribution:true}}>
        <svg className="edge-defs" aria-hidden="true"><defs><marker id="atlas-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1 L7,4 L1,7" fill="none" stroke="context-stroke" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></marker></defs></svg>
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--grid)"/>
        {decorated.nodes.length>25&&<MiniMap nodeColor={n=>(n as FlowNode).type==='frame'?'transparent':'var(--mini)'} nodeStrokeColor={n=>(n as FlowNode).type==='frame'?'var(--mini-frame)':'transparent'} maskColor="var(--mini-mask)" pannable zoomable position="bottom-right"/>}
        <Panel position="bottom-left"><div className="zoom-controls"><button onClick={()=>rf.zoomIn({duration:200})} aria-label="확대"><Plus size={15}/></button><button onClick={()=>rf.zoomOut({duration:200})} aria-label="축소"><Minus size={15}/></button><button onClick={()=>rf.fitView({padding:FIT_PADDING,duration:300,maxZoom:1})} aria-label="전체 보기"><Scan size={15}/></button></div></Panel>
      </ReactFlow>{!decorated.nodes.length&&!loading&&!layingOut&&<div className="canvas-empty"><div><p>이 범위에 수집된 자원이 없습니다. 조직에는 있지만 아직 수집하지 않은 범위일 수 있습니다.</p><button className="button" onClick={()=>setDialog(true)}><Plug size={14}/>연결 방법 보기</button></div></div>}</div>}
    </main><div className="panel-host open">{panel}</div></div>;
  return <div className="app"><header className="topbar"><a className="brand" href="/" aria-label="Cloud Atlas 처음으로"><span className="brand-symbol"><Waypoints size={17}/></span>Cloud Atlas</a>
    <nav className="view-tabs" aria-label="화면 전환">{([['home',FolderTree,'관리 범위'],['map',Network,'연결 지도'],['inventory',Table2,'인벤토리']] as const).map(([k,Icon,l])=><button key={k} className={view===k?'active':''} aria-current={view===k?'page':undefined} onClick={()=>changeView(k)}><Icon size={14}/><span>{l}</span></button>)}</nav>
    {!live&&<label className="scenario"><span>예시</span><select aria-label="예시 아키텍처" value={scenario} onChange={e=>changeScenario(e.target.value as ScenarioId)}>{['단순','표준','복잡'].map(g=><optgroup key={g} label={g}>{scenarios.filter(x=>x.group===g).map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>)}</select></label>}
    <div className="search"><Search size={15}/><input ref={searchRef} aria-label="리소스와 범위 검색" placeholder="자원, IP, 구독 찾기  ( / )" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){setQuery('');e.currentTarget.blur();}if(e.key==='Enter'&&q){if(scopeMatches[0]&&!matches[0]){openTab(scopeMatches[0].id);setQuery('');}else if(matches[0])focusResource(matches[0]);}}}/>{query&&<button aria-label="검색 지우기" onClick={()=>setQuery('')}><X size={13}/></button>}{q&&view!=='inventory'&&<div className="search-results">{scopeMatches.map(n=><button key={n.id} onClick={()=>{openTab(n.id);setQuery('')}}><ScopeIcon node={n} size={20}/><span>{n.name}<small>{providerNames[n.provider]} · {hierarchyNouns[n.kind]} · 토폴로지 열기</small></span></button>)}{matches.slice(0,10).map(r=><button key={r.id} onClick={()=>focusResource(r)}><ResourceIcon resource={r} size={20}/><span>{r.name}<small>{providerNames[r.provider]} · {kindNames[r.kind]}{r.ip?` · ${r.ip}`:''}</small></span></button>)}{!matches.length&&!scopeMatches.length&&<p>검색 결과가 없습니다.</p>}</div>}</div>
    <div className="topbar-right"><span className={`mode-pill ${live?'live':''}`}><i/>{live?'실제 수집 스냅샷':'목데이터 · 로그인 전'}</span><button className="icon-button" onClick={load} disabled={loading} aria-label="데이터 새로고침" title="데이터 새로고침"><RefreshCw size={15} className={loading?'spin':''}/></button><button className="icon-button" onClick={exportSnapshot} disabled={!snapshot} aria-label="스냅샷 내보내기" title="스냅샷 내보내기"><Download size={15}/></button><button className="button primary" onClick={()=>setDialog(true)}><Plug size={14}/><span>클라우드 연결</span></button></div></header>
  <div className="body">{body}</div>
  {dialog&&<ConnectorDialog close={()=>setDialog(false)}/>}{toast&&<div className="toast" role="status"><Check size={15}/>{toast}</div>}</div>;
}
export default function App(){return <ReactFlowProvider><Workspace/></ReactFlowProvider>}
