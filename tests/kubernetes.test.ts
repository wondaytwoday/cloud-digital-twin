import test from 'node:test';
import assert from 'node:assert/strict';
import {mockSnapshot} from '../server/mock.ts';
import {normalizeKubernetes,readCluster,KUBE_KINDS,clusterBindings} from '../server/kubernetes.ts';
import {resolveCrossRefs} from '../shared/crossref.ts';
import {analyzeFlow} from '../shared/flow.ts';
import {identityEvidence} from '../shared/relations.ts';
import {restrictSnapshot} from '../server/auth.ts';
import {aksPlatform} from '../server/fixtures/kubernetes.ts';

const demo=mockSnapshot('standard');
const find=async(name:string,kind?:string)=>(await demo).resources.find(r=>r.name===name&&(!kind||r.kind===kind))!;
const out=async(name:string,kind:string,linkKind:string)=>{const s=await demo,r=await find(name,kind);return s.links.filter(l=>l.source===r.id&&l.kind===linkKind).map(l=>s.resources.find(x=>x.id===l.target)!);};

test('the collector only runs `kubectl get`, never reads Secrets, and a refused kind costs only that kind',async()=>{
  assert.ok(!KUBE_KINDS.some(k=>/secret|configmap/i.test(k)));
  const calls:string[][]=[];
  const run=async(args:string[])=>{calls.push(args);if(args.includes('networkpolicies.networking.k8s.io'))throw new Error('Error from server (Forbidden): networkpolicies is forbidden');return JSON.stringify({items:[]});};
  const {denied}=await readCluster(run,'ctx');
  assert.ok(calls.every(a=>a[2]==='get'&&a.includes('-o')),'read only');assert.equal(denied.length,1);assert.match(denied[0],/networkpolicies.*Forbidden/);
  assert.deepEqual(clusterBindings({}),[]);
});
test('8. Pod → PVC → PV → cloud disk, joined by claim name, volume name and CSI volume handle',async()=>{
  const [pvc]=await out('ledger-db-0','pod','mounts'),[pv]=await out(pvc.name,'pvc','binds_to'),[disk]=await out(pv.name,'pv','binds_to');
  assert.equal(pvc.name,'data-ledger-db-0');assert.equal(pv.name,'pvc-7f3a2c1e');
  assert.equal(disk.kind,'disk');assert.equal(disk.provider,'azure');assert.equal(pv.specs['볼륨 핸들'].toLowerCase(),disk.nativeId);
});
test('9. a Service\'s backends are its EndpointSlice targets, not pods that merely share its label',async()=>{
  const backends=(await out('payments-api','k8sservice','forwards_to')).map(r=>r.name).sort();
  assert.deepEqual(backends,['payments-api-7d9c-abcde','payments-api-7d9c-fghij']);
  assert.equal((await find('payments-api-debug')).tags.app,'payments-api','the debug pod carries the label and is still not a backend');
});
test('workloads own pods through the ReplicaSet chain, and pods run on the node named in their spec',async()=>{
  const s=await demo,pod=await find('payments-api-7d9c-abcde','pod'),own=s.links.find(l=>l.target===pod.id&&l.kind==='owns')!;
  assert.equal(s.resources.find(r=>r.id===own.source)!.name,'payments-api');assert.match(own.evidence,/ReplicaSet payments-api-7d9c → Deployment/);
  assert.equal((await out('payments-api-7d9c-abcde','pod','runs_on'))[0].kind,'node');
});
test('a node whose VM the cloud collection lacks stays unresolved instead of becoming a machine',async()=>{
  const s=await demo;
  assert.ok(s.unresolved?.some(u=>u.kind==='runs_on'&&/virtualmachinescalesets/.test(u.nativeId)),'scale-set instances are not in Resource Graph Resources');
  assert.ok(!s.resources.some(r=>r.kind==='compute'&&/virtualmachinescalesets/.test(r.nativeId)));
  // EKS and GKE node provider IDs do resolve to collected instances.
  const fake=(providerID:string,provider:'aws'|'gcp')=>normalizeKubernetes({context:'c',provider,scope:'s',cluster:'x',region:'r'},{nodes:[{metadata:{name:'n1'},spec:{providerID},status:{conditions:[{type:'Ready',status:'True'}]}}]});
  const ec2={id:'aws:111/r/i-0abc',nativeId:'111/r/i-0abc',provider:'aws',kind:'compute'} as any,gce={id:'gcp://compute.googleapis.com/projects/p/zones/z/instances/vm',nativeId:'//compute.googleapis.com/projects/p/zones/z/instances/vm',provider:'gcp',kind:'compute'} as any;
  assert.equal(resolveCrossRefs([ec2],fake('aws:///ap-northeast-2a/i-0abc','aws').crossRefs).links[0]?.target,ec2.id);
  assert.equal(resolveCrossRefs([gce],fake('gce://p/z/vm','gcp').crossRefs).links[0]?.target,gce.id);
});
test('a pod runs as its ServiceAccount, which Workload Identity federates to a managed identity with its role assignment',async()=>{
  const s=await demo,pod=await find('payments-api-7d9c-abcde','pod'),st=await find('stplatformlogs'),[e]=identityEvidence(s,pod,st).filter(x=>x.identity.kind==='identity');
  assert.equal(e.identity.name,'id-payments-api');assert.match(e.via,/ServiceAccount → Workload Identity/);
  assert.deepEqual(e.onTarget.map(a=>a.role),['Storage Blob Data Reader']);assert.ok(e.unevaluated.length>0,'what is not evaluated is listed');
  // Kubernetes RBAC is a different question, answered from RoleBindings.
  assert.ok(s.iam.some(a=>a.principal==='system:serviceaccount:payments:payments-api'&&a.source.startsWith('Kubernetes RBAC')));
});
test('NetworkPolicy: isolation by selection, union of rules, service port to target port',async()=>{
  const s=await demo,id=async(n:string,k:string)=>(await find(n,k)).id,run=async(a:string,b:string,bk:string,port:number)=>analyzeFlow(s,{from:await id(a,'pod'),to:await id(b,bk),protocol:'tcp',port});
  const webToApi=await run('web-frontend-5c4b-klmno','payments-api','k8sservice',443);
  assert.equal(webToApi.status,'allowed');assert.match(webToApi.path.find(h=>h.kind==='service')!.evidence,/443→8443/);assert.match(webToApi.path.find(h=>h.kind==='service')!.evidence,/패킷 홉 아님/);
  const webToDb=await run('web-frontend-5c4b-klmno','ledger-db-0','pod',5432);assert.equal(webToDb.status,'blocked');
  // NetworkPolicy matches labels, so the stray debug pod reaches the database: a real finding, not an analyser bug.
  assert.equal((await run('payments-api-debug','ledger-db-0','pod',5432)).status,'allowed');
});
test('a policy that exists is not assumed enforced when the cluster\'s policy engine is unknown',async()=>{
  const s=structuredClone(await demo);s.resources.find(r=>r.name==='aks-platform')!.specs['NetworkPolicy 엔진']='없음 또는 미수집';
  const r=analyzeFlow(s,{from:s.resources.find(r=>r.name==='web-frontend-5c4b-klmno')!.id,to:s.resources.find(r=>r.name==='ledger-db-0')!.id,protocol:'tcp',port:5432});
  assert.equal(r.status,'unknown');assert.match(r.policies.find(p=>p.direction==='inbound')!.reason,/엔진이 확인되지 않아/);
});
test('11. a user restricted to another scope receives no Kubernetes object of this cluster',async()=>{
  const s=await demo,other=s.scopes.find(x=>!s.resources.some(r=>r.type.startsWith('k8s/')&&r.scope===x))!,r=restrictSnapshot(s,[other]);
  assert.ok(!r.resources.some(x=>x.type.startsWith('k8s/')));assert.ok(!(r.unresolved??[]).length);assert.ok(!r.iam.some(a=>a.source.startsWith('Kubernetes')));
  assert.ok(!JSON.stringify(r).includes('aks-platform'));
});
test('fixtures are shaped like kubectl output: every pod names its namespace and node',()=>{
  for(const p of aksPlatform('sub','client').pods)assert.ok((p as any).metadata.namespace&&(p as any).spec.nodeName);
});

test('a live run collects the configured cluster after the clouds, and the merge joins it to the cloud disk',async()=>{
  const {mkdtemp}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path');
  const {FileSnapshotStore}=await import('../server/store.ts'),{configureCollector,configureKubectl,runCollection}=await import('../server/runner.ts'),{liveSnapshot}=await import('../server/app.ts'),{pvDiskId}=await import('../server/fixtures/kubernetes.ts');
  const sub='00000000-0000-4000-8000-000000000002',items=aksPlatform(sub,'client'),store=new FileSnapshotStore(await mkdtemp(path.join(tmpdir(),'atlas-')));
  const disk={id:`azure:${pvDiskId(sub).toLowerCase()}`,nativeId:pvDiskId(sub).toLowerCase(),name:'pvc-7f3a2c1e',provider:'azure' as const,kind:'disk' as const,type:'Microsoft.Compute/disks',scope:sub,region:'kc',status:'Attached',routes:[],specs:{},rules:[],iam:[],tags:{},source:'test'};
  const off={detect:async()=>{throw new Error('Could not load credentials');},collect:async()=>{throw new Error('unused');}};
  configureCollector({azure:{detect:async()=>'a',collect:async()=>({resources:[disk],links:[],warnings:[],scopeLabels:{}})},aws:off,gcp:off});
  const asked:string[]=[];configureKubectl(async args=>{assert.equal(args[2],'get');asked.push(args[3]);return JSON.stringify({items:items[args[3]]??[]});});
  const saved=process.env.ATLAS_KUBERNETES;process.env.ATLAS_KUBERNETES=JSON.stringify([{context:'aks-platform',provider:'azure',scope:sub,cluster:'/subscriptions/x/aks',networkPolicyEngine:'azure'}]);
  try{
    const status=await runCollection(store);assert.equal(status.kubernetes?.state,'ok');assert.equal(asked.length,KUBE_KINDS.length);
    const s=(await liveSnapshot(store))!,pv=s.resources.find(r=>r.kind==='pv')!;
    assert.ok(s.links.some(l=>l.source===pv.id&&l.target===disk.id&&l.kind==='binds_to'),'PV joined to the disk collected by the Azure run');
    assert.equal(s.connections.find(c=>c.provider==='azure')?.status,'collected','the Kubernetes snapshot does not stand in for Azure');
    assert.ok(s.unresolved?.some(u=>u.kind==='runs_on'),'nodes whose VMs were not collected stay unresolved');
  }finally{if(saved===undefined)delete process.env.ATLAS_KUBERNETES;else process.env.ATLAS_KUBERNETES=saved;configureCollector();configureKubectl();}
});
