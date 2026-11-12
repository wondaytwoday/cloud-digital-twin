import {iconKey} from '../shared/iconKeys';
import {cardSubtitle} from './graph';
import {iconUrl} from './icons';
import type {Snapshot} from '../shared/schema';
import type {Topology} from './layout';
const save=(href:string,name:string)=>{const a=document.createElement('a');a.href=href;a.download=name;a.click();};
const saveBlob=(content:string,type:string,name:string)=>{const url=URL.createObjectURL(new Blob([content],{type}));save(url,name);setTimeout(()=>URL.revokeObjectURL(url),1000);};
export const downloadJson=(snapshot:Snapshot,base:string)=>saveBlob(JSON.stringify(snapshot,null,2),'application/json',`${base}.json`);
const xml=(v:string)=>v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\n/g,'&#10;');
const providerColor:Record<string,[string,string]>={azure:['#e8f2fb','#1f6fb5'],aws:['#fdf2e2','#a85f0c'],gcp:['#e8f5ec','#2c7c4c'],onprem:['#ecEEf5','#4d5a78']};
const edgeColor:Record<string,string>={hybrid:'#0f7a68',peering:'#6a55b0',attachment:'#8996a0',policy:'#64748b',simulation:'#7ec8b7',reference:'#64748b'};
// Shapes and connections only. Editing keeps connections; product icons stay out so the file carries no CSP artwork.
export function toDrawio(topology:Topology){
  const cells=['<mxCell id="0"/>','<mxCell id="1" parent="0"/>'];
  const ordered=[...topology.nodes].sort((a,b)=>Number(!!b.item.variant&&!b.collapsed)-Number(!!a.item.variant&&!a.collapsed)||a.depth-b.depth);
  ordered.forEach(n=>{
    const [fill,stroke]=providerColor[n.item.provider]??providerColor.onprem,frame=!!n.item.variant&&!n.collapsed,label=[n.item.label,n.item.resource?.ip??n.item.subtitle,n.collapsed&&n.summary.total?`자원 ${n.summary.total}개`:undefined,n.policies?`보안 정책 ${n.policies}개`:undefined].filter(Boolean).join('\n');
    const style=frame?`rounded=1;whiteSpace=wrap;html=0;verticalAlign=top;align=left;spacingLeft=8;fillColor=${n.item.variant==='provider'?fill:'none'};strokeColor=${stroke};${n.item.variant==='subnet'||n.item.variant==='region'||n.item.variant==='scope'?'dashed=1;':''}`:`rounded=1;whiteSpace=wrap;html=0;fillColor=#ffffff;strokeColor=${stroke};`;
    cells.push(`<mxCell id="${xml(n.id)}" value="${xml(label)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${Math.round(n.x)}" y="${Math.round(n.y)}" width="${Math.round(n.width)}" height="${Math.round(n.height)}" as="geometry"/></mxCell>`);
  });
  topology.edges.forEach(e=>{
    const points=e.points.slice(1,-1).map(p=>`<mxPoint x="${Math.round(p.x)}" y="${Math.round(p.y)}"/>`).join('');
    cells.push(`<mxCell id="${xml(`edge:${e.id}`)}" value="${xml(e.kind==='hybrid'||e.kind==='peering'?e.label:'')}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;strokeColor=${edgeColor[e.kind]};${e.kind==='policy'?'dashed=1;':''}" edge="1" parent="1" source="${xml(e.source)}" target="${xml(e.target)}"><mxGeometry relative="1" as="geometry"><Array as="points">${points}</Array></mxGeometry></mxCell>`);
  });
  return `<mxfile host="cloud-atlas"><diagram name="Topology"><mxGraphModel dx="1600" dy="1000" grid="1" gridSize="10" guides="1" page="0"><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}
export const downloadDrawio=(topology:Topology,base:string)=>saveBlob(toDrawio(topology),'application/xml',`${base}.drawio`);

const MAX_PNG=8000,FONT="-apple-system,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif",PAD=32;
const ruler=document.createElement('canvas').getContext('2d')!;
function fit(text:string,max:number,font:string){
  ruler.font=font;if(ruler.measureText(text).width<=max)return text;
  let end=text.length;while(end>1&&ruler.measureText(`${text.slice(0,end)}…`).width>max)end--;
  return `${text.slice(0,end)}…`;
}
// Small icons are already inlined by the bundler, and the CSP rightly refuses to fetch data: URLs.
const dataUrl=async(url:string)=>{if(url.startsWith('data:'))return url;const blob=await (await fetch(url)).blob();return new Promise<string>(done=>{const r=new FileReader();r.onload=()=>done(String(r.result));r.readAsDataURL(blob);});};
function roundedPath(points:{x:number;y:number}[],radius=9){
  let d=`M${points[0].x},${points[0].y}`;
  for(let i=1;i<points.length-1;i++){const p=points[i],a=points[i-1],b=points[i+1],la=Math.hypot(p.x-a.x,p.y-a.y)||1,lb=Math.hypot(b.x-p.x,b.y-p.y)||1,r=Math.min(radius,la/2,lb/2);d+=` L${p.x+(a.x-p.x)/la*r},${p.y+(a.y-p.y)/la*r} Q${p.x},${p.y} ${p.x+(b.x-p.x)/lb*r},${p.y+(b.y-p.y)/lb*r}`;}
  const last=points[points.length-1];return `${d} L${last.x},${last.y}`;
}
// Drawn from layout data rather than captured from the DOM, so lines, text fit, and zoom state cannot differ from what the map means.
export async function toSvg(topology:Topology){
  const right=Math.max(...topology.nodes.map(n=>n.x+n.width))+PAD,bottom=Math.max(...topology.nodes.map(n=>n.y+n.height))+PAD;
  const keys=[...new Set(topology.nodes.flatMap(n=>{const k=n.item.resource&&iconKey(n.item.resource);return k?[k]:[];}))],images=new Map(await Promise.all(keys.map(async k=>[k,await dataUrl(iconUrl(k)!)] as const)));
  const parts:string[]=[`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${right+PAD}" height="${bottom+PAD}" viewBox="${-PAD} ${-PAD} ${right+PAD} ${bottom+PAD}" font-family="${FONT.replace(/"/g,'')}"><rect x="${-PAD}" y="${-PAD}" width="${right+PAD}" height="${bottom+PAD}" fill="#f4f6f9"/><defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M1,1 L7,4 L1,7" fill="none" stroke="#64748b" stroke-width="1.4"/></marker></defs>`];
  const text=(x:number,y:number,value:string,size:number,weight:number,color:string,max:number)=>`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${xml(fit(value,max,`${weight} ${size}px ${FONT}`))}</text>`;
  const framed=(n:Topology['nodes'][number])=>!!n.item.variant&&!n.collapsed;
  for(const n of [...topology.nodes].filter(framed).sort((a,b)=>a.depth-b.depth)){
    const [fill,stroke]=providerColor[n.item.provider]??providerColor.onprem,provider=n.item.variant==='provider',dashed=n.item.variant==='subnet'||n.item.variant==='region'||n.item.variant==='scope';
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="10" fill="${provider?fill:n.item.variant==='network'?'#ffffff':'#f4f6f9'}" stroke="${stroke}" stroke-opacity="${provider?1:.45}"${dashed?' stroke-dasharray="5 4"':''}/>`,text(n.x+14,n.y+(provider?30:24),[n.item.label,n.item.subtitle].filter(Boolean).join('  '),provider?15:12.5,600,'#0f172a',n.width-28));
  }
  for(const e of topology.edges)if(e.points.length>1){
    parts.push(`<path d="${roundedPath(e.points)}" fill="none" stroke="${edgeColor[e.kind]}" stroke-width="${e.kind==='hybrid'?2.5:1.6}"${e.kind==='policy'?' stroke-dasharray="4 4"':''}${e.kind==='policy'?'':' marker-end="url(#arrow)"'}/>`);
  }
  for(const n of topology.nodes.filter(x=>!framed(x))){
    const r=n.item.resource,[,stroke]=providerColor[n.item.provider]??providerColor.onprem,key=r&&iconKey(r),image=key?images.get(key):undefined,textX=n.x+(image?46:12),width=n.x+n.width-textX-10;
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="#ffffff" stroke="${stroke}" stroke-opacity=".55"/>`);
    if(image)parts.push(`<image x="${n.x+10}" y="${n.y+n.height/2-14}" width="28" height="28" href="${image}" xlink:href="${image}"/>`);
    parts.push(text(textX,n.y+(n.height>70?30:26),n.item.label,12.5,600,'#0f172a',width),text(textX,n.y+(n.height>70?48:43),r?cardSubtitle(r)??'':n.item.subtitle??'',11,400,'#475569',width));
  }
  for(const n of topology.nodes){
    if(n.collapsed&&n.summary.total&&n.height>70)parts.push(text(n.x+12,n.y+68,`자원 ${n.summary.total}개`,11,400,'#475569',n.width-24));
    if(n.policies)parts.push(text(n.x+n.width-88,n.y+15,`보안 정책 ${n.policies}`,10,600,'#475569',80));
  }
  for(const e of topology.edges)if((e.kind==='hybrid'||e.kind==='peering')&&e.points.length>1){
    let at=0,best=-1;e.points.slice(0,-1).forEach((p,i)=>{const q=e.points[i+1],l=Math.abs(q.x-p.x);if(l>best){best=l;at=i;}});
    const p=e.points[at],q=e.points[at+1],w=Math.min(ruler.measureText(e.label).width+12,Math.max(best,0));
    if(best>=e.label.length*6+16)parts.push(`<rect x="${(p.x+q.x)/2-w/2}" y="${p.y-9}" width="${w}" height="16" rx="3" fill="#ffffff" stroke="${edgeColor[e.kind]}" stroke-opacity=".4"/>`,`<text x="${(p.x+q.x)/2}" y="${p.y+3}" font-size="10.5" text-anchor="middle" fill="${edgeColor[e.kind]}">${xml(e.label)}</text>`);
  }
  parts.push('</svg>');
  return{svg:parts.join(''),width:right+PAD,height:bottom+PAD};
}
export async function downloadPng(topology:Topology,base:string){
  const {svg,width,height}=await toSvg(topology),scale=Math.min(2,MAX_PNG/Math.max(width,height));
  const image=new Image();await new Promise<void>((done,fail)=>{image.onload=()=>done();image.onerror=()=>fail(new Error('SVG 렌더링 실패'));image.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;});
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);
  const context=canvas.getContext('2d');if(!context)throw new Error('캔버스를 만들 수 없습니다.');
  context.scale(scale,scale);context.drawImage(image,0,0,width,height);
  save(canvas.toDataURL('image/png'),`${base}.png`);
}
export async function downloadSvg(topology:Topology,base:string){saveBlob((await toSvg(topology)).svg,'image/svg+xml',`${base}.svg`);}
