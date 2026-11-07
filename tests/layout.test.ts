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

const view=async(v:'network'|'security'|'storage'|'identity'|'kubernetes',expanded?:Set<string>)=>{const s=validateSnapshot(JSON.parse(JSON.stringify(await mockSnapshot('standard'))));return computeTopology(s,{provider:'all',scopes:null,policy:false,flow:false,expanded:expanded??defaultExpanded(s,1),view:v});};
test('13. switching to the security, storage or identity view never moves the network',async()=>{
  const base=await view('network'),where=new Map(base.nodes.map(n=>[n.id,`${n.x},${n.y},${n.width},${n.height}`]));
  for(const v of ['security','storage','identity'] as const){
    const t=await view(v);
    for(const n of t.nodes)if(where.has(n.id))assert.equal(`${n.x},${n.y},${n.width},${n.height}`,where.get(n.id),`${v}: ${n.id} moved`);
    assert.ok(t.nodes.length>base.nodes.length,`${v} adds its column`);
  }
});
test('policies are a column of their own in the security view, never a node inside a network',async()=>{
  const t=await view('security'),policies=t.nodes.filter(n=>n.item.resource?.kind==='firewall');
  assert.ok(policies.length>0);assert.ok(policies.every(n=>n.item.parent?.startsWith('column:security:')));
  assert.ok(!(await view('network')).nodes.some(n=>n.item.resource?.kind==='firewall'));
});
test('the Kubernetes view opens namespaces but keeps pods folded inside their workloads',async()=>{
  const t=await view('kubernetes',new Set());
  assert.ok(t.nodes.some(n=>n.item.variant==='cluster'));assert.ok(t.nodes.some(n=>n.item.variant==='namespace'&&!n.collapsed));
  const workloads=t.nodes.filter(n=>n.item.variant==='workload');assert.ok(workloads.length>0&&workloads.every(n=>n.collapsed));
  assert.ok(!t.nodes.some(n=>n.item.resource?.kind==='pod'&&n.item.parent&&t.nodes.find(w=>w.id===n.item.parent)?.item.variant==='workload'),'no owned pod is drawn until its workload opens');
  const opened=await view('kubernetes',new Set(workloads.map(w=>w.id)));assert.ok(opened.nodes.some(n=>n.item.resource?.kind==='pod'));
  assert.ok(t.edges.some(e=>!e.overlay&&e.links.some(l=>l.kind==='forwards_to')),'service relations are drawn');
});
