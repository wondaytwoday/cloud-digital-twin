// Synthetic objects in the shape `kubectl get <kind> -A -o json` returns. Never customer data.
import type {KubeList} from '../kubernetes.js';
const meta=(name:string,namespace?:string,extra:Record<string,unknown>={})=>({metadata:{name,...(namespace?{namespace}:{}),uid:`uid-${namespace??'_'}-${name}`,...extra}});
const owner=(kind:string,name:string)=>({ownerReferences:[{kind,name,controller:true,uid:`uid-${name}`}]});
// The AKS node pool runs on a scale set. Resource Graph's Resources table does not list scale-set instances, so these nodes stay unresolved.
const vmss=(sub:string,n:number)=>`azure:///subscriptions/${sub}/resourceGroups/MC_rg-platform_aks-platform_koreacentral/providers/Microsoft.Compute/virtualMachineScaleSets/aks-system-12345678-vmss/virtualMachines/${n}`;
export const pvDiskId=(sub:string)=>`/subscriptions/${sub}/resourceGroups/MC_rg-platform_aks-platform_koreacentral/providers/Microsoft.Compute/disks/pvc-7f3a2c1e`;
export function aksPlatform(sub:string,paymentsClientId:string):KubeList{
  const pod=(name:string,ns:string,ip:string,node:number,labels:Record<string,string>,ownerRef:ReturnType<typeof owner>,sa='default',volumes:object[]=[])=>({...meta(name,ns,{labels,...ownerRef}),spec:{nodeName:`aks-system-12345678-vmss00000${node}`,serviceAccountName:sa,volumes},status:{phase:'Running',podIP:ip,podIPs:[{ip}]}});
  return{
    nodes:[0,1].map(n=>({...meta(`aks-system-12345678-vmss00000${n}`,undefined,{labels:{'node.kubernetes.io/instance-type':'Standard_D4s_v5','topology.kubernetes.io/zone':`koreacentral-${n+1}`,agentpool:'system'}}),spec:{providerID:vmss(sub,n)},status:{addresses:[{type:'InternalIP',address:`10.10.8.${4+n}`}],conditions:[{type:'Ready',status:'True'}]}})),
    namespaces:['payments','web','kube-system'].map(n=>meta(n,undefined,{labels:{'kubernetes.io/metadata.name':n}})),
    'deployments.apps':[{...meta('payments-api','payments'),spec:{replicas:2,selector:{matchLabels:{app:'payments-api'}}},status:{readyReplicas:2}},{...meta('web-frontend','web'),spec:{replicas:1,selector:{matchLabels:{app:'web-frontend'}}},status:{readyReplicas:1}}],
    'statefulsets.apps':[{...meta('ledger-db','payments'),spec:{replicas:1,selector:{matchLabels:{app:'ledger-db'}}},status:{readyReplicas:1}}],
    'daemonsets.apps':[],
    'replicasets.apps':[{...meta('payments-api-7d9c','payments',owner('Deployment','payments-api'))},{...meta('web-frontend-5c4b','web',owner('Deployment','web-frontend'))}],
    pods:[
      pod('payments-api-7d9c-abcde','payments','10.10.8.20',0,{app:'payments-api'},owner('ReplicaSet','payments-api-7d9c'),'payments-api'),
      pod('payments-api-7d9c-fghij','payments','10.10.8.21',1,{app:'payments-api'},owner('ReplicaSet','payments-api-7d9c'),'payments-api'),
      // Carries the Service's label but is not in its EndpointSlice (a debug pod someone left running): it must not become a backend.
      pod('payments-api-debug','payments','10.10.8.22',1,{app:'payments-api'},{ownerReferences:[]}),
      pod('ledger-db-0','payments','10.10.8.40',0,{app:'ledger-db'},owner('StatefulSet','ledger-db'),'default',[{name:'data',persistentVolumeClaim:{claimName:'data-ledger-db-0'}}]),
      pod('web-frontend-5c4b-klmno','web','10.10.8.30',1,{app:'web-frontend'},owner('ReplicaSet','web-frontend-5c4b')),
    ],
    services:[{...meta('payments-api','payments'),spec:{type:'ClusterIP',clusterIP:'10.0.100.10',selector:{app:'payments-api'},ports:[{port:443,targetPort:8443,protocol:'TCP'}]}},{...meta('ledger-db','payments'),spec:{type:'ClusterIP',clusterIP:'10.0.100.20',selector:{app:'ledger-db'},ports:[{port:5432,protocol:'TCP'}]}},{...meta('web-frontend','web'),spec:{type:'LoadBalancer',clusterIP:'10.0.100.30',selector:{app:'web-frontend'},ports:[{port:80,targetPort:8080,protocol:'TCP'}]},status:{loadBalancer:{ingress:[{ip:'20.41.0.10'}]}}}],
    'endpointslices.discovery.k8s.io':[
      {...meta('payments-api-x7k2p','payments',{labels:{'kubernetes.io/service-name':'payments-api'}}),endpoints:[{addresses:['10.10.8.20'],conditions:{ready:true},targetRef:{kind:'Pod',name:'payments-api-7d9c-abcde',namespace:'payments'}},{addresses:['10.10.8.21'],conditions:{ready:true},targetRef:{kind:'Pod',name:'payments-api-7d9c-fghij',namespace:'payments'}}]},
      {...meta('ledger-db-q8w4e','payments',{labels:{'kubernetes.io/service-name':'ledger-db'}}),endpoints:[{addresses:['10.10.8.40'],conditions:{ready:true},targetRef:{kind:'Pod',name:'ledger-db-0',namespace:'payments'}}]},
      {...meta('web-frontend-m3n5b','web',{labels:{'kubernetes.io/service-name':'web-frontend'}}),endpoints:[{addresses:['10.10.8.30'],conditions:{ready:true},targetRef:{kind:'Pod',name:'web-frontend-5c4b-klmno',namespace:'web'}}]},
    ],
    'ingresses.networking.k8s.io':[{...meta('web','web'),spec:{ingressClassName:'webapprouting.kubernetes.azure.com',rules:[{host:'shop.atlas.example',http:{paths:[{path:'/',backend:{service:{name:'web-frontend',port:{number:80}}}}]}}]}}],
    'networkpolicies.networking.k8s.io':[
      {...meta('default-deny-ingress','payments'),spec:{podSelector:{},policyTypes:['Ingress']}},
      {...meta('ledger-db-from-api','payments'),spec:{podSelector:{matchLabels:{app:'ledger-db'}},policyTypes:['Ingress'],ingress:[{from:[{podSelector:{matchLabels:{app:'payments-api'}}}],ports:[{port:5432,protocol:'TCP'}]}]}},
      {...meta('payments-api-from-web','payments'),spec:{podSelector:{matchLabels:{app:'payments-api'}},policyTypes:['Ingress'],ingress:[{from:[{namespaceSelector:{matchLabels:{'kubernetes.io/metadata.name':'web'}}}],ports:[{port:8443,protocol:'TCP'}]}]}},
    ],
    serviceaccounts:[{...meta('payments-api','payments',{annotations:{'azure.workload.identity/client-id':paymentsClientId}})},...['payments','web'].map(ns=>meta('default',ns))],
    'roles.rbac.authorization.k8s.io':[meta('config-reader','payments')],'clusterroles.rbac.authorization.k8s.io':[meta('cluster-admin')],
    'rolebindings.rbac.authorization.k8s.io':[{...meta('payments-api-config','payments'),roleRef:{kind:'Role',name:'config-reader'},subjects:[{kind:'ServiceAccount',name:'payments-api',namespace:'payments'}]}],
    'clusterrolebindings.rbac.authorization.k8s.io':[{...meta('aks-admins'),roleRef:{kind:'ClusterRole',name:'cluster-admin'},subjects:[{kind:'Group',name:'aks-cluster-admins'}]}],
    persistentvolumeclaims:[{...meta('data-ledger-db-0','payments'),spec:{volumeName:'pvc-7f3a2c1e',storageClassName:'managed-csi-premium',accessModes:['ReadWriteOnce'],resources:{requests:{storage:'64Gi'}}},status:{phase:'Bound'}}],
    persistentvolumes:[{...meta('pvc-7f3a2c1e'),spec:{capacity:{storage:'64Gi'},persistentVolumeReclaimPolicy:'Delete',csi:{driver:'disk.csi.azure.com',volumeHandle:pvDiskId(sub)}},status:{phase:'Bound'}}],
    'storageclasses.storage.k8s.io':[meta('managed-csi-premium')],
  };
}
