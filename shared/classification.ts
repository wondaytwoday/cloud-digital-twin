import type {Provider,Resource,ResourceKind} from './schema.js';

type Classification={kind:ResourceKind;auxiliary?:boolean};
// Exact provider types live here; unknown types remain visible as unclassified services.
const groups:Record<string,{kind:ResourceKind;auxiliary?:boolean;types:string[]}[]>={
  azure:[
    {kind:'dns',types:['microsoft.network/dnszones','microsoft.network/privatednszones','microsoft.network/dnsresolvers']},
    {kind:'dns',auxiliary:true,types:['microsoft.network/privatednszones/virtualnetworklinks','microsoft.network/dnszones/a','microsoft.network/privatednszones/a']},
    {kind:'monitoring',types:['microsoft.insights/components','microsoft.operationalinsights/workspaces']},
    {kind:'monitoring',auxiliary:true,types:['microsoft.insights/metricalerts','microsoft.insights/scheduledqueryrules','microsoft.insights/activitylogalerts','microsoft.insights/actiongroups','microsoft.insights/diagnosticsettings','microsoft.insights/datacollectionrules']},
    {kind:'security',types:['microsoft.keyvault/vaults','microsoft.network/firewallpolicies','microsoft.network/applicationsecuritygroups','microsoft.managedidentity/userassignedidentities','microsoft.authorization/policyassignments']},
    {kind:'security',auxiliary:true,types:['microsoft.network/firewallpolicies/rulecollectiongroups','microsoft.authorization/policydefinitions','microsoft.security/automations']},
    {kind:'logging',types:['microsoft.eventhub/namespaces','microsoft.storage/storageaccounts/blobservices']},
    {kind:'logging',auxiliary:true,types:['microsoft.network/networkwatchers/flowlogs','microsoft.network/networkwatchers']},
    {kind:'analytics',types:['microsoft.datafactory/factories','microsoft.synapse/workspaces','microsoft.databricks/workspaces','microsoft.kusto/clusters','microsoft.powerbidedicated/capacities']},
    {kind:'configuration',auxiliary:true,types:['microsoft.compute/virtualmachines/extensions','microsoft.resources/deployments','microsoft.automation/automationaccounts','microsoft.web/serverfarms','microsoft.recoveryservices/vaults/backuppolicies']},
    {kind:'storage',types:['microsoft.compute/disks','microsoft.storage/storageaccounts/fileservices']},
    {kind:'application',types:['microsoft.web/sites','microsoft.compute/virtualmachinescalesets','microsoft.app/containerapps','microsoft.containerinstance/containergroups']},
    {kind:'database',types:['microsoft.sql/servers/databases','microsoft.dbforpostgresql/flexibleservers','microsoft.dbformysql/flexibleservers']},
  ],
  aws:[
    {kind:'dns',types:['route53:hostedzone','route53resolver:resolver-endpoint']},
    {kind:'dns',auxiliary:true,types:['route53resolver:resolver-rule','route53resolver:resolver-rule-association']},
    {kind:'monitoring',types:['cloudwatch:dashboard']},
    {kind:'monitoring',auxiliary:true,types:['cloudwatch:alarm','sns:topic']},
    {kind:'security',types:['kms:key','secretsmanager:secret','iam:role','iam:policy','acm:certificate','wafv2:webacl','guardduty:detector']},
    {kind:'security',auxiliary:true,types:['config:config-rule','config:configuration-recorder','securityhub:hub']},
    {kind:'logging',types:['logs:log-group','cloudtrail:trail']},
    {kind:'logging',auxiliary:true,types:['ec2:flow-log','logs:log-stream']},
    {kind:'analytics',types:['athena:workgroup','glue:database','glue:table','redshift:cluster','kinesis:stream','quicksight:analysis']},
    {kind:'analytics',auxiliary:true,types:['quicksight:dataset','quicksight:datasource','quicksight:data-set','quicksight:data-source']},
    {kind:'configuration',auxiliary:true,types:['cloudformation:stack','cloudformation:stackset','cloudformation:stack-set','ssm:document','ssm:parameter','ec2:launch-template']},
    {kind:'storage',types:['s3:bucket','ec2:volume','elasticfilesystem:file-system','backup:backup-vault']},
    {kind:'application',types:['lambda:function','ecs:service','ecs:task']},
    {kind:'database',types:['dynamodb:table','elasticache:cluster','rds:cluster']},
    {kind:'cluster',types:['ecs:cluster']},
  ],
  gcp:[
    {kind:'dns',types:['dns.googleapis.com/managedzone','dns.googleapis.com/policy']},
    {kind:'monitoring',auxiliary:true,types:['monitoring.googleapis.com/alertpolicy','monitoring.googleapis.com/notificationchannel','monitoring.googleapis.com/uptimecheckconfig']},
    {kind:'security',types:['cloudkms.googleapis.com/cryptokey','cloudkms.googleapis.com/keyring','secretmanager.googleapis.com/secret','iam.googleapis.com/serviceaccount','compute.googleapis.com/securitypolicy']},
    {kind:'logging',types:['logging.googleapis.com/logbucket','logging.googleapis.com/logsink','pubsub.googleapis.com/topic']},
    {kind:'logging',auxiliary:true,types:['logging.googleapis.com/logmetric']},
    {kind:'analytics',types:['bigquery.googleapis.com/dataset','bigquery.googleapis.com/table','dataflow.googleapis.com/job','dataproc.googleapis.com/cluster']},
    {kind:'configuration',auxiliary:true,types:['serviceusage.googleapis.com/service','compute.googleapis.com/instancetemplate','deploymentmanager.googleapis.com/deployment','cloudbuild.googleapis.com/buildtrigger']},
    {kind:'storage',types:['storage.googleapis.com/bucket','compute.googleapis.com/disk','file.googleapis.com/instance']},
    {kind:'application',types:['run.googleapis.com/service','cloudfunctions.googleapis.com/cloudfunction','appengine.googleapis.com/service']},
    {kind:'database',types:['firestore.googleapis.com/database','spanner.googleapis.com/instance']},
  ],
};
export const RESOURCE_CLASSIFICATIONS=new Map(Object.entries(groups).flatMap(([provider,entries])=>entries.flatMap(({types,...classification})=>types.map(type=>[`${provider}:${type.toLowerCase()}`,classification] as const))));
export const classifyResource=(provider:Provider,type:string):Classification=>RESOURCE_CLASSIFICATIONS.get(`${provider}:${type.toLowerCase()}`)??{kind:'service'};
export const isAuxiliary=(r:Pick<Resource,'provider'|'type'|'auxiliary'>)=>r.auxiliary??classifyResource(r.provider,r.type).auxiliary??false;
const NETWORK_KINDS=new Set<ResourceKind>(['network','subnet','gateway','appliance','loadbalancer','nat','onprem','external','firewall']);
export const isNetworkResource=(r:Pick<Resource,'kind'>)=>NETWORK_KINDS.has(r.kind);
export const classificationSummary=(resources:Resource[])=>{
  const counts=new Map<string,number>();
  for(const r of resources)if(r.kind==='service')counts.set(`${r.provider}:${r.type}`,(counts.get(`${r.provider}:${r.type}`)??0)+1);
  return [...counts].map(([type,count])=>({type,count})).sort((a,b)=>b.count-a.count||a.type.localeCompare(b.type)).slice(0,10);
};
