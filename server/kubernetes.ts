import {execFile} from 'node:child_process';
import {z} from 'zod';
import {ResourceSchema,type CrossRef,type IamAssignment,type Link,type Resource} from '../shared/schema.js';
import type {Normalized} from './normalize.js';
// Kubernetes is read through the Kubernetes API, separately from the cloud that hosts the cluster. kubectl does the reading, so each
// provider's own sign-in plugin (kubelogin, aws eks get-token, gke-gcloud-auth-plugin) works unchanged. Only `get` is ever run.
// Secrets are not in the list and never read; ConfigMaps are not read either.
export const KUBE_KINDS=['nodes','namespaces','deployments.apps','statefulsets.apps','daemonsets.apps','replicasets.apps','pods','services','endpointslices.discovery.k8s.io','ingresses.networking.k8s.io','networkpolicies.networking.k8s.io','serviceaccounts','roles.rbac.authorization.k8s.io','clusterroles.rbac.authorization.k8s.io','rolebindings.rbac.authorization.k8s.io','clusterrolebindings.rbac.authorization.k8s.io','persistentvolumeclaims','persistentvolumes','storageclasses.storage.k8s.io'] as const;
// Which kubeconfig context is which cloud cluster. The scope ties every object to the cloud subscription, account or project the
// cluster belongs to, so the server's scope restriction covers Kubernetes objects too.
export const ClusterBinding=z.object({context:z.string(),provider:z.enum(['azure','aws','gcp']),scope:z.string(),cluster:z.string(),region:z.string().default('k8s'),networkPolicyEngine:z.string().optional()});
export type ClusterBinding=z.infer<typeof ClusterBinding>;
export const clusterBindings=(env:NodeJS.ProcessEnv=process.env)=>z.array(ClusterBinding).parse(JSON.parse(env.ATLAS_KUBERNETES?.trim()||'[]'));
type Raw=Record<string,any>;
export type KubeList=Record<string,Raw[]>;
export type Kubectl=(args:string[],signal?:AbortSignal)=>Promise<string>;
export const kubectl:Kubectl=(args,signal)=>new Promise((done,fail)=>execFile('kubectl',args,{maxBuffer:256*1024*1024,timeout:120_000,signal},(e,out,err)=>e?fail(new Error(String(err||e.message).split('\n')[0])):done(out)));
// One `get` per kind, so a kind the identity may not list (or the cluster does not serve) costs only that kind.
export async function readCluster(run:Kubectl,context:string,signal?:AbortSignal){
  const items:KubeList={},denied:string[]=[];
  for(const kind of KUBE_KINDS){
    try{items[kind]=JSON.parse(await run(['--context',context,'get',kind,'--all-namespaces','-o','json','--request-timeout=60s'],signal)).items??[];}
    catch(e){denied.push(`${kind} (${(e as Error).message.slice(0,80)})`);items[kind]=[];}
  }
  return{items,denied};
}

const labelsMatch=(selector:Record<string,string>|undefined,labels:Record<string,string>|undefined)=>!!selector&&Object.entries(selector).every(([k,v])=>labels?.[k]===v);
const providerInstance=(providerID:string)=>{
  // providerID formats: azure:///subscriptions/…/virtualMachineScaleSets/…/virtualMachines/N, aws:///zone/i-…, gce://project/zone/name
  if(providerID.startsWith('azure://'))return{provider:'azure' as const,nativeId:providerID.replace('azure://','').toLowerCase(),match:'id' as const};
  if(providerID.startsWith('aws://'))return{provider:'aws' as const,nativeId:providerID.split('/').pop()!,match:'suffix' as const};
  if(providerID.startsWith('gce://')){const [project,zone,name]=providerID.replace('gce://','').split('/');return{provider:'gcp' as const,nativeId:`//compute.googleapis.com/projects/${project}/zones/${zone}/instances/${name}`,match:'id' as const};}
  return undefined;
};
// CSI volume handles name the cloud disk: an ARM disk ID (Azure Disk), vol-… (EBS), projects/…/disks/… (GCE PD).
const csiDisk=(driver:string,handle:string)=>driver==='disk.csi.azure.com'?{provider:'azure' as const,nativeId:handle,match:'id' as const}:driver==='ebs.csi.aws.com'?{provider:'aws' as const,nativeId:handle,match:'suffix' as const}:driver==='pd.csi.storage.gke.io'?{provider:'gcp' as const,nativeId:`//compute.googleapis.com/${handle}`,match:'id' as const}:undefined;

export function normalizeKubernetes(b:ClusterBinding,items:KubeList,denied:string[]=[]):Normalized&{crossRefs:CrossRef[]}{
  const resources:Resource[]=[],links:Link[]=[],crossRefs:CrossRef[]=[],iam:IamAssignment[]=[],warnings:string[]=[];
  const nid=(kind:string,ns:string|undefined,name:string)=>`k8s/${b.context}/${kind}/${ns??'_'}/${name}`,rid=(kind:string,ns:string|undefined,name:string)=>`${b.provider}:${nid(kind,ns,name)}`;
  const add=(o:Raw,apiKind:string,kind:Resource['kind'],extra:Partial<Resource>={})=>resources.push(ResourceSchema.parse({id:rid(apiKind,o.metadata?.namespace,o.metadata.name),nativeId:nid(apiKind,o.metadata?.namespace,o.metadata.name),name:o.metadata.name,provider:b.provider,kind,type:`k8s/${apiKind}`,scope:b.scope,region:b.region,group:o.metadata?.namespace??b.context,source:`Kubernetes API · ${b.context}`,tags:o.metadata?.labels??{},...extra}));
  const link=(source:string,target:string,kind:Link['kind'],label:string,evidence:string,extra:Partial<Link>={})=>links.push({id:`${kind}:${source}:${target}`,source,target,kind,label,evidence,basis:'configured',...extra});
  for(const d of denied)warnings.push(`Kubernetes ${b.context}: ${d}을(를) 읽지 못했습니다.`);
  for(const n of items.namespaces??[]){add(n,'Namespace','namespace',{specs:{'클러스터':b.context}});crossRefs.push({source:rid('Namespace',undefined,n.metadata.name),kind:'contains',provider:b.provider,nativeId:b.cluster,reverse:true,label:'네임스페이스',evidence:`kubeconfig 컨텍스트 ${b.context}를 클러스터 ${b.cluster.split('/').pop()}에 대응 (ATLAS_KUBERNETES)`});}
  const nsOf=(o:Raw)=>rid('Namespace',undefined,o.metadata.namespace);
  for(const n of items.nodes??[]){
    const ready=(n.status?.conditions??[]).find((c:Raw)=>c.type==='Ready')?.status==='True',pid=n.spec?.providerID??'';
    add(n,'Node','node',{ip:(n.status?.addresses??[]).find((a:Raw)=>a.type==='InternalIP')?.address,status:ready?'ready':'NotReady',specs:{'providerID':pid||'없음','인스턴스 유형':n.metadata?.labels?.['node.kubernetes.io/instance-type']??'미확인','영역':n.metadata?.labels?.['topology.kubernetes.io/zone']??'미확인','노드 풀':n.metadata?.labels?.agentpool??n.metadata?.labels?.['eks.amazonaws.com/nodegroup']??n.metadata?.labels?.['cloud.google.com/gke-nodepool']??'미확인'}});
    const vm=providerInstance(pid);if(vm)crossRefs.push({source:rid('Node',undefined,n.metadata.name),kind:'runs_on',...vm,label:'노드 VM',evidence:'node.spec.providerID'});
  }
  // A pod's owner is usually a ReplicaSet whose owner is the Deployment; the chain is followed instead of drawing ReplicaSets.
  const rsOwner=new Map((items['replicasets.apps']??[]).map(r=>[`${r.metadata.namespace}/${r.metadata.name}`,(r.metadata.ownerReferences??[]).find((o:Raw)=>o.controller)]));
  for(const [k,label] of [['deployments.apps','Deployment'],['statefulsets.apps','StatefulSet'],['daemonsets.apps','DaemonSet']] as const)for(const w of items[k]??[]){
    add(w,label,'workload',{selector:w.spec?.selector?.matchLabels,status:`${w.status?.readyReplicas??w.status?.numberReady??0}/${w.spec?.replicas??w.status?.desiredNumberScheduled??'?'} ready`,specs:{'종류':label,'네임스페이스':w.metadata.namespace}});
    link(nsOf(w),rid(label,w.metadata.namespace,w.metadata.name),'contains',label,'metadata.namespace');
  }
  for(const p of items.pods??[]){
    const id=rid('Pod',p.metadata.namespace,p.metadata.name),ns=p.metadata.namespace;
    add(p,'Pod','pod',{ip:p.status?.podIP,addresses:(p.status?.podIPs??[]).map((x:Raw,i:number)=>({ip:x.ip,primary:i===0})),status:p.status?.phase??'미확인',specs:{'네임스페이스':ns,'노드':p.spec?.nodeName??'미배치','ServiceAccount':p.spec?.serviceAccountName??'default','hostNetwork':String(!!p.spec?.hostNetwork)}});
    link(nsOf(p),id,'contains','Pod','metadata.namespace');
    if(p.spec?.nodeName)link(id,rid('Node',undefined,p.spec.nodeName),'runs_on','실행 노드','pod.spec.nodeName');
    const owner=(p.metadata.ownerReferences??[]).find((o:Raw)=>o.controller);
    if(owner){const up=owner.kind==='ReplicaSet'?rsOwner.get(`${ns}/${owner.name}`):owner;if(up&&['Deployment','StatefulSet','DaemonSet'].includes(up.kind))link(rid(up.kind,ns,up.name),id,'owns',up.kind,owner.kind==='ReplicaSet'?`ownerReferences: Pod → ReplicaSet ${owner.name} → ${up.kind}`:'ownerReferences',{ref:up.uid});}
    link(id,rid('ServiceAccount',ns,p.spec?.serviceAccountName??'default'),'uses_identity','ServiceAccount','pod.spec.serviceAccountName');
    for(const v of p.spec?.volumes??[])if(v.persistentVolumeClaim?.claimName)link(id,rid('PersistentVolumeClaim',ns,v.persistentVolumeClaim.claimName),'mounts',`볼륨 ${v.name}`,'pod.spec.volumes.persistentVolumeClaim',{note:'Pod 명세가 요청한 마운트입니다. 컨테이너 안의 실제 마운트 상태는 확인하지 않았습니다.'});
  }
  // A Service's backends are what EndpointSlices list, by target reference, not pods whose names or labels look alike.
  for(const s of items.services??[]){
    add(s,'Service','k8sservice',{ip:s.spec?.clusterIP&&s.spec.clusterIP!=='None'?s.spec.clusterIP:undefined,publicIp:s.status?.loadBalancer?.ingress?.[0]?.ip,selector:s.spec?.selector,specs:{'유형':s.spec?.type??'ClusterIP','포트':(s.spec?.ports??[]).map((x:Raw)=>`${x.port}/${x.protocol??'TCP'}→${x.targetPort??x.port}`).join(', ')||'없음','선택자':Object.entries(s.spec?.selector??{}).map(([k,v])=>`${k}=${v}`).join(', ')||'없음 (수동 엔드포인트)'}});
    link(nsOf(s),rid('Service',s.metadata.namespace,s.metadata.name),'contains','Service','metadata.namespace');
  }
  for(const e of items['endpointslices.discovery.k8s.io']??[]){
    const svc=e.metadata?.labels?.['kubernetes.io/service-name'];if(!svc)continue;
    for(const ep of e.endpoints??[])if(ep.targetRef?.kind==='Pod')link(rid('Service',e.metadata.namespace,svc),rid('Pod',ep.targetRef.namespace??e.metadata.namespace,ep.targetRef.name),'forwards_to',ep.conditions?.ready===false?'엔드포인트 (준비 안 됨)':'엔드포인트','endpointSlice.endpoints.targetRef',{ref:e.metadata.name,note:'논리적 전달 관계입니다. 실제 패킷은 kube-proxy·CNI가 전달하며 그 경로는 수집하지 않았습니다.'});
  }
  for(const i of items['ingresses.networking.k8s.io']??[]){
    add(i,'Ingress','ingress',{publicIp:i.status?.loadBalancer?.ingress?.[0]?.ip,specs:{'클래스':i.spec?.ingressClassName??'미지정','호스트':(i.spec?.rules??[]).map((r:Raw)=>r.host).filter(Boolean).join(', ')||'*'}});
    link(nsOf(i),rid('Ingress',i.metadata.namespace,i.metadata.name),'contains','Ingress','metadata.namespace');
    for(const r of i.spec?.rules??[])for(const path of r.http?.paths??[])if(path.backend?.service?.name)link(rid('Ingress',i.metadata.namespace,i.metadata.name),rid('Service',i.metadata.namespace,path.backend.service.name),'forwards_to',`${r.host??'*'}${path.path??'/'}`,'ingress.spec.rules.http.paths.backend.service');
  }
  // NetworkPolicy: which pods it selects is computed here from labels (so those links are inferred); its rules are kept with their peers.
  for(const np of items['networkpolicies.networking.k8s.io']??[]){
    const ns=np.metadata.namespace,types:string[]=np.spec?.policyTypes??['Ingress',...(np.spec?.egress?['Egress']:[])];
    const peer=(x:Raw)=>[...(x.podSelector?[`pod:${JSON.stringify(x.podSelector.matchLabels??{})}`]:[]),...(x.namespaceSelector?[`ns:${JSON.stringify(x.namespaceSelector.matchLabels??{})}`]:[]),...(x.ipBlock?[`cidr:${x.ipBlock.cidr}${x.ipBlock.except?.length?`!${x.ipBlock.except.join('|')}`:''}`]:[])].join('&');
    const rules=[...(np.spec?.ingress??[]).map((r:Raw)=>({direction:'Ingress',r})),...(np.spec?.egress??[]).map((r:Raw)=>({direction:'Egress',r}))].flatMap(({direction,r})=>{const peers=((direction==='Ingress'?r.from:r.to)??[]).map(peer);const ports=(r.ports??[]).map((p:Raw)=>`${p.port??'*'}/${p.protocol??'TCP'}`);return[{name:np.metadata.name,direction,action:'Allow',protocol:'*',ports:ports.join(', ')||'*',source:direction==='Ingress'?peers.join(' | ')||'모든 출발지':'*',destination:direction==='Egress'?peers.join(' | ')||'모든 목적지':'*',priority:'-',peers:peers.length?peers:['any']}];});
    add(np,'NetworkPolicy','firewall',{appliesTo:{podSelector:np.spec?.podSelector?.matchLabels??{},namespace:ns,policyTypes:types},rules,specs:{'종류':'NetworkPolicy','유형':types.join(', '),'강제 적용':b.networkPolicyEngine?`정책 엔진 ${b.networkPolicyEngine}`:'미확인 (CNI·정책 엔진 설정을 확인하지 않음)'}});
    for(const p of items.pods??[])if(p.metadata.namespace===ns&&(Object.keys(np.spec?.podSelector?.matchLabels??{}).length===0||labelsMatch(np.spec?.podSelector?.matchLabels,p.metadata.labels)))link(rid('NetworkPolicy',ns,np.metadata.name),rid('Pod',ns,p.metadata.name),'policy','NetworkPolicy 적용','networkPolicy.spec.podSelector ↔ pod labels',{basis:'inferred',note:'선택자와 Pod 레이블을 비교해 Atlas가 계산했습니다.'});
  }
  // A ServiceAccount may be federated to a cloud identity through an annotation each provider defines.
  for(const sa of items.serviceaccounts??[]){
    const ns=sa.metadata.namespace,a=sa.metadata.annotations??{},id=rid('ServiceAccount',ns,sa.metadata.name);
    add(sa,'ServiceAccount','serviceaccount',{specs:{'주체':`system:serviceaccount:${ns}:${sa.metadata.name}`,'토큰 자동 마운트':String(sa.automountServiceAccountToken??true)}});
    link(nsOf(sa),id,'contains','ServiceAccount','metadata.namespace');
    if(a['azure.workload.identity/client-id'])crossRefs.push({source:id,kind:'uses_identity',provider:'azure',nativeId:a['azure.workload.identity/client-id'],match:'clientId',label:'Workload Identity',evidence:'serviceAccount annotation azure.workload.identity/client-id (연합 자격 증명 구성은 확인하지 않음)'});
    if(a['eks.amazonaws.com/role-arn']){const arn=a['eks.amazonaws.com/role-arn'],role=resources.find(r=>r.nativeId===arn);if(!role)resources.push(ResourceSchema.parse({id:`aws:${arn}`,nativeId:arn,name:`${arn.split('/').pop()} (IRSA 역할)`,provider:'aws',kind:'identity',type:'AWS::IAM::Role',scope:b.scope,region:'global',source:`Kubernetes API · ${b.context}`,specs:{'종류':'IAM 역할 (IRSA)','역할':arn.split('/').pop()!,'ARN':arn}}));link(id,`aws:${arn}`,'uses_identity','IRSA','serviceAccount annotation eks.amazonaws.com/role-arn',{note:'역할의 신뢰 정책(OIDC 조건)은 확인하지 않았습니다.'});}
    if(a['iam.gke.io/gcp-service-account'])crossRefs.push({source:id,kind:'uses_identity',provider:'gcp',nativeId:a['iam.gke.io/gcp-service-account'],match:'email',label:'Workload Identity',evidence:'serviceAccount annotation iam.gke.io/gcp-service-account (IAM 바인딩 roles/iam.workloadIdentityUser는 확인하지 않음)'});
  }
  // RBAC lands in the IAM list as Kubernetes assignments: what a subject may do in the cluster API, not on cloud resources.
  const bind=(rb:Raw,cluster:boolean)=>{for(const s of rb.subjects??[]){const principal=s.kind==='ServiceAccount'?`system:serviceaccount:${s.namespace??rb.metadata.namespace}:${s.name}`:s.name;
    iam.push({id:`${b.provider}:${nid(cluster?'ClusterRoleBinding':'RoleBinding',rb.metadata.namespace,rb.metadata.name)}:${principal}`,provider:b.provider,principal,principalType:s.kind==='ServiceAccount'?'serviceAccount':s.kind==='Group'?'group':'user',role:`${rb.roleRef?.kind}/${rb.roleRef?.name}`,scope:b.scope,scopeName:`${b.context}${cluster?'':` · ${rb.metadata.namespace}`}`,level:'resource',privileged:rb.roleRef?.name==='cluster-admin'||rb.roleRef?.name==='admin',external:false,resourceScope:`k8s/${b.context}${cluster?'':`/${rb.metadata.namespace}`}`,source:`Kubernetes RBAC · ${cluster?'ClusterRoleBinding':'RoleBinding'} ${rb.metadata.name}`});}};
  for(const rb of items['rolebindings.rbac.authorization.k8s.io']??[])bind(rb,false);
  for(const rb of items['clusterrolebindings.rbac.authorization.k8s.io']??[])bind(rb,true);
  // Storage: PVC binds to PV by spec.volumeName; a PV names its cloud disk through the CSI volume handle.
  for(const c of items.persistentvolumeclaims??[]){add(c,'PersistentVolumeClaim','pvc',{status:c.status?.phase??'미확인',specs:{'요청':c.spec?.resources?.requests?.storage??'미확인','스토리지 클래스':c.spec?.storageClassName??'기본값','접근 모드':(c.spec?.accessModes??[]).join(', ')}});link(nsOf(c),rid('PersistentVolumeClaim',c.metadata.namespace,c.metadata.name),'contains','PVC','metadata.namespace');if(c.spec?.volumeName)link(rid('PersistentVolumeClaim',c.metadata.namespace,c.metadata.name),rid('PersistentVolume',undefined,c.spec.volumeName),'binds_to','PV 바인딩','pvc.spec.volumeName');}
  for(const v of items.persistentvolumes??[]){
    const csi=v.spec?.csi;add(v,'PersistentVolume','pv',{status:v.status?.phase??'미확인',specs:{'용량':v.spec?.capacity?.storage??'미확인','CSI 드라이버':csi?.driver??'CSI 아님','볼륨 핸들':csi?.volumeHandle??'없음','회수 정책':v.spec?.persistentVolumeReclaimPolicy??'미확인'}});
    const disk=csi?csiDisk(csi.driver,csi.volumeHandle):undefined;
    if(disk)crossRefs.push({source:rid('PersistentVolume',undefined,v.metadata.name),kind:'binds_to',...disk,label:'클라우드 볼륨',evidence:`pv.spec.csi.volumeHandle (${csi.driver})`});
    else if(csi)warnings.push(`PV ${v.metadata.name}: CSI 드라이버 ${csi.driver}의 볼륨 핸들은 클라우드 자원과 연결하지 않습니다.`);
  }
  // Every link ends at a collected object or is dropped with a warning; a pod naming a missing PVC is a fact, not a new object.
  const ids=new Set(resources.map(r=>r.id)),kept=links.filter(l=>{if(ids.has(l.source)&&ids.has(l.target))return true;warnings.push(`Kubernetes ${b.context}: ${l.label} 참조 대상 ${l.target.split('/').slice(-1)[0]}을(를) 찾지 못했습니다.`);return false;});
  return{resources,links:[...new Map(kept.map(l=>[l.id,l])).values()],warnings,scopeLabels:{},iam,crossRefs,...(denied.length?{incomplete:[b.scope]}:{})};
}
