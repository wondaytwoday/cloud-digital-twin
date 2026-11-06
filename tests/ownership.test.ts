import test from 'node:test';
import assert from 'node:assert/strict';
import {mockSnapshot} from '../server/mock.ts';
import {DEFAULT_OWNERSHIP_KEYS,ownershipKeys,ownershipOf} from '../shared/ownership.ts';
import {findings} from '../shared/findings.ts';
import {restrictSnapshot} from '../server/auth.ts';
import type {Resource} from '../shared/schema.ts';

const res=(id:string,tags:Record<string,string>,parent?:string)=>({id,name:id,tags,...(parent?{parent}:{})}) as unknown as Resource;
test('owner and service come from configurable tag keys, whatever their case',()=>{
  const by=new Map<string,Resource>();
  assert.deepEqual(ownershipOf(res('a',{Owner:'net-team',SERVICE:'hub'}),by),{owner:'net-team',service:'hub'});
  assert.deepEqual(ownershipOf(res('b',{team:'  ',app:'x'}),by),{service:'x'},'a blank tag is no owner');
  const keys=ownershipKeys({ATLAS_OWNER_TAGS:'cost-center, Owner',ATLAS_SERVICE_TAGS:''});
  assert.deepEqual(keys.owner,['cost-center','Owner']);assert.deepEqual(keys.service,DEFAULT_OWNERSHIP_KEYS.service,'an empty setting keeps the defaults');
  assert.equal(ownershipOf(res('c',{'Cost-Center':'cc-12',owner:'later'}),by,keys).owner,'cc-12','the first listed key wins');
});
test('an untagged resource takes its parent\'s owner and says where it came from',()=>{
  const net=res('vnet',{owner:'network-team',service:'hub'}),subnet=res('subnet',{},'vnet'),vm=res('vm',{service:'api'},'subnet'),by=new Map([net,subnet,vm].map(r=>[r.id,r]));
  assert.deepEqual(ownershipOf(vm,by),{owner:'network-team',ownerFrom:'vnet',service:'api'});
  const loop=res('x',{},'y'),back=res('y',{},'x');assert.deepEqual(ownershipOf(loop,new Map([[loop.id,loop],[back.id,back]])),{},'a parent cycle ends');
});
test('findings about a resource name its owner',async()=>{
  const base=await mockSnapshot('standard'),first=findings(base).find(f=>f.target?.id&&base.resources.some(r=>r.id===f.target!.id))!;
  const s={...base,resources:base.resources.map(r=>r.id===first.target!.id?{...r,tags:{...r.tags,Team:'edge-team'}}:r)};
  const list=findings(s);assert.equal(list.find(f=>f.id===first.id)!.owner,'edge-team');
  assert.ok(list.some(f=>f.target?.id&&!f.owner),'an untagged target simply has no owner');
});
test('the demo estate mixes owned, inherited and unowned resources, and restricted users keep the tag keys',async()=>{
  const s=await mockSnapshot('standard'),by=new Map(s.resources.map(r=>[r.id,r])),inv=s.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external').map(r=>ownershipOf(r,by));
  assert.ok(inv.some(o=>o.owner&&!o.ownerFrom));assert.ok(inv.some(o=>o.ownerFrom));assert.ok(inv.some(o=>!o.owner));
  const keys={owner:['team'],service:['app']},sub=s.hierarchy.find(n=>n.name==='Platform Prod')!.scope!;
  assert.deepEqual(restrictSnapshot({...s,ownership:keys},[sub]).ownership,keys);
});
