import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichAzureSizes,enrichGcpSizes,customGcpSize} from '../server/sku-lookup.ts';
import {normalizeAzure,normalizeGcp} from '../server/normalize.ts';
import {capacityIssues,fleetTotals} from '../shared/capacity.ts';

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const azure=(size:string,sub='a',region='eastus',name='vm')=>({id:`/subscriptions/${sub}/resourceGroups/g/providers/Microsoft.Compute/virtualMachines/${name}`,name,type:'Microsoft.Compute/virtualMachines',subscriptionId:sub,location:region,properties:{hardwareProfile:{vmSize:size},extended:{instanceView:{powerState:{code:'PowerState/running'}}}}});
const gce=(machine:string,project='p',zone='us-central1-a',name='vm',extra={})=>({name:`//compute.googleapis.com/projects/${project}/zones/${zone}/instances/${name}`,assetType:'compute.googleapis.com/Instance',resource:{data:{name,machineType:`zones/${zone}/machineTypes/${machine}`,status:'RUNNING',...extra}}});
const sku=(name:string,cores=12,memory=96)=>({name,resourceType:'virtualMachines',capabilities:[{name:'vCPUs',value:'24'},{name:'vCPUsAvailable',value:String(cores)},{name:'MemoryGB',value:String(memory)},{name:'GPUs',value:'2'}]});

test('Azure reads paginated SKU capabilities once per subscription/region and uses available vCPUs',async()=>{
  const resources=normalizeAzure([azure('Standard_New'),azure('Standard_New','a','eastus','vm2')]).resources;
  const calls:string[]=[];
  await enrichAzureSizes(resources,async()=>'fake',(async url=>{
    calls.push(String(url));return calls.length===1?json({value:[],nextLink:'https://management.azure.com/subscriptions/a/providers/Microsoft.Compute/skus?page=2'}):json({value:[sku('Standard_New')]});
  }) as typeof fetch);
  assert.equal(calls.length,2);assert.match(calls[0],/location/);
  assert.equal(resources[0].specs.vCPU,'12');assert.equal(resources[1].specs['메모리'],'96 GiB');
  assert.equal(resources[0].specs['GPU'],'2 × GPU (모델 미제공)');
  assert.equal(fleetTotals(resources).vcpu,24);assert.deepEqual(capacityIssues(resources),[]);
});
test('Azure isolates subscriptions and regions, distinguishes denial from unknown and retains offline fallback',async()=>{
  const resources=normalizeAzure([azure('Standard_B2s'),azure('Missing','b'),azure('Missing','c','westus')]).resources;
  await enrichAzureSizes(resources,async()=>'fake',(async url=>String(url).includes('/c/')?json({value:[]}):json({},403)) as typeof fetch);
  assert.equal(resources[0].specs.vCPU,'2');assert.equal(resources[0].specs['크기 조회'],'내장표 폴백');
  assert.match(resources[1].specs['크기 조회 사유'],/권한/);assert.equal(resources[1].specs.vCPU,'미확인');
  assert.equal(resources[2].specs['크기 조회 사유'],'알 수 없는 크기');
  assert.equal(fleetTotals(resources).vcpu,2);
  assert.equal(capacityIssues(resources).length,3);
});
test('Azure rejects cross-origin and repeated continuation URLs without leaking bearer tokens',async()=>{
  for(const nextLink of ['https://example.invalid/steal','https://management.azure.com/subscriptions/a/providers/Microsoft.Compute/skus?again=1']){
    let calls=0;const resources=normalizeAzure([azure('Missing')]).resources;
    await enrichAzureSizes(resources,async()=>'fake',(async()=>{calls++;return json({value:[],nextLink});}) as typeof fetch);
    assert.equal(calls,nextLink.includes('example.invalid')?1:2);
    assert.match(resources[0].specs['크기 조회 사유'],/API 응답/);
  }
});
test('GCP looks up new types by project and zone, deduplicates requests and reads fixed GPU types',async()=>{
  const resources=normalizeGcp([gce('a3-new'),gce('a3-new','p','us-central1-a','vm2'),gce('a3-new','p','us-central1-b')]).resources;
  const calls:string[]=[];
  await enrichGcpSizes(resources,async url=>{calls.push(url);return{guestCpus:32,memoryMb:131072,accelerators:[{guestAcceleratorCount:4,guestAcceleratorType:'nvidia-h100'}]};});
  assert.equal(calls.length,2);assert.ok(calls.every(url=>url.startsWith('https://compute.googleapis.com/compute/v1/projects/p/zones/')));
  assert.equal(fleetTotals(resources).vcpu,96);assert.equal(fleetTotals(resources).gpus,12);
  assert.equal(resources[0].specs['크기 조회'],'GCP machineTypes.get');
});
test('GCP custom sizes calculate MiB and preserve observed attached GPU; failures remain distinct',async()=>{
  assert.deepEqual(customGcpSize('n2-custom-6-24576-ext'),{vcpu:6,memoryGiB:24});
  assert.equal(customGcpSize('future-custom-2-8192'),undefined);assert.equal(customGcpSize('custom-0-0'),undefined);
  const resources=normalizeGcp([gce('custom-6-24576','p','z','custom',{guestAccelerators:[{acceleratorCount:1,acceleratorType:'zones/z/acceleratorTypes/nvidia-t4'}]}),gce('e2-medium','p','z','known'),gce('unknown','p','z','new'),gce('missing','p','z','missing')]).resources;
  await enrichGcpSizes(resources,async url=>{throw{response:{status:url.endsWith('/missing')?404:403}};});
  assert.equal(resources[0].specs.vCPU,'6');assert.equal(resources[0].specs.GPU,'1 × nvidia-t4');
  assert.equal(resources[1].specs['크기 조회'],'내장표 폴백');assert.match(resources[2].specs['크기 조회 사유'],/권한/);
  assert.equal(resources[3].specs['크기 조회 사유'],'알 수 없는 크기');
});
test('a cancelled size lookup propagates abort instead of disguising it as a fallback',async()=>{
  const controller=new AbortController();
  const request=async()=>{controller.abort();throw new Error('cancelled');};
  await assert.rejects(enrichGcpSizes(normalizeGcp([gce('new')]).resources,request,{signal:controller.signal}));
  const controller2=new AbortController();controller2.abort();
  await assert.rejects(enrichAzureSizes(normalizeAzure([azure('new')]).resources,async()=>'fake',request as typeof fetch,{signal:controller2.signal}));
});
