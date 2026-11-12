import {ResourcePage,type ResourceSummary} from '../shared/page-contracts';
import {CollectionPicker} from './CollectionPicker';
import {initialCollection,type CollectionSelection} from '../shared/collection-items';
import {searchKey,searchResources} from '../shared/search';
import {useSearchQuery} from './useSearchQuery';
import {ViewCache} from '../shared/view-transport';
import {useResourcePreferences} from './resource-preferences';
import {AccessRelations} from './AccessRelations';
import {CollectionNotice} from './CollectionNotice';
import {isAuxiliary,isNetworkResource} from '../shared/classification';
import {networkEmptyMessage} from '../shared/collectionView';
import React,{useState,useEffect,useMemo,useRef,useCallback,lazy,Suspense} from 'react';
import {ReactFlow,ReactFlowProvider,Background,MiniMap,useReactFlow,useNodesInitialized,useStore,Panel,BackgroundVariant,type NodeMouseHandler} from '@xyflow/react';
import {Waypoints,Search,Plug,RefreshCw,Download,Pause,Play,Plus,Minus,Scan,ShieldCheck,Network,X,Check,Route,Table2,LayoutDashboard,Wallet,KeyRound,Share2,Globe,AlertTriangle,CircleOff,ChevronRight,PanelLeft,PanelLeftClose,Layers3,ListChecks,History,ShieldAlert,ScrollText,FileJson,Image,FileCode2,LogOut} from 'lucide-react';
import {validateSnapshot,ResourceSchema,type Snapshot,type Resource} from '../shared/schema';
import {DEFAULT_SCENARIO,isScenario,scenarios,type ScenarioId} from '../shared/scenarios';
import {ancestors,findPath,health,impactOf,ingressIds,reachable} from '../shared/topology';
import {buildScopeIndex,focusFor,hierarchyNouns,inScope,type Focus,type ScopeIndex} from '../shared/hierarchy';
import {ResourceNode,FrameNode,SummaryNode,RoutedEdge,ProviderMark,ResourceIcon,kindNames,type Emphasis,type FlowNode,type FlowEdge} from './graph';
import {computeTopology,workloadGroupId,isolatedWorkloads,defaultExpanded,providerNames,regionId,scopeFrameId,startingLevel,type Bundle,type Topology,type RelationLayer} from './layout';
import {EdgeDetail,ImpactPanel,PathPanel,ResourceDetail} from './Detail';
import {ScopeHome} from './ScopeHome';
import {ConnectGuide} from './ConnectGuide';
const Dashboard=lazy(()=>import('./pages/Dashboard').then(m=>({default:m.Dashboard})));
const CostPage=lazy(()=>import('./pages/Cost').then(m=>({default:m.CostPage})));
const IamPage=lazy(()=>import('./pages/Iam').then(m=>({default:m.IamPage})));
const NetworkPage=lazy(()=>import('./pages/Network').then(m=>({default:m.NetworkPage})));
const SecurityPage=lazy(()=>import('./pages/Security').then(m=>({default:m.SecurityPage})));
const ChangesPage=lazy(()=>import('./pages/Changes').then(m=>({default:m.ChangesPage})));
const FindingsPage=lazy(()=>import('./pages/Findings').then(m=>({default:m.FindingsPage})));
const AuditPage=lazy(()=>import('./pages/Audit').then(m=>({default:m.AuditPage})));
// Charts are the heaviest dependency and only this page uses them, so it loads on first visit.
const ResourcesPage=lazy(()=>import('./pages/Resources').then(m=>({default:m.ResourcesPage})));
import {ScopeBar,ScopePanel} from './ScopeBar';
import {findings,type Finding} from '../shared/findings';
import {Onboarding,type CollectState} from './Onboarding';
import {CollectProgress,ProgressBar,percent} from './CollectProgress';
import {ScopeIcon} from './ScopeTree';
import {downloadDrawio,downloadJson,downloadPng,downloadSvg} from './exporters';
type View='dashboard'|'findings'|'changes'|'scopes'|'map'|'inventory'|'network'|'security'|'iam'|'audit'|'cost';
const VIEWS:View[]=['dashboard','findings','changes','scopes','map','inventory','network','security','iam','audit','cost'];
// These pages read the selection from the scope bar. Only the map shows it as tabs and a tree instead.
const SCOPE_BAR_VIEWS:View[]=['dashboard','findings','changes','inventory','network','security','iam','audit','cost'];
const GUIDE_KEY='atlas.guide.seen';
// Storage can be missing or blocked; then the guide just shows again next visit.
const guideSeen=()=>{try{return localStorage.getItem(GUIDE_KEY)==='1';}catch{return false;}};
const markGuideSeen=()=>{try{localStorage.setItem(GUIDE_KEY,'1');}catch{/* see guideSeen */}};
const nodeTypes={resource:ResourceNode,frame:FrameNode,summary:SummaryNode},edgeTypes={routed:RoutedEdge};
const LEVELS=['개요','서브넷','전체'],ALL='all';
const FIT_PADDING={top:'24px',right:'24px',bottom:'64px',left:'24px'} as const;
const EMPTY:Topology={nodes:[],edges:[],rollup:()=>undefined};
const shortProvider:Record<string,string>={azure:'Azure',aws:'AWS',gcp:'Google Cloud'};
type Route={scenario:ScenarioId;view:View;tab:string};
const readRoute=():Route=>{const q=new URLSearchParams(location.search),s=q.get('scenario'),v=q.get('view');return{scenario:isScenario(s)?s:DEFAULT_SCENARIO,view:VIEWS.includes(v as View)?v as View:'dashboard',tab:q.get('scope')??ALL};};
const routeUrl=({scenario,view,tab}:Route)=>{const q=new URLSearchParams({scenario});if(view!=='dashboard')q.set('view',view);if(tab!==ALL)q.set('scope',tab);return `${location.pathname}?${q}`;};
const tabLabel=(index:ScopeIndex|null,tab:string)=>tab===ALL?'전체 지도':tab.startsWith('provider:')?shortProvider[tab.slice(9)]:index?.nodes.get(tab)?.name??tab;
const NAV=[['개요',[['dashboard',LayoutDashboard,'대시보드'],['findings',ListChecks,'조치 항목'],['changes',History,'변경 이력']]],['인프라',[['map',Share2,'토폴로지'],['inventory',Table2,'리소스'],['network',Globe,'네트워크']]],['보안',[['security',ShieldAlert,'노출·방화벽'],['iam',KeyRound,'IAM'],['audit',ScrollText,'접근 로그']]],['비용',[['cost',Wallet,'비용']]]] as const;
function Login({onDone}:{onDone:()=>void}){
  const [token,setToken]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});if(!r.ok){setError((await r.json()).error??'로그인에 실패했습니다.');return;}onDone();}catch{setError('서버에 연결하지 못했습니다.');}finally{setBusy(false);}};
  return <div className="load-state"><form className="login" onSubmit={submit}><h2>접근 토큰이 필요합니다</h2><p className="muted small">실제 인프라 구성을 보려면 관리자에게 받은 토큰을 입력하세요.</p><label htmlFor="atlas-token">접근 토큰</label><input id="atlas-token" type="password" autoComplete="current-password" value={token} onChange={e=>setToken(e.target.value)} aria-invalid={!!error} aria-describedby={error?'atlas-token-error':undefined} required/>{error&&<p id="atlas-token-error" className="field-error" role="alert">{error}</p>}<button className="button primary" disabled={busy||!token}>{busy?'확인 중':'로그인'}</button></form></div>;
}
function Workspace(){
  const initial=useRef(readRoute()).current;
  const [scenario,setScenario]=useState<ScenarioId>(initial.scenario),[view,setView]=useState<View>(initial.view),[tabs,setTabs]=useState<string[]>(initial.tab===ALL?[ALL]:[ALL,initial.tab]),[active,setActive]=useState(initial.tab);
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[layingOut,setLayingOut]=useState(false);
  const [accessLayer,setAccessLayer]=useState(false);
  const [snapshotKey,setSnapshotKey]=useState('');
  const [composing,setComposing]=useState(false);
  const preferences=useResourcePreferences();
  const [level,setLevel]=useState(0),[expanded,setExpanded]=useState<Set<string>>(new Set()),[policy,setPolicy]=useState(false),[workloads,setWorkloads]=useState(false),[flow,setFlow]=useState(true),[playing,setPlaying]=useState(true);
  const [selected,setSelected]=useState<string|null>(null),[edge,setEdge]=useState<Bundle|null>(null),[trace,setTrace]=useState<{from:string;to:string}|null>(null),[impact,setImpact]=useState<string|null>(null);
  const [layers,setLayers]=useState<Set<RelationLayer>>(new Set(['network','traffic','external']));
  const [query,setQuery]=useState(''),[dialog,setDialog]=useState(false),[firstGuide,setFirstGuide]=useState(false),[toast,setToast]=useState(''),[topology,setTopology]=useState<Topology>(EMPTY),[fitTick,setFitTick]=useState(0),[sideOpen,setSideOpen]=useState(true);
  const settledQuery=useSearchQuery(query,composing);
  const ready=snapshotKey===`${scenario}:${view}`;
  const farOut=useStore(s=>s.transform[2]<.5),rf=useReactFlow(),nodesReady=useNodesInitialized(),pendingFit=useRef<{ids?:string[];anchor?:{id:string;x:number;y:number}}|null>({}),searchRef=useRef<HTMLInputElement>(null);
  const tabViews=useRef(new Map<string,{expanded:Set<string>;level:number}>());
  const [needsLogin,setNeedsLogin]=useState(false),[session,setSession]=useState<{required:boolean;name?:string}>({required:false}),[searchOpen,setSearchOpen]=useState(false),[picking,setPicking]=useState<'from'|'to'|null>(null),[activeHop,setActiveHop]=useState<string|null>(null);
  const [onboarding,setOnboarding]=useState(false),[collect,setCollect]=useState<CollectState|null>(null),finishedAt=useRef<string|undefined>(undefined);
  const collectRunning=useRef(false);collectRunning.current=!!collect?.running;
  const pageCache=useRef(new Map<string,Snapshot>());
  const viewCache=useRef(new ViewCache());
  const currentView=useRef(view);currentView.current=view;
  const pendingResource=useRef<Resource|null>(null),searchRequest=useRef<AbortController|null>(null);
  const inFlight=useRef<AbortController|null>(null),canvasRef=useRef<HTMLDivElement>(null);
  // What was opened goes to the portal audit log. Losing a record must never break the page, so failures are ignored.
  const track=useCallback((action:'view'|'open'|'export',target:string,detail?:string)=>{fetch('/api/audit/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,target,detail}),keepalive:true}).catch(()=>{});},[]);
  useEffect(()=>{track('view',initial.view);},[track,initial.view]);
  // Only the newest request may land, otherwise a slow scenario overwrites the one the user just picked.
  const load=useCallback(async(refresh=true)=>{
    inFlight.current?.abort();const controller=new AbortController();inFlight.current=controller;
    setLoading(true);setError('');
    const key=`${scenario}:${currentView.current}`;
    if(refresh){pageCache.current.clear();viewCache.current.clear();}
    const cached=pageCache.current.get(key);if(cached){setSnapshot(cached);setSnapshotKey(key);setLoading(false);return;}
    try{
      const base=viewCache.current.revision;
      const response=await fetch(`/api/topology?scenario=${scenario}&part=${currentView.current}&transport=1${base?`&base=${base}`:''}`,{signal:controller.signal});
      if(response.status===401){searchRequest.current?.abort();pendingResource.current=null;setRemoteSearch({query:'',rows:[]});pageCache.current.clear();viewCache.current.clear();setNeedsLogin(true);setSnapshot(null);setSnapshotKey('');return;}
      if(!response.ok){const body=await response.json();if(body.onboarding){setOnboarding(true);setSnapshot(null);return;}throw new Error(body.error??'데이터 요청 실패')}
      const payload=await response.json();if(controller.signal.aborted)return;
      const data=viewCache.current.decode(payload);pageCache.current.set(key,data);if(pageCache.current.size>24)pageCache.current.delete(pageCache.current.keys().next().value!);setSnapshotKey(key);setNeedsLogin(false);setOnboarding(false);setSnapshot(data);if(data.mode==='live')setFlow(false);else if(!guideSeen()){setFirstGuide(true);setDialog(true);}
      fetch('/api/session',{signal:controller.signal}).then(r=>r.json()).then(setSession).catch(()=>{});
    }catch(e){if(controller.signal.aborted)return;setError(e instanceof Error?e.message:'데이터를 불러오지 못했습니다.')}
    finally{if(!controller.signal.aborted)setLoading(false)}
  },[scenario]);
  useEffect(()=>{load(false);return()=>inFlight.current?.abort()},[load,view]);
  // Only live mode has a collector to watch. A finished run reloads the data so new clouds appear on their own.
  const watching=onboarding||snapshot?.mode==='live';
  const refreshCollect=useCallback(async()=>{
    const r=await fetch('/api/collect/status');if(!r.ok){setCollect(null);return;}
    const next=await r.json() as CollectState;setCollect(next);
    if(next.finishedAt&&next.finishedAt!==finishedAt.current){const first=finishedAt.current===undefined;finishedAt.current=next.finishedAt;if(!first||onboarding)load();if(!first){const states=Object.values(next.providers),good=states.filter(p=>p.state==='ok'||p.state==='partial').length,bad=states.filter(p=>p.state==='failed').length;setToast(bad?`수집 완료: ${good}개 성공, ${bad}개 실패. 수집 상태를 확인하세요.`:`수집 완료: 클라우드 ${good}개를 반영했습니다.`);}}
    return next;
  },[load,onboarding]);
  useEffect(()=>{
    if(!watching)return;let stop=false,timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{let running=collectRunning.current;try{running=!!(await refreshCollect())?.running;}catch{/* the next tick retries */}if(!stop)timer=setTimeout(tick,running?2000:30000);};
    tick();return()=>{stop=true;clearTimeout(timer);};
  },[watching,refreshCollect,collect?.running]);
  const startCollect=async(selection:CollectionSelection={mode:'all'})=>{try{const r=await fetch('/api/collect',{method:'POST',headers:{'X-Atlas-Request':'1','Content-Type':'application/json'},body:JSON.stringify(selection)});if(!r.ok){setToast((await r.json()).error??'수집을 시작하지 못했습니다.');return;}setToast('수집을 시작했습니다.');refreshCollect();setTimeout(()=>refreshCollect(),1500);}catch{setToast('수집 서버에 연결하지 못했습니다. 다시 시도하세요.');}};
  const logout=async()=>{searchRequest.current?.abort();pendingResource.current=null;setRemoteSearch({query:'',rows:[]});setQuery('');inFlight.current?.abort();pageCache.current.clear();viewCache.current.clear();setSnapshotKey('');await fetch('/api/session',{method:'DELETE'});setSnapshot(null);setNeedsLogin(true);setSession({required:true});};
  useEffect(()=>{if(toast){const t=setTimeout(()=>setToast(''),2500);return()=>clearTimeout(t)}},[toast]);
  const index=useMemo(()=>snapshot?buildScopeIndex(snapshot.hierarchy,snapshot.resources,snapshot.presentation?.scopeStats):null,[snapshot]);
  const focus=useMemo(()=>focusFor(index,active),[index,active]);
  const byId=useMemo(()=>new Map(snapshot?.resources.map(r=>[r.id,r])),[snapshot]);
  const model=useMemo(()=>({resources:snapshot?.resources??[],links:snapshot?.links??[]}),[snapshot]);
  const inFocus=useCallback((r:Resource,f:Focus=focus)=>inScope(f,r.provider,r.scope),[focus]);
  const applyLevel=useCallback((data:Snapshot,l:number)=>{setLevel(l);setExpanded(defaultExpanded(data,l));pendingFit.current={};setFitTick(t=>t+1);},[]);
  const clearModes=useCallback(()=>{setTrace(null);setImpact(null);setEdge(null);setSelected(null);setPicking(null);setActiveHop(null);},[]);
  // Each tab remembers what was expanded, so moving between scopes never loses your place.
  const showTab=useCallback((data:Snapshot,idx:ScopeIndex,tab:string,from?:string)=>{
    if(from!==undefined)tabViews.current.set(from,{expanded,level});
    setActive(tab);clearModes();
    const saved=tabViews.current.get(tab);
    if(saved){setExpanded(saved.expanded);setLevel(saved.level);pendingFit.current={};setFitTick(t=>t+1);return;}
    const f=focusFor(idx,tab),count=data.resources.filter(r=>isNetworkResource(r)&&inFocus(r,f)).length;applyLevel(data,startingLevel(count));
  },[expanded,level,clearModes,applyLevel,inFocus]);
  const seeded=useRef<string|undefined>(undefined);
  useEffect(()=>{
    if(!snapshot||!index||snapshot.presentation?.part==='scopes')return;const key=snapshot.scenario??'live';if(seeded.current===key)return;seeded.current=key;tabViews.current.clear();
    const valid=(t:string)=>t===ALL||t.startsWith('provider:')||index.nodes.has(t),tab=valid(active)?active:ALL;
    if(tab===ALL)setTabs([ALL]);showTab(snapshot,index,tab);
  },[snapshot,index,active,showTab]);
  useEffect(()=>{
    if(!snapshot||!expanded.size||view!=='map')return;
    let stale=false;setLayingOut(true);
    computeTopology(snapshot,{provider:focus.provider,scopes:focus.scopes,policy,flow,expanded,workloads,layers,budget:level>=0?60:undefined}).then(t=>{if(!stale){setTopology(t);setLayingOut(false);}}).catch(e=>{console.error(e);if(!stale){setError('토폴로지를 배치하지 못했습니다.');setLayingOut(false);}});
    return()=>{stale=true};
  },[snapshot,view,focus,policy,flow,expanded,workloads,level,layers]);
  const go=useCallback((next:Partial<Route>,replace=false)=>{const route={scenario,view,tab:active,...next};history[replace?'replaceState':'pushState'](null,'',routeUrl(route));},[scenario,view,active]);
  const openTab=useCallback((tab:string)=>{
    if(!snapshot||!index)return;
    setTabs(cur=>cur.includes(tab)?cur:[...cur,tab]);showTab(snapshot,index,tab,tab===active?undefined:active);setView('map');go({view:'map',tab});
  },[snapshot,index,showTab,active,go]);
  // Narrowing from the bar replaces the current selection, so trying a few scopes does not pile up map tabs.
  const selectScope=useCallback((tab:string)=>{
    if(!snapshot||!index||tab===active)return;
    setTabs(cur=>{const kept=cur.filter(t=>t===ALL||t!==active);return kept.includes(tab)?kept:[...kept,tab];});showTab(snapshot,index,tab,active);go({tab});
  },[snapshot,index,active,showTab,go]);
  const closeTab=(tab:string)=>{setTabs(cur=>cur.filter(t=>t!==tab));tabViews.current.delete(tab);if(tab===active&&snapshot&&index){const remaining=tabs.filter(t=>t!==tab),next=remaining[remaining.length-1]??ALL;showTab(snapshot,index,next);go({tab:next},true);}};
  const changeView=(v:View)=>{track('view',v);setView(v);if(v!=='map')clearModes();pendingFit.current={};go({view:v});};
  useEffect(()=>{
    const onPop=()=>{const r=readRoute();setView(r.view);if(r.scenario!==scenario){setScenario(r.scenario);setTabs(r.tab===ALL?[ALL]:[ALL,r.tab]);setActive(r.tab);return;}
      if(r.tab!==active&&snapshot&&index){setTabs(cur=>cur.includes(r.tab)?cur:[...cur,r.tab]);showTab(snapshot,index,r.tab,active);}else pendingFit.current={};};
    addEventListener('popstate',onPop);return()=>removeEventListener('popstate',onPop);
  },[scenario,active,snapshot,index,showTab]);
  // Popovers close on any outside press, the behaviour every other menu on the platform has.
  useEffect(()=>{
    const onDown=(e:PointerEvent)=>{const t=e.target as Element;if(!t.closest('.search'))setSearchOpen(false);document.querySelectorAll('details[open].menu-pop').forEach(d=>{if(!d.contains(t))d.removeAttribute('open');});};
    addEventListener('pointerdown',onDown);return()=>removeEventListener('pointerdown',onDown);
  },[]);
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      const typing=/INPUT|SELECT|TEXTAREA/.test((e.target as HTMLElement).tagName);
      if(e.key==='/'&&!typing){e.preventDefault();searchRef.current?.focus();}
      if(e.key==='Escape'&&!typing&&!dialog)clearModes();
    };
    addEventListener('keydown',onKey);return()=>removeEventListener('keydown',onKey);
  },[dialog,clearModes]);
  const path=useMemo(()=>trace?findPath(model,trace.from,[trace.to]):[],[model,trace]);
  const impactResult=useMemo(()=>snapshot&&impact?impactOf(snapshot.resources,snapshot.links,impact):null,[snapshot,impact]);
  // Keeps the toggled container under the pointer so the rest of the map reflows around a fixed point.
  function toggle(id:string){
    const n=topology.nodes.find(x=>x.id===id),v=rf.getViewport();
    setLevel(-1);setExpanded(cur=>{const next=new Set(cur);(n?n.collapsed:!next.has(id))?next.add(id):next.delete(id);return next;});
    pendingFit.current=n?{anchor:{id,x:n.x*v.zoom+v.x,y:n.y*v.zoom+v.y}}:{ids:[id]};
  }
  const stableToggle=useRef(toggle);stableToggle.current=toggle;
  const onToggle=useCallback((id:string)=>stableToggle.current(id),[]);
  // Separate from layout so highlighting never re-runs ELK or moves anything.
  const onPolicies=useCallback((id:string)=>{setAccessLayer(true);setSelected(byId.has(id)?id:null);setEdge(null);setTrace(null);setImpact(null);},[byId]);
  const decorated=useMemo(()=>{
    const {rollup}=topology,emphasisOf=new Map<string,Emphasis>();let focusMode=false;
    const mark=(id:string|undefined,e:Emphasis)=>{if(id&&emphasisOf.get(id)!=='removed')emphasisOf.set(id,e);};
    const keepAncestors=(id:string|undefined)=>{for(const a of id?ancestors(byId,id):[])if(!emphasisOf.has(a))emphasisOf.set(a,'normal');};
    const edgeState=new Map<string,Emphasis>();
    if(trace&&path.length){focusMode=true;const seq=path.map(rollup).filter((x,i,a):x is string=>!!x&&x!==a[i-1]);seq.forEach(id=>{mark(id,'path');keepAncestors(id)});for(let i=0;i<seq.length-1;i++)edgeState.set([seq[i],seq[i+1]].sort().join('|'),'path');if(activeHop)mark(rollup(activeHop),'focus');}
    else if(impactResult){focusMode=true;impactResult.lost.forEach(id=>{mark(rollup(id),'impact');keepAncestors(rollup(id))});impactResult.removed.forEach(id=>{mark(rollup(id),'removed');keepAncestors(rollup(id))});}
    else if(edge){focusMode=true;edgeState.set(edge.id,'focus');mark(edge.source,'focus');mark(edge.target,'focus');keepAncestors(edge.source);keepAncestors(edge.target);}
    else if(selected){const own=rollup(selected);if(own){focusMode=true;mark(own,'focus');keepAncestors(own);for(const b of topology.edges)if(b.source===own||b.target===own){edgeState.set(b.id,'focus');const other=b.source===own?b.target:b.source;mark(other,'focus');keepAncestors(other);}}}
    const placed=new Map(topology.nodes.map(n=>[n.id,n])),frameAncestors=new Set<string>();
    for(const id of emphasisOf.keys())for(let p=placed.get(id)?.item.parent;p;p=placed.get(p)?.item.parent)frameAncestors.add(p);
    const nodes:FlowNode[]=topology.nodes.map(n=>{
      const framed=!!n.item.variant&&!n.collapsed,emphasis=emphasisOf.get(n.id)??(focusMode&&!frameAncestors.has(n.id)?'dim':'normal');
      return{id:n.id,type:framed?'frame':n.item.variant?'summary':'resource',position:{x:n.x,y:n.y},width:n.width,height:n.height,measured:{width:n.width,height:n.height},zIndex:framed?n.depth:20,draggable:false,connectable:false,ariaLabel:`${n.item.label}${n.item.resource?` ${kindNames[n.item.resource.kind]}`:''}, Enter로 ${n.item.resource?'상세 열기':'펼치기'}`,data:{...n,emphasis,onToggle,onPolicies,scopeLabel:n.item.resource&&n.item.variant==='network'?snapshot?.scopeLabels[n.item.resource.scope]??n.item.resource.scope:undefined}};
    });
    const edges:FlowEdge[]=topology.edges.map(b=>{
      const emphasis=edgeState.get(b.id)??(focusMode?'dim':'normal');
      return{id:b.id,source:b.source,target:b.target,type:'routed',zIndex:10,focusable:true,ariaLabel:`${placed.get(b.source)?.item.label??b.source} → ${placed.get(b.target)?.item.label??b.target}, ${b.label}, Enter로 관계 근거 열기`,selected:edge?.id===b.id,data:{bundle:b,emphasis,animate:flow&&playing&&b.hasFlow&&emphasis!=='dim',showLabel:emphasis!=='dim'&&(!b.trunk||emphasis==='focus')&&(b.kind==='hybrid'||b.kind==='peering'||b.links.filter(l=>l.kind!=='simulation').length>1||emphasis==='focus')}};
    });
    return{nodes,edges};
  },[topology,trace,path,activeHop,impactResult,edge,selected,flow,playing,byId,snapshot,onToggle,onPolicies]);
  // Keyed on the layout, not highlighting: a fit waits for the layout it was requested for.
  useEffect(()=>{
    // A level change bumps the tick before its layout exists; waiting here fits the new graph, not the old one.
    if(view!=='map'||layingOut||!pendingFit.current||!topology.nodes.length||!nodesReady)return;
    const t=setTimeout(()=>{
      const anchor=pendingFit.current?.anchor,placedAnchor=anchor&&topology.nodes.find(n=>n.id===anchor.id);
      const ids=[...new Set(pendingFit.current?.ids?.map(i=>topology.rollup(i)).filter((x):x is string=>!!x))];pendingFit.current=null;
      if(anchor&&placedAnchor){const zoom=rf.getZoom();rf.setViewport({x:anchor.x-placedAnchor.x*zoom,y:anchor.y-placedAnchor.y*zoom,zoom},{duration:200});}
      else if(ids.length)rf.fitView({nodes:ids.map(id=>({id})),padding:FIT_PADDING,maxZoom:Math.max(rf.getZoom(),.9),duration:300});
      else{
        // Past this scale nothing is readable, so a huge expanded map opens at its entry point instead of as a speck.
        const box=canvasRef.current?.getBoundingClientRect(),right=Math.max(...topology.nodes.map(n=>n.x+n.width)),bottom=Math.max(...topology.nodes.map(n=>n.y+n.height));
        if(box&&Math.min(box.width/right,box.height/bottom)<.12){rf.setViewport({x:24,y:24,zoom:.3},{duration:300});setToast('지도가 커서 일부만 표시합니다. 미니맵이나 범위 탭으로 이동하세요.');}
        else rf.fitView({padding:FIT_PADDING,duration:300,maxZoom:1});
      }
    },70);
    return()=>clearTimeout(t);
  },[topology,nodesReady,view,fitTick,layingOut,rf]);
  const reveal=(ids:string[])=>{if(ids.some(id=>{const r=byId.get(id);return r&&!isNetworkResource(r);}))setWorkloads(true);setLevel(-1);setExpanded(cur=>{const next=new Set(cur);for(const id of ids){const r=byId.get(id);if(r){next.add(`provider:${r.provider}`);next.add(scopeFrameId(r));next.add(regionId(r));next.add(workloadGroupId(r));}for(const a of ancestors(byId,id)){next.add(a);const up=byId.get(a);if(up){next.add(scopeFrameId(up));next.add(regionId(up));}}}return next;});};
  const toAllTab=()=>{if(active!==ALL&&snapshot&&index){setTabs(cur=>cur.includes(ALL)?cur:[ALL,...cur]);tabViews.current.set(active,{expanded,level});setActive(ALL);return true;}return false;};
  const focusResource=(r:Resource)=>{
    // Non-network services are not on the map; the inventory is where they live.
    if(r.kind==='service'||isAuxiliary(r)||(!isNetworkResource(r)&&!r.parent&&!snapshot?.links.some(l=>l.source===r.id||l.target===r.id))){setQuery(r.name);setSearchOpen(false);changeView('inventory');return;}
    if(view!=='map'&&!snapshot?.resources.length)pendingResource.current=r;
    setTrace(null);setImpact(null);setEdge(null);setSelected(r.id);setQuery('');setSearchOpen(false);
    // Policies are hidden until their layer is on, so opening one must turn it on or the map shows nothing.
    if(r.kind==='firewall')setPolicy(true);
    if(!isNetworkResource(r))setWorkloads(true);
    const switched=!inFocus(r)&&r.provider!=='onprem'&&toAllTab();
    if(view!=='map'||switched){setView('map');go({view:'map',...(switched?{tab:ALL}:{})},view==='map');}
    reveal([r.id]);pendingFit.current={ids:[r.id]};
  };
  const selectById=(id:string)=>{const r=byId.get(id);if(r)focusResource(r);};
  const leaveScopeForAnalysis=()=>{if(toAllTab())go({tab:ALL},true);};
  const startTrace=(id:string)=>{
    if(!snapshot)return;
    const nearest=findPath(model,id,ingressIds(snapshot.resources)),others=[...reachable(model,[id])].filter(x=>x!==id&&byId.get(x)?.kind!=='subnet'),to=nearest[nearest.length-1]??others[others.length-1]??id;
    setImpact(null);setEdge(null);setPicking(null);setActiveHop(null);setTrace({from:id,to});leaveScopeForAnalysis();
    const hops=findPath(model,id,[to]);reveal(hops);pendingFit.current={ids:hops};
  };
  const changeTrace=(from:string,to:string)=>{setTrace({from,to});setActiveHop(null);const hops=findPath(model,from,[to]);reveal(hops);pendingFit.current={ids:hops};};
  const focusHop=(id:string)=>{setActiveHop(id);reveal([id]);pendingFit.current={ids:[id]};setFitTick(t=>t+1);};
  const startImpact=(id:string)=>{setTrace(null);setEdge(null);setImpact(id);leaveScopeForAnalysis();pendingFit.current={};setFitTick(t=>t+1);};
  const activate=(n:FlowNode)=>{
    const r=n.data.item.resource;
    if(!r){if(n.data.expandable)stableToggle.current(n.id);return;}
    if(picking&&trace&&r.kind!=='firewall'){changeTrace(picking==='from'?r.id:trace.from,picking==='to'?r.id:trace.to);setPicking(null);return;}
    setEdge(null);setImpact(null);setTrace(null);setSelected(r.id);
  };
  const keyboardEdge=useRef<string|null>(null);
  useEffect(()=>{
    if(!keyboardEdge.current)return;
    if(edge){document.querySelector<HTMLButtonElement>('.panel-host button[aria-label="상세 닫기"]')?.focus();return;}
    const id=keyboardEdge.current;keyboardEdge.current=null;
    // React Flow may replace an SVG wrapper when selection changes; resolve it again.
    const target=[...canvasRef.current?.querySelectorAll<SVGElement>('.react-flow__edge')??[]].find(el=>el.getAttribute('data-id')===id);
    target?.focus();
  },[edge]);
  // Keyboard parity for the map: React Flow focuses nodes but only fires click handlers for the mouse.
  const onCanvasKey=(e:React.KeyboardEvent)=>{
    if(e.key!=='Enter'&&e.key!==' ')return;
    const edgeElement=(e.target as Element).closest('.react-flow__edge');
    if(edgeElement){
      const found=decorated.edges.find(edge=>edge.id===edgeElement.getAttribute('data-id'));
      if(found){e.preventDefault();keyboardEdge.current=found.id;setEdge(found.data!.bundle);setSelected(null);setImpact(null);setTrace(null);}
      return;
    }
    const el=(e.target as HTMLElement).closest<HTMLElement>('.react-flow__node');if(!el||(e.target as HTMLElement).closest('button'))return;
    const n=decorated.nodes.find(x=>x.id===el.dataset.id);if(n){e.preventDefault();activate(n);}
  };
  // Clicking blank space in a frame must not collapse it: collapsing is the chevron's job alone.
  const onNodeClick:NodeMouseHandler<FlowNode>=(_,n)=>{if(n.data.item.resource)activate(n);};
  const onNodeDoubleClick:NodeMouseHandler<FlowNode>=(_,n)=>{if(n.data.expandable&&n.data.item.resource)stableToggle.current(n.id);};
  const changeScenario=(id:ScenarioId)=>{searchRequest.current?.abort();pendingResource.current=null;setRemoteSearch({query:'',rows:[]});setScenario(id);setTabs([ALL]);setActive(ALL);clearModes();setQuery('');setTopology(EMPTY);history.pushState(null,'',routeUrl({scenario:id,view,tab:ALL}));};
  const fileBase=`cloud-atlas-${snapshot?.scenario??snapshot?.mode??'map'}`;
  const runExport=async(run:()=>void|Promise<void>)=>{track('export',view,'지도·스냅샷 내보내기');(document.activeElement as HTMLElement|null)?.closest('details')?.removeAttribute('open');try{await run();setToast('파일을 내보냈습니다.');}catch(e){console.error(e);setToast('내보내기에 실패했습니다.');}};
  const q=searchKey(settledQuery);
  const matches=useMemo(()=>snapshot?searchResources(snapshot,q):[],[snapshot,q]);
  const scopeMatches=useMemo(()=>q&&snapshot?snapshot.hierarchy.filter(n=>searchKey(`${n.name} ${n.nativeId}`).includes(q)).slice(0,5):[],[snapshot,q]);
  const focusResourceRef=useRef(focusResource);focusResourceRef.current=focusResource;
  const openResource=useCallback((r:Resource)=>focusResourceRef.current(r),[]);
  useEffect(()=>{
    if(!ready||view!=='map'||!pendingResource.current)return;
    const resource=byId.get(pendingResource.current.id);
    if(resource){pendingResource.current=null;focusResourceRef.current(resource);}
  },[ready,view,byId]);
  const [remoteSearch,setRemoteSearch]=useState<{query:string;rows:ResourceSummary[]}>({query:'',rows:[]});
  useEffect(()=>{
    if(!snapshot||snapshot.resources.length||!q||composing||view==='inventory')return;
    const controller=new AbortController(),params=new URLSearchParams({scenario,q,limit:'10'});
    fetch(`/api/resources?${params}`,{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error();return ResourcePage.parse(await response.json());}).then(data=>{if(!controller.signal.aborted)setRemoteSearch({query:q,rows:data.rows});}).catch(()=>{});
    return()=>controller.abort();
  },[snapshot,q,composing,view,scenario]);
  const openRemote=async(id:string,signal?:AbortSignal)=>{
    try{const response=await fetch(`/api/resource?${new URLSearchParams({id,scenario})}`,{signal}),body=await response.json();if(!response.ok)throw new Error(body.error??'자원을 읽지 못했습니다.');if(body.version!==1)throw new Error('지원하지 않는 자원 형식입니다.');if(signal?.aborted)return;focusResourceRef.current(ResourceSchema.parse(body.resource));}
    catch(e){if(!signal?.aborted)setToast(e instanceof Error?e.message:'자원을 읽지 못했습니다.');}
  };
  const searchNow=async()=>{
    if(!snapshot)return;const key=searchKey(query);if(!key)return;
    searchRequest.current?.abort();const controller=new AbortController();searchRequest.current=controller;
    const match=searchResources(snapshot,key,1)[0],scope=snapshot.hierarchy.find(n=>searchKey(`${n.name} ${n.nativeId}`).includes(key));
    if(match){focusResource(match);return;}if(scope){openTab(scope.id);setQuery('');return;}
    try{const response=await fetch(`/api/resources?${new URLSearchParams({scenario,q:key,limit:'1'})}`,{signal:controller.signal});if(!response.ok)throw new Error('검색하지 못했습니다.');const result=ResourcePage.parse(await response.json());if(controller.signal.aborted)return;if(result.rows[0])await openRemote(result.rows[0].id,controller.signal);else setToast('검색 결과가 없습니다.');}
    catch(e){if(!controller.signal.aborted)setToast(e instanceof Error?e.message:'검색하지 못했습니다.');}
  };

  const resource=selected?byId.get(selected):undefined;
  useEffect(()=>{if(resource)track('open',resource.name);},[resource,track]);
  const edgeKinds=new Set(topology.edges.map(e=>e.kind)),hasFlows=!!snapshot?.links.some(l=>l.kind==='simulation'),live=snapshot?.mode==='live';
  const crumbs=index&&active!==ALL?(active.startsWith('provider:')?[{id:active,name:providerNames[active.slice(9)]}]:[{id:`provider:${index.nodes.get(active)?.provider}`,name:providerNames[index.nodes.get(active)?.provider??'']},...index.pathTo(active)]):[];
  const stats=useMemo(()=>{const real=snapshot?.resources.filter(r=>r.kind!=='firewall'&&r.kind!=='subnet')??[];return{stopped:real.filter(r=>health(r.status)==='stopped').length,warn:real.filter(r=>health(r.status)==='warn').length};},[snapshot]);
  const scopePath=resource&&index?index.pathTo(`${resource.provider}:scope:${resource.scope}`):[];
  const panel=!snapshot||view!=='map'?null:trace?<PathPanel snapshot={snapshot} from={trace.from} to={trace.to} path={path} activeHop={activeHop} picking={picking} onPick={setPicking} onChange={changeTrace} onSelect={focusHop} onClose={()=>{setTrace(null);setPicking(null);setActiveHop(null);}}/>:impact&&impactResult?<ImpactPanel snapshot={snapshot} id={impact} lost={impactResult.lost} onSelect={selectById} onClose={()=>setImpact(null)}/>:edge?<EdgeDetail bundle={edge} snapshot={snapshot} onSelect={id=>{setEdge(null);setSelected(id)}} onClose={()=>setEdge(null)}/>:resource?<ResourceDetail resource={resource} snapshot={snapshot} onSelect={selectById} onClose={()=>setSelected(null)} onTrace={startTrace} onImpact={startImpact} canImpact={ingressIds(snapshot.resources).length>0} scopePath={scopePath} onOpenScope={openTab}/>:null;
  const sidebar=index&&snapshot&&sideOpen&&<aside className="sidebar side-toggle-hide" aria-label="관리 범위 탐색"><div className="side-head">관리 범위<button className="icon-button" onClick={()=>setSideOpen(false)} aria-label="범위 패널 접기"><PanelLeftClose size={16}/></button></div><div className="side-scroll"><ScopePanel snapshot={snapshot} index={index} active={active} allLabel="전체 지도" onPick={openTab}/></div></aside>;
  const toolbar=snapshot&&<div className="bar-tools"><button className={`tool ${!accessLayer?'on':''}`} aria-pressed={!accessLayer} onClick={()=>setAccessLayer(false)}>네트워크 관계</button><button className={`tool ${accessLayer?'on':''}`} aria-pressed={accessLayer} onClick={()=>setAccessLayer(true)}>접근 관계</button>{!accessLayer&&<><button className={`tool ${workloads?'on':''}`} aria-pressed={workloads} onClick={()=>{setWorkloads(!workloads);pendingFit.current={};}} title="기본은 네트워크 구조입니다. VM·데이터베이스 등 나머지 자원을 함께 표시합니다.">워크로드</button><span className="bar-label">상세</span><div className="segmented" role="group" aria-label="상세 수준">{LEVELS.map((l,i)=><button key={l} className={level===i?'active':''} aria-pressed={level===i} onClick={()=>applyLevel(snapshot,i)}>{l}</button>)}</div><span className="tool-sep"/>{([['network','네트워크 경로'],['traffic','진입·로드밸런싱'],['external','외부·사내망'],['reference','구성 참조']] as const).map(([id,label])=><button key={id} className={`tool ${layers.has(id)?'on':''}`} aria-pressed={layers.has(id)} onClick={()=>setLayers(old=>{const next=new Set(old);if(next.has(id))next.delete(id);else next.add(id);return next;})}>{label}</button>)}<button className={`tool ${policy?'on':''}`} aria-pressed={policy} onClick={()=>setPolicy(!policy)} title="NSG·보안 그룹·방화벽 규칙을 적용 관계로 표시"><ShieldCheck size={14}/>정책</button>{hasFlows&&<button className={`tool ${flow?'on':''}`} aria-pressed={flow} disabled={live} title={live?'실제 로그 연동 전입니다.':'시연용 트래픽 표시'} onClick={()=>setFlow(!flow)}><Waypoints size={14}/>트래픽</button>}{flow&&hasFlows&&<button className="tool icon" onClick={()=>setPlaying(!playing)} aria-label={playing?'트래픽 일시정지':'트래픽 재생'}>{playing?<Pause size={12}/>:<Play size={12}/>}</button>}<span className="tool-sep"/><button className={`tool ${trace?'on':''}`} aria-pressed={!!trace} onClick={()=>{if(trace)setTrace(null);else{const start=selected&&byId.get(selected)?.kind!=='firewall'?selected:snapshot.resources.find(r=>r.kind==='compute'&&health(r.status)==='ok'&&inFocus(r))?.id??snapshot.resources.find(r=>r.kind==='compute')?.id??snapshot.resources[0]?.id;if(start)startTrace(start);}}}><Route size={14}/>경로 추적</button><details className="legend-pop menu-pop"><summary>범례</summary><div className="legend">{edgeKinds.has('hybrid')&&<span><i className="line hybrid"/>전용선·VPN</span>}{edgeKinds.has('peering')&&<span><i className="line peering"/>피어링</span>}{edgeKinds.has('attachment')&&<span><i className="line attachment"/>연결</span>}{policy&&<span><i className="line policy"/>정책 적용</span>}{flow&&hasFlows&&<span><i className="line flow"/>시연 트래픽</span>}{stats.warn>0&&<span><AlertTriangle size={12} className="ico-warn"/>이상</span>}{stats.stopped>0&&<span><CircleOff size={12}/>중지</span>}</div></details>{layingOut&&<span className="tool-busy" role="status"><RefreshCw size={13} className="spin"/>배치 중</span>}</>}</div>;
  const list=useMemo(()=>snapshot?findings(snapshot,undefined,focus):[],[snapshot,focus]);
  const openFinding=(f:Finding)=>{if(!f.target)return;if(f.target.view==='map'&&f.target.id){selectById(f.target.id);return;}changeView(f.target.view);};
  const goTo=(v:View)=>changeView(v);
  const saveCsv=(content:string,name:string)=>{track('export',view,name);const url=URL.createObjectURL(new Blob(['\ufeff'+content],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setToast('CSV를 내보냈습니다.');};
  const problems=collect?Object.values(collect.providers).filter(p=>p.state==='failed'||p.state==='unauthenticated'||p.state==='partial').length:0;
  const closeGuide=()=>{markGuideSeen();setDialog(false);setFirstGuide(false);};
  const body=needsLogin?<Login onDone={()=>load()}/>:onboarding?<Onboarding state={collect} onCollect={()=>startCollect(initialCollection)} onGuide={()=>setDialog(true)}/>:error&&!ready?<div className="load-state" role="alert"><AlertTriangle size={30}/><h2>데이터를 불러오지 못했습니다</h2><p>{error}</p><button className="button" onClick={()=>load()}>다시 시도</button></div>:!snapshot||!index||!ready?<div className="skeleton" role="status"><RefreshCw className="spin"/>인프라 데이터를 불러오는 중입니다.</div>:SCOPE_BAR_VIEWS.includes(view)?<><ScopeBar snapshot={snapshot} index={index} active={active} focus={focus} label={active===ALL?'전체 범위':tabLabel(index,active)} onPick={selectScope} onHome={()=>changeView('scopes')}/><div className="page-host">{view==='dashboard'?<Dashboard snapshot={snapshot} focus={focus} list={list} go={goTo} openFinding={openFinding}/>:view==='findings'?<FindingsPage list={list} mock={snapshot.mode==='mock'} openFinding={openFinding}/>:view==='changes'?<ChangesPage snapshot={snapshot} focus={focus} openResource={selectById}/>:view==='cost'?<CostPage snapshot={snapshot} focus={focus} onScope={selectScope} onCsv={saveCsv}/>:view==='iam'?<IamPage snapshot={snapshot} focus={focus} list={list} openFinding={openFinding}/>:view==='inventory'?<Suspense fallback={<div className="skeleton" role="status"><RefreshCw className="spin"/>리소스 화면을 불러오는 중입니다.</div>}><ResourcesPage snapshot={snapshot} focus={focus} query={settledQuery} onOpen={openResource} preferences={preferences}/></Suspense>:view==='audit'?<AuditPage snapshot={snapshot} focus={focus} openResource={selectById} onCsv={saveCsv}/>:view==='security'?<SecurityPage snapshot={snapshot} focus={focus} openResource={selectById}/>:<NetworkPage snapshot={snapshot} focus={focus} openResource={selectById}/>}</div></>:view==='scopes'?<ScopeHome snapshot={snapshot} index={index} onOpen={openTab} onConnect={()=>setDialog(true)} onSelectResource={selectById}/>:<div className="work">{sidebar}<main className="stage">
      <div className="map-tabs" role="tablist" aria-label="열린 범위">{!sideOpen&&<button className="icon-button side-toggle-hide" onClick={()=>setSideOpen(true)} aria-label="범위 패널 펼치기"><PanelLeft size={16}/></button>}{tabs.map(t=>{const node=index.nodes.get(t);return <div key={t} className={`map-tab ${t===active?'active':''}`}><button role="tab" aria-selected={t===active} onClick={()=>{if(t!==active)openTab(t)}} title={tabLabel(index,t)}>{t===ALL?<Layers3 size={14}/>:t.startsWith('provider:')?<ProviderMark provider={t.slice(9)}/>:node&&<ScopeIcon node={node} size={15}/>}<span>{tabLabel(index,t)}</span></button>{t!==ALL&&<button className="tab-close" onClick={()=>closeTab(t)} aria-label={`${tabLabel(index,t)} 탭 닫기`}><X size={13}/></button>}</div>})}</div>
      <div className="map-bar"><nav className="crumbs" aria-label="현재 범위"><button onClick={()=>changeView('scopes')}>관리 범위</button>{crumbs.length===0&&<><ChevronRight size={13}/><span aria-current="page" className="crumb-now">전체 지도</span></>}{crumbs.map((c,i)=><span key={c.id} style={{display:'contents'}}><ChevronRight size={13}/><button aria-current={i===crumbs.length-1?'page':undefined} onClick={()=>openTab(c.id)}>{c.name}</button></span>)}</nav>{view==='map'&&toolbar}</div>
      <CollectionNotice snapshot={snapshot} focus={focus}/>
      {!!topology.budgetCollapsed&&!accessLayer&&<p className="map-workload-note" role="status">가독성을 위해 {topology.budgetCollapsed}개 묶음을 접었습니다. 범위를 좁히거나 묶음을 펼쳐 상세 자원을 확인하세요.</p>}
      {workloads&&!accessLayer&&<p className="map-workload-note" role="status">워크로드는 서브넷·종류별 묶음으로 열립니다. 묶음을 클릭해 펼칠 수 있습니다. 지도 밖 자원 {isolatedWorkloads(snapshot).filter(r=>inFocus(r)).length}개는 리소스 목록에서 확인할 수 있습니다.</p>}
      {accessLayer?<AccessRelations snapshot={snapshot} focus={focus} selected={selected} onSelect={id=>{setSelected(id||null);setTrace(null);setEdge(null);}}/>:<div ref={canvasRef} className={`canvas ${farOut?'lod-far':''} ${picking?'is-picking':''}`} onKeyDown={onCanvasKey}><ReactFlow nodes={decorated.nodes} edges={decorated.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodeClick={onNodeClick} onNodeDoubleClick={onNodeDoubleClick} onEdgeClick={(_,e)=>{setEdge(e.data!.bundle);setSelected(null);setImpact(null);setTrace(null);}} onPaneClick={()=>{if(!picking)clearModes();}} minZoom={.03} maxZoom={1.8} nodesConnectable={false} nodesDraggable={false} edgesReconnectable={false} elevateNodesOnSelect={false} elevateEdgesOnSelect={false} zoomOnDoubleClick={false} onlyRenderVisibleElements={decorated.nodes.length>200} deleteKeyCode={null} proOptions={{hideAttribution:true}}>
        <svg className="edge-defs" aria-hidden="true"><defs><marker id="atlas-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1 L7,4 L1,7" fill="none" stroke="context-stroke" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></marker></defs></svg>
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--grid)"/>
        {decorated.nodes.length>25&&<MiniMap nodeColor={n=>(n as FlowNode).type==='frame'?'transparent':'var(--mini)'} nodeStrokeColor={n=>(n as FlowNode).type==='frame'?'var(--mini-frame)':'transparent'} maskColor="var(--mini-mask)" pannable zoomable position="bottom-right"/>}
        <Panel position="bottom-left"><div className="zoom-controls"><button onClick={()=>rf.zoomIn({duration:200})} aria-label="확대"><Plus size={15}/></button><button onClick={()=>rf.zoomOut({duration:200})} aria-label="축소"><Minus size={15}/></button><button onClick={()=>rf.fitView({padding:FIT_PADDING,duration:300,maxZoom:1})} aria-label="전체 보기"><Scan size={15}/></button></div></Panel>
      </ReactFlow>{!decorated.nodes.length&&!loading&&!layingOut&&<div className="canvas-empty"><div><p>{networkEmptyMessage(snapshot,focus)}</p><button className="button" onClick={()=>setDialog(true)}><Plug size={14}/>연결 방법 보기</button></div></div>}</div>}
    </main><div className="panel-host open">{panel}</div></div>;
  return <div className="app"><header className="topbar"><a className="brand" href="/" aria-label="Cloud Atlas 처음으로"><span className="brand-symbol"><Waypoints size={17}/></span>Cloud Atlas</a>
    {!live&&!onboarding&&<label className="scenario"><span>예시</span><select aria-label="예시 아키텍처" value={scenario} onChange={e=>changeScenario(e.target.value as ScenarioId)}>{['단순','표준','복잡'].map(g=><optgroup key={g} label={g}>{scenarios.filter(x=>x.group===g).map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>)}</select></label>}
    <div className="search"><Search size={15}/><input ref={searchRef} aria-label="리소스와 범위 검색" placeholder="자원, IP, 구독 찾기  ( / )" value={query} onFocus={()=>setSearchOpen(true)} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} onChange={e=>{searchRequest.current?.abort();setQuery(e.target.value);setSearchOpen(true)}} onKeyDown={e=>{if(e.key==='Escape'){setQuery('');e.currentTarget.blur();}if(e.key==='Enter'&&!e.nativeEvent.isComposing&&!composing)void searchNow();}}/>{query&&<button aria-label="검색 지우기" onClick={()=>setQuery('')}><X size={13}/></button>}{q===searchKey(query)&&q&&searchOpen&&!composing&&view!=='inventory'&&<div className="search-results">{scopeMatches.map(n=><button key={n.id} onClick={()=>{openTab(n.id);setQuery('')}}><ScopeIcon node={n} size={20}/><span>{n.name}<small>{providerNames[n.provider]} · {hierarchyNouns[n.kind]} · 토폴로지 열기</small></span></button>)}{matches.slice(0,10).map(r=><button key={r.id} onClick={()=>focusResource(r)}><ResourceIcon resource={r} size={20}/><span>{r.name}<small>{providerNames[r.provider]} · {kindNames[r.kind]}{r.ip?` · ${r.ip}`:''}</small></span></button>)}{!snapshot?.resources.length&&remoteSearch.query===q&&remoteSearch.rows.map(r=><button key={r.id} onClick={()=>openRemote(r.id)}><Search size={20}/><span>{r.name}<small>{providerNames[r.provider]} · {kindNames[r.kind]}</small></span></button>)}{!matches.length&&!scopeMatches.length&&(snapshot?.resources.length||remoteSearch.query===q&&!remoteSearch.rows.length)?<p>검색 결과가 없습니다.</p>:null}</div>}</div>
    <div className="topbar-right"><span className={`mode-pill ${live?'live':''}`}><i/>{live?'실제 수집 스냅샷':onboarding?'실제 데이터 준비 중':'목데이터'}</span>{live&&collect?.enabled&&<details className="menu-pop collect-menu"><summary className="button" aria-label={collect.running?`수집 중 ${percent(collect)}%, 진행 상황 보기`:'수집 상태 보기'}><RefreshCw size={14} className={collect.running?'spin':''}/><span>{collect.running?`수집 중 ${percent(collect)}%`:problems?`수집 상태 · 확인 ${problems}`:'수집 상태'}</span></summary><div className="collect-pop"><CollectionPicker running={collect.running} records={snapshot?.itemCollection??[]} onCollect={startCollect}/><CollectProgress state={collect} onGuide={()=>setDialog(true)}/><button className="button primary collect-now" onClick={()=>startCollect()} disabled={collect.running}><RefreshCw size={14} className={collect.running?'spin':''}/>{collect.running?'수집 중':'지금 수집'}</button></div></details>}<button className="icon-button" onClick={()=>load()} disabled={loading} aria-label="데이터 새로고침" title="데이터 새로고침"><RefreshCw size={15} className={loading?'spin':''}/></button><details className="menu-pop export-menu"><summary className="icon-button" aria-label="내보내기" title="내보내기"><Download size={15}/></summary><div className="menu-list"><button disabled={!snapshot} onClick={()=>runExport(async()=>{const response=await fetch(`/api/topology?scenario=${scenario}&part=full`);if(!response.ok)throw new Error('스냅샷 내보내기 요청 실패');downloadJson(validateSnapshot(await response.json()),fileBase);})}><FileJson size={14}/>스냅샷 JSON</button><button disabled={view!=='map'||!topology.nodes.length} onClick={()=>runExport(()=>downloadPng(topology,fileBase))}><Image size={14}/>지도 PNG</button><button disabled={view!=='map'||!topology.nodes.length} onClick={()=>runExport(()=>downloadSvg(topology,fileBase))}><Image size={14}/>지도 SVG</button><button disabled={view!=='map'||!topology.nodes.length} onClick={()=>runExport(()=>downloadDrawio(topology,fileBase))}><FileCode2 size={14}/>draw.io</button>{view!=='map'&&<p>PNG와 draw.io는 연결 지도에서 내보낼 수 있습니다.</p>}</div></details>{session.required&&<button className="icon-button" onClick={logout} aria-label={`${session.name??''} 로그아웃`} title="로그아웃"><LogOut size={15}/></button>}<button className="button primary" onClick={()=>setDialog(true)}><Plug size={14}/><span>클라우드 연결</span></button></div></header>
  {live&&collect?.running&&<div className="collect-line"><ProgressBar value={percent(collect)} label="전체 수집 진행률" active/></div>}
  <div className="body"><nav className="nav-rail" aria-label="주 메뉴">{NAV.map(([group,items])=><div className="nav-group" role="group" aria-label={group} key={group}>{items.length>1&&<span className="nav-group-label">{group}</span>}{items.map(([k,Icon,l])=><button key={k} className={view===k?'active':''} aria-current={view===k?'page':undefined} onClick={()=>changeView(k)}><Icon size={18}/><span>{l}</span></button>)}</div>)}</nav><div className="body-main" aria-busy={loading}>{ready&&loading&&<div className="refresh-notice" role="status">데이터를 갱신하고 있습니다.</div>}{ready&&error&&<div className="notice warn" role="alert">{error} · 이전 데이터를 표시합니다. <button className="button" onClick={()=>load()}>다시 시도</button></div>}<Suspense fallback={<div className="skeleton" role="status">화면을 불러오는 중입니다.</div>}>{body}</Suspense></div></div>
  {dialog&&<ConnectGuide close={closeGuide} firstVisit={firstGuide}/>}{toast&&<div className="toast" role="status"><Check size={15}/>{toast}</div>}</div>;
}
export default function App(){return <ReactFlowProvider><Workspace/></ReactFlowProvider>}
