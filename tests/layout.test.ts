import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import {mockSnapshot} from '../server/mock.ts';
import {validateSnapshot} from '../shared/schema.ts';
import {computeTopology,defaultExpanded,setLayoutEngine,type Topology} from '../src/layout.ts';
setLayoutEngine(new (ELK as any)());
const layout=async(scenario:'standard'|'enterprise',level:number,flow=false)=>{const s=validateSnapshot(JSON.parse(JSON.stringify(await mockSnapshot(scenario))));return computeTopology(s,{provider:'all',scopes:null,policy:false,flow,expanded:defaultExpanded(s,level)});};
const box=(t:Topology)=>{const r=Math.max(...t.nodes.map(n=>n.x+n.width)),b=Math.max(...t.nodes.map(n=>n.y+n.height));return{width:r-Math.min(...t.nodes.map(n=>n.x)),height:b-Math.min(...t.nodes.map(n=>n.y))};};
// Siblings never overlap: a node only shares space with its own ancestors.
function overlaps(t:Topology){
  const byId=new Map(t.nodes.map(n=>[n.id,n])),bad:string[]=[];
  const related=(a:string,b:string)=>{for(let p=byId.get(a)?.item.parent;p;p=byId.get(p)?.item.parent)if(p===b)return true;return false;};
  for(const a of t.nodes)for(const b of t.nodes)if(a.id<b.id&&!related(a.id,b.id)&&!related(b.id,a.id)&&a.x<b.x+b.width-1&&b.x<a.x+a.width-1&&a.y<b.y+b.height-1&&b.y<a.y+a.height-1)bad.push(`${a.id} × ${b.id}`);
  return bad;
}
for(const [scenario,level,flow] of [['standard',0,false],['standard',1,true],['standard',2,true],['enterprise',0,false],['enterprise',1,true],['enterprise',2,false]] as const)
  test(`${scenario} at level ${level}${flow?' with traffic':''}: no overlaps, every edge routed`,async()=>{
    const t=await layout(scenario,level,flow);
    assert.deepEqual(overlaps(t),[]);
    assert.ok(t.edges.every(e=>e.points.length>=2),'every edge has a route');
  });
test('a hub with many spokes lays them out as a grid, not one tall column',async()=>{
  const t=await layout('enterprise',0),trunks=t.edges.filter(e=>e.trunk);
  assert.ok(trunks.length>=8,`spokes fed through lanes (${trunks.length})`);
  const spokes=new Set(trunks.map(e=>e.target)),xs=new Set(t.nodes.filter(n=>spokes.has(n.id)).map(n=>Math.round(n.x)));
  assert.ok(xs.size>=2,'spokes sit in more than one column');
  for(const e of trunks)for(let i=1;i<e.points.length;i++)assert.ok(e.points[i].x===e.points[i-1].x||e.points[i].y===e.points[i-1].y,'lane routes stay orthogonal');
});
test('the whole map is not a tall sliver',async()=>{
  const {width,height}=box(await layout('enterprise',0));
  assert.ok(width/height>0.9,`aspect ${(width/height).toFixed(2)}`);
});
test('a network endpoint is a visible leaf, never a VPC or subnet boundary',async()=>{
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-10T00:00:00Z',resources:[{id:'aws:fake-endpoint',nativeId:'fake-endpoint',name:'fake-endpoint',provider:'aws',kind:'endpoint',type:'ec2:vpc-endpoint',scope:'111111111111',region:'r',source:'fake Resource Explorer'}],links:[],scopes:['111111111111'],warnings:[]});
  const topology=await computeTopology(snapshot,{provider:'all',scopes:null,policy:false,flow:false,expanded:defaultExpanded(snapshot,2)});
  const node=topology.nodes.find(n=>n.id==='aws:fake-endpoint')!;
  assert.ok(node);assert.equal(node.item.variant,undefined);assert.equal(node.expandable,false);
  assert.equal(topology.edges.length,0,'inventory classification does not invent paths');
});
test('large workload fleets start in collapsed groups and isolated inventory remains off the map',async()=>{
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-10T00:00:00Z',resources:[
    {id:'vpc',nativeId:'vpc',name:'vpc',provider:'aws',kind:'network',type:'AWS::EC2::VPC',scope:'111111111111',region:'r',source:'fake'},
    {id:'subnet',nativeId:'subnet',name:'subnet',parent:'vpc',provider:'aws',kind:'subnet',type:'AWS::EC2::Subnet',scope:'111111111111',region:'r',source:'fake'},
    ...Array.from({length:100},(_,i)=>({id:`vm-${i}`,nativeId:`vm-${i}`,name:`vm-${i}`,parent:'subnet',provider:'aws',kind:'compute',type:'AWS::EC2::Instance',scope:'111111111111',region:'r',source:'fake'})),
    {id:'isolated',nativeId:'isolated',name:'isolated',provider:'aws',kind:'service',type:'future:type',scope:'111111111111',region:'r',source:'fake'},
  ],links:[],scopes:['111111111111'],warnings:[]});
  const expanded=defaultExpanded(snapshot,2),filter={provider:'all',scopes:null,policy:false,flow:false,workloads:true,expanded};
  const grouped=await computeTopology(snapshot,filter),group=grouped.nodes.find(n=>n.item.variant==='workload')!;
  assert.ok(group);assert.equal(group.summary.total,100);assert.equal(group.collapsed,true);assert.ok(grouped.nodes.length<10);assert.ok(!grouped.nodes.some(n=>n.id==='isolated'));
  expanded.add(group.id);const opened=await computeTopology(snapshot,filter);assert.equal(opened.nodes.filter(n=>n.item.resource?.kind==='compute').length,100);
  assert.equal(opened.edges.length,0,'containment does not create workload communication edges');
});
