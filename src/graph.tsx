import {memo} from 'react';
import {Handle,Position,BaseEdge,getSmoothStepPath,EdgeLabelRenderer,type EdgeProps,type NodeProps,type Node,type Edge} from '@xyflow/react';
import {Server,ShieldCheck,Network,Router,Building2,Box,Waypoints} from 'lucide-react';
import type {Resource,Snapshot,Link} from '../shared/schema';
export const providerNames:Record<string,string>={azure:'Microsoft Azure',aws:'Amazon Web Services',gcp:'Google Cloud',onprem:'On-premises'};
export const icons={compute:Server,firewall:ShieldCheck,network:Network,subnet:Box,gateway:Router,onprem:Building2};
export type ResourceNode=Node<{resource?:Resource;label?:string;provider:string;variant?:string;subtitle?:string},'resource'|'boundary'>;
export const CloudNode=memo(function CloudNode({data,selected}:NodeProps<ResourceNode>){const r=data.resource!,Icon=icons[r.kind];return <div className={`resource-card ${r.provider} ${selected?'is-selected':''}`}><Handle type="target" position={Position.Top}/><div className="node-top"><span className="node-icon"><Icon size={19}/></span><span className="node-kind">{r.kind==='compute'?'COMPUTE':r.kind==='firewall'?'SECURITY POLICY':r.kind==='onprem'?'CORPORATE NETWORK':'CONNECTIVITY'}</span><span className="node-dot"/></div><strong>{r.name}</strong><div className="node-bottom"><span>{r.ip??r.cidr??(r.provider==='azure'?'Azure':r.provider==='aws'?'AWS':r.provider==='gcp'?'GCP':'Seoul')}</span><span>{r.kind==='compute'?r.specs['인스턴스']:r.kind==='firewall'?`${r.rules.length} rules`:r.region}</span></div><Handle type="source" position={Position.Bottom}/></div>});
export const BoundaryNode=memo(function BoundaryNode({data,selected}:NodeProps<ResourceNode>){return <div className={`boundary ${data.variant} ${data.provider} ${selected?'is-selected':''}`}><Handle type="target" position={Position.Top}/><div className="boundary-title">{data.variant==='provider'?<span className={`provider-letter ${data.provider}`}>{data.provider==='azure'?'Az':data.provider==='aws'?'aws':'G'}</span>:<Network size={14}/>}<strong>{data.label??data.resource?.name}</strong>{data.variant!=='provider'&&<span>{data.resource?.cidr}</span>}</div>{data.subtitle&&<div className="boundary-subtitle">{data.subtitle}</div>}<Handle type="source" position={Position.Bottom}/></div>});
export function TrafficEdge(props:EdgeProps<Edge<{link:Link;playing:boolean},'traffic'>>){const [path,x,y]=getSmoothStepPath({...props,borderRadius:16,offset:24});const {link,playing}=props.data!;const policy=link.kind==='policy',sim=link.kind==='simulation';return <><BaseEdge path={path} interactionWidth={20} style={{stroke:props.selected?'#0e7164':policy?'#a6a9b5':sim?'#179786':'#8d9ca8',strokeWidth:props.selected?3:sim?2:1.5,strokeDasharray:policy?'5 5':undefined,opacity:policy?.7:1}}/>{sim&&playing&&<path d={path} className="flow-packets"/>}{(props.selected||!policy)&&<EdgeLabelRenderer><div className={`edge-label nodrag nopan ${sim?'simulation':''}`} style={{transform:`translate(-50%,-50%) translate(${x}px,${y}px)`}}>{link.label}{props.selected&&link.ports&&<span> · {link.ports}</span>}</div></EdgeLabelRenderer>}</>}
export function layout(snapshot:Snapshot,provider:string,scope:string,showPolicy:boolean,showFlow:boolean,playing:boolean,selected:string|null){
  let resources=snapshot.resources.filter(r=>(provider==='all'||r.provider===provider||r.provider==='onprem')&&(scope==='all'||r.scope===scope||r.provider==='onprem'));
  const nodes:ResourceNode[]=[],edges:Edge<{link:Link;playing:boolean},'traffic'>[]=[];let lane=0;
  for(const p of ['azure','aws','gcp']){
    const list=resources.filter(r=>r.provider===p);if(!list.length)continue;
    const width=420,groupId=`group:${p}`,networks=list.filter(r=>r.kind==='network');
    const loose=list.filter(r=>r.kind!=='network'&&r.kind!=='subnet'&&!r.parent);
    const looseRows=Math.ceil(loose.length/2),networkStart=84+looseRows*132;
    let netY=networkStart;
    const inner:ResourceNode[]=[];
    loose.forEach((r,i)=>inner.push({id:r.id,type:'resource',parentId:groupId,position:{x:22+(i%2)*196,y:78+Math.floor(i/2)*132},data:{resource:r,provider:p},selected:r.id===selected,style:{width:180},draggable:false}));
    for(const net of networks){
      const subnets=list.filter(r=>r.kind==='subnet'&&r.parent===net.id),direct=list.filter(r=>r.parent===net.id&&r.kind!=='subnet');
      const directRows=Math.ceil(direct.length/2);let subY=55+directRows*130;
      const netChildren:ResourceNode[]=[];
      direct.forEach((r,i)=>netChildren.push({id:r.id,type:'resource',parentId:net.id,position:{x:14+(i%2)*184,y:55+Math.floor(i/2)*130},data:{resource:r,provider:p},selected:r.id===selected,style:{width:170},draggable:false}));
      for(const sub of subnets){
        const children=list.filter(r=>r.parent===sub.id),h=58+Math.max(1,Math.ceil(children.length/2))*128;
        netChildren.push({id:sub.id,type:'boundary',parentId:net.id,position:{x:14,y:subY},data:{resource:sub,provider:p,variant:'subnet'},selected:sub.id===selected,style:{width:352,height:h},draggable:false});
        children.forEach((r,i)=>netChildren.push({id:r.id,type:'resource',parentId:sub.id,position:{x:12+(i%2)*168,y:48+Math.floor(i/2)*128},data:{resource:r,provider:p},selected:r.id===selected,style:{width:158},draggable:false}));subY+=h+14;
      }
      const h=Math.max(160,subY+10);inner.push({id:net.id,type:'boundary',parentId:groupId,position:{x:20,y:netY},data:{resource:net,provider:p,variant:'network'},selected:net.id===selected,style:{width:380,height:h},draggable:false},...netChildren);netY+=h+22;
    }
    nodes.push({id:groupId,type:'boundary',position:{x:lane*470,y:180},data:{provider:p,variant:'provider',label:providerNames[p],subtitle:p==='azure'?'구독 · platform-prod':p==='aws'?'계정 · commerce-prod':'프로젝트 · analytics-prod'},style:{width,height:Math.max(250,netY)},selectable:false,draggable:false},...inner);
    if(snapshot.mode==='live')nodes[nodes.length-inner.length-1].data.subtitle=`${new Set(list.map(r=>r.scope)).size}개 범위 · ${list.length}개 자원`;
    lane++;
  }
  const onprem=resources.find(r=>r.kind==='onprem');if(onprem&&lane)nodes.unshift({id:onprem.id,type:'resource',position:{x:((lane-1)*470+420)/2-120,y:0},data:{provider:'onprem',resource:onprem},selected:selected===onprem.id,style:{width:240},draggable:false});
  const ids=new Set(nodes.map(n=>n.id));
  for(const link of snapshot.links){if(!ids.has(link.source)||!ids.has(link.target)||(!showPolicy&&link.kind==='policy')||(!showFlow&&link.kind==='simulation'))continue;edges.push({id:link.id,source:link.source,target:link.target,type:'traffic',data:{link,playing},selected:selected===link.id,zIndex:link.kind==='simulation'?5:1,focusable:true,ariaLabel:`${link.label} 연결 상세`});}
  return{nodes,edges};
}
