import type {Resource} from './schema.js';
const byType:Record<string,string>={
  'microsoft.compute/virtualmachines':'azure/vm','microsoft.network/virtualnetworks':'azure/vnet','microsoft.network/virtualnetworks/subnets':'azure/subnet','microsoft.network/networksecuritygroups':'azure/nsg','microsoft.network/expressroutecircuits':'azure/expressroute','microsoft.network/virtualnetworkgateways':'azure/vgw','microsoft.network/azurefirewalls':'azure/firewall','microsoft.network/loadbalancers':'azure/lb','microsoft.network/applicationgateways':'azure/appgw','microsoft.network/natgateways':'azure/nat','microsoft.network/bastionhosts':'azure/bastion','microsoft.containerservice/managedclusters':'azure/aks','microsoft.sql/servers':'azure/sql','microsoft.cache/redis':'azure/redis','microsoft.documentdb/databaseaccounts':'azure/cosmos','microsoft.storage/storageaccounts':'azure/storage','microsoft.keyvault/vaults':'azure/keyvault','microsoft.web/sites':'azure/appservice','s3:bucket':'aws/s3','lambda:function':'aws/lambda','dynamodb:table':'aws/dynamodb','storage.googleapis.com/bucket':'gcp/storage','run.googleapis.com/service':'gcp/run','bigquery.googleapis.com/dataset':'gcp/bigquery',
  'aws::ec2::instance':'aws/ec2','aws::ec2::vpc':'aws/vpc','aws::ec2::transitgateway':'aws/tgw','aws::ec2::vpnconnection':'aws/vpn','aws::ec2::vpngateway':'aws/vgw','aws::ec2::internetgateway':'aws/igw','aws::ec2::natgateway':'aws/nat','aws::eks::cluster':'aws/eks','aws::directconnect::directconnectgateway':'aws/dx',
  'compute.googleapis.com/instance':'gcp/compute','compute.googleapis.com/network':'gcp/vpc','compute.googleapis.com/firewall':'gcp/firewall','compute.googleapis.com/router':'gcp/router','compute.googleapis.com/interconnectattachment':'gcp/interconnect','compute.googleapis.com/forwardingrule':'gcp/lb','compute.googleapis.com/vpntunnel':'gcp/vpn','container.googleapis.com/cluster':'gcp/gke','sqladmin.googleapis.com/instance':'gcp/sql','redis.googleapis.com/instance':'gcp/memorystore',
};
// Kinds this build ships no official CSP icon for; the UI draws a generic glyph and the icon test accepts them.
export const GLYPH_KINDS=new Set(['nic','disk','fileshare','bucket','endpoint','identity','node','namespace','workload','pod','k8sservice','ingress','serviceaccount','pvc','pv']);
// Undefined means the CSP publishes no icon for it (AWS security groups, GCP subnets) and the UI draws a generic glyph.
export function iconKey(r:Pick<Resource,'type'|'specs'>):string|undefined{
  const type=r.type.toLowerCase();
  if(type==='aws::ec2::subnet')return r.specs['공개 IP 자동 할당']==='true'?'aws/subnet-public':'aws/subnet-private';
  if(type==='aws::elasticloadbalancingv2::loadbalancer')return r.specs['종류']?.startsWith('network')?'aws/nlb':'aws/alb';
  if(type==='aws::rds::dbinstance')return r.specs['종류']?.startsWith('aurora')?'aws/aurora':'aws/rds';
  return byType[type];
}
export const providerLogo:Record<string,string>={azure:'azure/logo',aws:'aws/logo'};
export const groupIcon:Record<string,Record<string,string>>={aws:{region:'aws/region'}};
// GCP publishes no organization or folder icon, so those two draw generic glyphs.
export const hierarchyIcon:Record<string,string>={tenant:'azure/tenant',managementGroup:'azure/management-group',subscription:'azure/subscription',ou:'aws/ou',account:'aws/account',project:'gcp/project'};
