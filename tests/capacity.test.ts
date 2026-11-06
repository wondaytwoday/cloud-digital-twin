import test from 'node:test';
import assert from 'node:assert/strict';
import {capacityOf,categoryOf,fleetTotals,gpuCount} from '../shared/capacity.ts';
import {mockSnapshot} from '../server/mock.ts';
import type {Resource} from '../shared/schema.ts';
const vm=(status:string,specs:Record<string,string>):Resource=>({id:status+JSON.stringify(specs),nativeId:'x',name:'vm',provider:'aws',kind:'compute',type:'t',scope:'s',region:'r',status,routes:[],specs,rules:[],iam:[],tags:{},source:'test'});
test('sizes are read back from the collectors’ display strings',()=>{
  assert.deepEqual(capacityOf(vm('running',{'인스턴스':'g5.xlarge','vCPU':'4','메모리':'16 GiB','디스크':'250 GiB','GPU':'1 × NVIDIA A10G'})),{vcpu:4,memoryGiB:16,diskGiB:250,gpus:1,gpuModel:'NVIDIA A10G',size:'g5.xlarge'});
  assert.equal(gpuCount('2 × nvidia-tesla-t4, 1 × nvidia-l4'),3);
  assert.equal(gpuCount('없음'),0);assert.equal(gpuCount('미수집'),0);
  assert.equal(capacityOf(vm('running',{'vCPU':'SKU 추가 조회 필요'})).vcpu,undefined);
});
test('fleet totals count cores of running VMs only and say what is unknown',()=>{
  const t=fleetTotals([vm('running',{'vCPU':'4','메모리':'16 GiB','디스크':'128 GiB','GPU':'1 × T4'}),vm('stopped',{'vCPU':'8','메모리':'32 GiB','디스크':'64 GiB'}),vm('running',{})]);
  assert.deepEqual({vcpu:t.vcpu,memory:t.memoryGiB,disk:t.diskGiB,gpus:t.gpus,running:t.running,stopped:t.stopped,unsized:t.unsized,undisked:t.undisked},{vcpu:4,memory:16,disk:192,gpus:1,running:2,stopped:1,unsized:1,undisked:1});
});
test('mock VMs carry disks and GPU telemetry end to end',async()=>{
  const s=await mockSnapshot('standard'),vms=s.resources.filter(r=>r.kind==='compute');
  assert.ok(vms.some(v=>capacityOf(v).diskGiB),'disk sizes flow through the normalizers');
  assert.ok(vms.some(v=>capacityOf(v).gpus&&v.metrics?.gpu!==undefined),'GPU hosts report GPU use');
  assert.ok(s.resources.every(r=>categoryOf(r.kind)),'every kind has a category');
});
