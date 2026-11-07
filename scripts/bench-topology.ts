// Measures the analysis and layout code on synthetic Azure-shaped estates. Numbers depend on the machine; they are a trend, not a promise.
// npx tsx scripts/bench-topology.ts [vms...]
import ELK from 'elkjs/lib/elk.bundled.js';
import {validateSnapshot,type Link} from '../shared/schema.ts';
import {restrictSnapshot} from '../server/auth.ts';
import {analyzeFlow} from '../shared/flow.ts';
import {computeTopology,defaultExpanded,setLayoutEngine} from '../src/layout.ts';
setLayoutEngine(new (ELK as any)());
function estate(vms:number){
  const R=(id:string,name:string,kind:string,scope:string,extra:object={})=>({id:`azure:${id}`,nativeId:id,name,provider:'azure',kind,type:kind,scope,region:'kc',source:'bench',...extra});
  const resources:object[]=[],links:Link[]=[],perSubnet=10,subnetsPerVnet=8,vnets=Math.max(1,Math.ceil(vms/(perSubnet*subnetsPerVnet)));
  resources.push(R('vnet/hub','hub','network','sub-0',{cidr:'10.0.0.0/16'}));
  for(let v=0;v<vnets;v++){
    const scope=`sub-${1+v%20}`,vnet=`vnet/${v}`;resources.push(R(vnet,`vnet-${v}`,'network',scope,{cidr:`10.${1+Math.floor(v/250)}.${(v%250)}.0/24`}),R(`nsg/${v}`,`nsg-${v}`,'firewall',scope,{rules:[{name:'AllowHttps',direction:'Inbound',action:'Allow',protocol:'Tcp',ports:'443',source:'10.0.0.0/8',destination:'*',priority:'100'}]}));
    links.push({id:`p${v}`,source:'azure:vnet/hub',target:`azure:${vnet}`,kind:'peering',label:'Peering',evidence:'bench',transit:true});
    for(let s=0;s<subnetsPerVnet;s++){const sn=`subnet/${v}/${s}`;resources.push(R(sn,`snet-${v}-${s}`,'subnet',scope,{parent:`azure:${vnet}`,cidr:`10.${1+Math.floor(v/250)}.${v%250}.${s*16}/28`}));links.push({id:`n${v}-${s}`,source:`azure:nsg/${v}`,target:`azure:${sn}`,kind:'policy',label:'NSG',evidence:'bench'});
      for(let k=0;k<perSubnet&&resources.length<vms*2+vnets*10;k++){const i=`${v}-${s}-${k}`,ip=`10.${1+Math.floor(v/250)}.${v%250}.${s*16+k+1}`;resources.push(R(`vm/${i}`,`vm-${i}`,'compute',scope,{parent:`azure:${sn}`,ip}),R(`nic/${i}`,`nic-${i}`,'nic',scope,{parent:`azure:${sn}`,ip}));links.push({id:`a${i}`,source:`azure:vm/${i}`,target:`azure:nic/${i}`,kind:'attachment',label:'기본 NIC',evidence:'bench'});}}
  }
  return validateSnapshot({version:1,mode:'mock',collectedAt:new Date().toISOString(),resources,links,warnings:[],scopes:[...new Set((resources as {scope:string}[]).map(r=>r.scope))]});
}
const time=async<T>(f:()=>T|Promise<T>)=>{const t=performance.now(),v=await f();return{v,ms:Math.round(performance.now()-t)};};
for(const vms of (process.argv.slice(2).map(Number).filter(Boolean).length?process.argv.slice(2).map(Number):[500,5000])){
  const built=await time(()=>estate(vms)),s=built.v,vmIds=s.resources.filter(r=>r.kind==='compute').map(r=>r.id);
  const restricted=await time(()=>restrictSnapshot(s,['sub-1']));
  const flows=await time(()=>{let n=0;for(let i=0;i<50;i++){analyzeFlow(s,{from:vmIds[(i*97)%vmIds.length],to:vmIds[(i*31+7)%vmIds.length],protocol:'tcp',port:443});n++;}return n;});
  const out=[`자원 ${s.resources.length} (VM ${vmIds.length}) · 관계 ${s.links.length}`,`  생성+검증 ${built.ms}ms · 범위 제한 ${restricted.ms}ms (${restricted.v.resources.length}개 남음) · 흐름 분석 50회 평균 ${(flows.ms/50).toFixed(1)}ms`];
  for(const level of vms<=1000?[0,1,2]:[0,1]){const t=await time(()=>computeTopology(s,{provider:'all',scopes:null,policy:false,flow:false,expanded:defaultExpanded(s,level),view:'network'}));out.push(`  레이아웃 상세 ${level}: ${t.ms}ms · 브라우저 렌더 대상 노드 ${t.v.nodes.length} · 선 ${t.v.edges.length}`);}
  console.log(out.join('\n'));
}
