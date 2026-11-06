import {memo} from 'react';
import {Handle,Position,EdgeLabelRenderer,type EdgeProps,type NodeProps,type Node,type Edge} from '@xyflow/react';
import {Server,ShieldCheck,Network,Router,Building2,Rows3,Flame,Split,Database,Boxes,ArrowLeftRight,CircleHelp,HardDrive,Globe2,ChevronDown,ChevronRight,AlertTriangle,CircleOff,Cable,Disc,FolderOpen,Archive,Plug,Fingerprint,Cpu,FolderTree,Layers,Box,Waypoints,DoorOpen,UserCog,FileBox,Database as Volume} from 'lucide-react';
import type {Resource,ResourceKind} from '../shared/schema';
import {health} from '../shared/topology';
import {groupIcon,iconKey,providerLogo} from '../shared/iconKeys';
import {iconUrl} from './icons';
import type {Bundle,Placed} from './layout';
export const icons:Record<ResourceKind,typeof Server>={compute:Server,firewall:ShieldCheck,appliance:Flame,network:Network,subnet:Rows3,gateway:Router,loadbalancer:Split,nat:ArrowLeftRight,database:Database,storage:HardDrive,cluster:Boxes,onprem:Building2,external:CircleHelp,service:Boxes,nic:Cable,disk:Disc,fileshare:FolderOpen,bucket:Archive,endpoint:Plug,identity:Fingerprint,node:Cpu,namespace:FolderTree,workload:Layers,pod:Box,k8sservice:Waypoints,ingress:DoorOpen,serviceaccount:UserCog,pvc:FileBox,pv:Volume};
export const kindNames:Record<ResourceKind,string>={compute:'VM',firewall:'보안 정책',appliance:'방화벽',network:'네트워크',subnet:'서브넷',gateway:'게이트웨이',loadbalancer:'로드밸런서',nat:'NAT',database:'데이터베이스',storage:'스토리지',cluster:'클러스터',onprem:'사내망',external:'외부 참조',service:'기타 서비스',nic:'NIC',disk:'디스크',fileshare:'파일 공유',bucket:'객체 스토리지',endpoint:'엔드포인트',identity:'실행 신원',node:'K8s 노드',namespace:'네임스페이스',workload:'워크로드',pod:'Pod',k8sservice:'K8s Service',ingress:'Ingress',serviceaccount:'ServiceAccount',pvc:'PVC',pv:'PV'};
export const ProviderMark=({provider}:{provider:string})=>{const logo=iconUrl(providerLogo[provider]);return logo?<img className={`provider-logo ${provider}`} src={logo} alt="" aria-hidden="true"/>:<span className={`provider-mark ${provider}`} aria-hidden="true">{provider==='gcp'?'G':'DC'}</span>;};
export function ResourceIcon({resource,size=28}:{resource:Pick<Resource,'type'|'specs'|'kind'>;size?:number}){
  const url=iconUrl(iconKey(resource));if(url)return <img className="csp-icon" src={url} width={size} height={size} alt="" aria-hidden="true" draggable={false}/>;
  const Glyph=icons[resource.kind];return <span className="glyph-icon" style={{width:size,height:size}}><Glyph size={Math.round(size*.58)}/></span>;
}
export type Emphasis='normal'|'dim'|'focus'|'path'|'impact'|'removed';
export type NodeData=Placed&{emphasis:Emphasis;scopeLabel?:string;onToggle:(id:string)=>void};
export type FlowNode=Node<NodeData,'resource'|'frame'|'summary'>;
export function cardSubtitle(r:Resource){
  const size=r.specs['인스턴스']?.replace('Standard_','');
  if(r.kind==='compute')return [r.ip,size].filter(Boolean).join(' · ');
  if(r.kind==='external')return '조회 권한 없음';
  return r.ip??r.cidr??r.specs['종류']??r.type;
}
const Handles=()=><><Handle type="target" position={Position.Left} isConnectable={false}/><Handle type="source" position={Position.Right} isConnectable={false}/></>;
export const ResourceNode=memo(function ResourceNode({data}:NodeProps<FlowNode>){
  const r=data.item.resource!;
  return <div className={`rc ${r.provider} kind-${r.kind} h-${health(r.status)} e-${data.emphasis}`} title={`${r.name} · ${r.status}`}><Handles/>
    <ResourceIcon resource={r}/>
    <span className="rc-body"><strong>{r.name}</strong><small className={r.ip||r.cidr?'mono':''}>{cardSubtitle(r)}</small></span>
    <span className="rc-state">{health(r.status)==='warn'?<AlertTriangle size={13}/>:<i/>}{r.publicIp&&<span className="rc-public" title={`공인 IP ${r.publicIp}`}><Globe2 size={11}/></span>}{data.policies>0&&<span className="rc-policy" title={`적용된 보안 정책 ${data.policies}개`}><ShieldCheck size={10}/>{data.policies}</span>}</span>
  </div>;
});
const variantIcon={provider:null,region:Globe2,network:Network,subnet:Rows3,managed:Database};
function Title({data,open}:{data:NodeData;open:boolean}){
  const it=data.item,Icon=it.variant&&variantIcon[it.variant],official=it.variant&&iconUrl(groupIcon[it.provider]?.[it.variant]);
  return <div className="frame-title">
    {data.expandable&&<button className="chevron nodrag" aria-label={`${it.label} ${open?'접기':'펼치기'}`} aria-expanded={open} onClick={e=>{e.stopPropagation();data.onToggle(data.id)}}>{open?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>}
    {it.variant==='provider'?<ProviderMark provider={it.provider}/>:it.resource?<ResourceIcon resource={it.resource} size={18}/>:official?<img className="csp-icon" src={official} width={18} height={18} alt="" aria-hidden="true" draggable={false}/>:Icon&&<Icon size={14} className="frame-icon"/>}
    <strong title={it.label}>{it.label}</strong>
    {data.hub&&<span className="pill hub">HUB</span>}
    {it.outOfScope&&<span className="pill outside">범위 밖</span>}
    {open&&it.variant!=='provider'&&it.subtitle&&<span className={it.resource?'mono frame-sub':'frame-sub'}>{it.subtitle}</span>}
    {open&&data.scopeLabel&&<span className="pill scope" title="소유 범위. 네트워크 경계와 다를 수 있습니다.">{data.scopeLabel}</span>}
  </div>;
}
export const FrameNode=memo(function FrameNode({data}:NodeProps<FlowNode>){
  return <div className={`frame v-${data.item.variant} ${data.item.provider} e-${data.emphasis}`}><Handles/><Title data={data} open/></div>;
});
const summaryKinds:ResourceKind[]=['network','compute','cluster','database','storage','loadbalancer','appliance','gateway','nat','firewall','external'];
export const SummaryNode=memo(function SummaryNode({data}:NodeProps<FlowNode>){
  const s=data.summary,present=summaryKinds.filter(k=>s.counts[k]);
  return <div className={`summary v-${data.item.variant} ${data.item.provider} e-${data.emphasis} ${data.item.outOfScope?'is-outside':''}`}><Handles/><Title data={data} open={false}/>
    {data.item.variant!=='subnet'&&(data.item.subtitle||data.scopeLabel)&&<div className="summary-meta">{data.item.subtitle&&<span className={data.item.resource?'mono':''}>{data.item.subtitle}</span>}{data.scopeLabel&&<span className="pill scope" title="소유 범위. 네트워크 경계와 다를 수 있습니다.">{data.scopeLabel}</span>}</div>}
    {data.item.variant!=='subnet'&&<div className="summary-counts">{present.map(k=>{const Icon=icons[k];return <span key={k} title={kindNames[k]}><Icon size={12}/>{s.counts[k]}</span>})}{!present.length&&<em>{data.item.outOfScope?'소유 범위 밖 · 경로 유지':'수집된 자원 없음'}</em>}</div>}
    {data.item.variant==='subnet'&&<div className="summary-counts compact"><span className="mono">{data.item.subtitle}</span><span>{s.total?`자원 ${s.total}`:'비어 있음'}</span></div>}
    {(s.stopped>0||s.warn>0)&&<div className="summary-alerts">{s.warn>0&&<span className="warn"><AlertTriangle size={10}/>{s.warn}</span>}{s.stopped>0&&<span className="stopped"><CircleOff size={10}/>{s.stopped}</span>}</div>}
  </div>;
});
export type EdgeData={bundle:Bundle;emphasis:Emphasis;animate:boolean;showLabel:boolean};
export type FlowEdge=Edge<EdgeData,'routed'>;
function roundedPath(points:{x:number;y:number}[],radius=9){
  if(points.length<2)return '';
  let d=`M${points[0].x},${points[0].y}`;
  for(let i=1;i<points.length-1;i++){
    const p=points[i],a=points[i-1],b=points[i+1],la=Math.hypot(p.x-a.x,p.y-a.y),lb=Math.hypot(b.x-p.x,b.y-p.y),r=Math.min(radius,la/2,lb/2);
    d+=` L${p.x+(a.x-p.x)/la*r},${p.y+(a.y-p.y)/la*r} Q${p.x},${p.y} ${p.x+(b.x-p.x)/lb*r},${p.y+(b.y-p.y)/lb*r}`;
  }
  const last=points[points.length-1];return `${d} L${last.x},${last.y}`;
}
// Prefers the run into the target so labels fanning out of a hub do not stack. Only hybrid trunks sit in a gap wide enough for a label on a vertical run.
function labelPoint(points:{x:number;y:number}[],label:string,allowVertical:boolean){
  const need=label.length*7+18,run=(i:number)=>points[i+1].x-points[i].x,usable=(i:number)=>Math.abs(run(i))>=need||(allowVertical&&Math.abs(points[i+1].y-points[i].y)>=need);
  let best=points.length-2;
  if(!usable(best))for(let i=0;i<points.length-1;i++)if(usable(i)){best=i;break;}
  return{x:(points[best].x+points[best+1].x)/2,y:(points[best].y+points[best+1].y)/2,fits:usable(best)};
}
export function RoutedEdge({id,data,selected}:EdgeProps<FlowEdge>){
  const {bundle,emphasis,animate,showLabel}=data!;if(!bundle.points.length)return null;
  const d=roundedPath(bundle.points),at=labelPoint(bundle.points,bundle.label,bundle.kind==='hybrid'),cls=`edge k-${bundle.kind} e-${emphasis} ${selected?'is-selected':''}`;
  return <g className={cls}><path d={d} className="edge-hit" fill="none"/><path id={id} d={d} className="edge-line" fill="none" markerEnd={bundle.kind==='policy'?undefined:'url(#atlas-arrow)'}/>{animate&&<path d={d} className="edge-flow" fill="none"/>}
    {((showLabel&&at.fits)||selected)&&<EdgeLabelRenderer><div className={`edge-label k-${bundle.kind} e-${emphasis}`} style={{transform:`translate(-50%,-50%) translate(${at.x}px,${at.y}px)`}}>{bundle.label}</div></EdgeLabelRenderer>}
  </g>;
}
