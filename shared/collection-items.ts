import {z} from 'zod';
import type {Resource} from './schema.js';
export const CollectionItem=z.enum(['network','compute','database','containers','storage','inventory','iam','activity','cost']);
export type CollectionItem=z.infer<typeof CollectionItem>;
export const collectionItems=CollectionItem.options;
export const collectionLabels:Record<CollectionItem,string>={network:'네트워크·보안 정책',compute:'VM',database:'데이터베이스',containers:'Kubernetes 클러스터',storage:'스토리지',inventory:'기타 서비스·설정',iam:'IAM 역할 할당',activity:'클라우드 변경 기록',cost:'비용'};
export const CollectionProvider=z.enum(['azure','aws','gcp']);
export type CollectionProvider=z.infer<typeof CollectionProvider>;
export const SelectionSchema=z.discriminatedUnion('mode',[
  z.object({mode:z.literal('all')}).strict(),
  z.object({mode:z.literal('selected'),items:z.array(z.object({provider:CollectionProvider,item:CollectionItem}).strict()).min(1).max(27)}).strict(),
]);
export type CollectionSelection=z.infer<typeof SelectionSchema>;
export function selectedItems(selection:CollectionSelection,provider:CollectionProvider):CollectionItem[]{
  if(selection.mode==='all')return [...collectionItems];
  const result=new Set(selection.items.filter(i=>i.provider===provider).map(i=>i.item));
  if(['compute','database','containers'].some(i=>result.has(i as CollectionItem)))result.add('network');
  return [...result].sort();
}
const types={
  azure:{compute:['microsoft.compute/virtualmachines'],database:['microsoft.sql/servers','microsoft.cache/redis','microsoft.documentdb/databaseaccounts'],containers:['microsoft.containerservice/managedclusters'],storage:['microsoft.storage/storageaccounts','microsoft.compute/disks']},
  gcp:{compute:['compute.googleapis.com/Instance'],database:['sqladmin.googleapis.com/Instance','redis.googleapis.com/Instance'],containers:['container.googleapis.com/Cluster'],storage:['storage.googleapis.com/Bucket','compute.googleapis.com/Disk'],network:['compute.googleapis.com/Network','compute.googleapis.com/Subnetwork','compute.googleapis.com/Firewall','compute.googleapis.com/Router','compute.googleapis.com/InterconnectAttachment','compute.googleapis.com/ForwardingRule','compute.googleapis.com/VpnTunnel','compute.googleapis.com/Route']},
  aws:{compute:['AWS::EC2::Instance'],database:['AWS::RDS::DBInstance'],containers:['AWS::EKS::Cluster'],storage:['s3:bucket','ec2:volume','efs:file-system','fsx:file-system','AWS::S3::Bucket','AWS::EC2::Volume','AWS::EFS::FileSystem','AWS::FSx::FileSystem']},
};
// Collection ownership follows the API which produces a row, never its UI tier.
export function resourceItem(r:Pick<Resource,'provider'|'source'|'type'>):CollectionItem{
  if(r.source==='AWS Resource Explorer')return types.aws.storage.some(type=>type.toLowerCase()===r.type.toLowerCase())?'storage':'inventory';
  if(r.provider==='onprem')return 'inventory';
  const t=r.type.toLowerCase(),known=types[r.provider];
  for(const item of ['compute','database','containers','storage'] as const)if(known[item].some(type=>type.toLowerCase()===t))return item;
  if(r.provider==='azure'&&t.startsWith('microsoft.network/'))return 'network';
  if(r.provider==='gcp'&&types.gcp.network.some(type=>type.toLowerCase()===t))return 'network';
  if(r.provider==='aws'&&r.source==='AWS Describe APIs')return 'network';
  return 'inventory';
}
export function assetTypes(items:CollectionItem[]):string[]{
  if(items.includes('inventory'))return [];
  return items.flatMap(item=>item in types.gcp?types.gcp[item as keyof typeof types.gcp]:[]);
}
export function azureResourceQuery(base:string,items:CollectionItem[]):string{
  const known=[...types.azure.compute,...types.azure.database,...types.azure.containers,...types.azure.storage];
  const conditions=items.flatMap(item=>item==='network'?["type startswith 'microsoft.network/'"]:item==='inventory'?[`not(type startswith 'microsoft.network/') and type !in~ (${known.map(t=>`'${t}'`).join(',')})`]:item in types.azure?[`type in~ (${types.azure[item as keyof typeof types.azure].map(t=>`'${t}'`).join(',')})`]:[]);
  return base.replace('Resources |',`Resources | where ${conditions.length?conditions.map(c=>`(${c})`).join(' or '):'false'} |`);
}
export const hasResourceItems=(items:CollectionItem[])=>items.some(i=>['network','compute','database','containers','storage','inventory'].includes(i));

export const coreCollectionItems:CollectionItem[]=['network','compute','database','containers','storage','iam'];
export const initialCollection:CollectionSelection={mode:'selected',items:CollectionProvider.options.flatMap(provider=>coreCollectionItems.map(item=>({provider,item})))};
export const awsStorageTypes=['s3:bucket','ec2:volume','efs:file-system','fsx:file-system'];
