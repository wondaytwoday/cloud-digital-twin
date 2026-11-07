import { z } from 'zod';
export const Provider = z.enum(['azure', 'aws', 'gcp', 'onprem']);
export type Provider = z.infer<typeof Provider>;
// Kinds are only ever added, so snapshots written by earlier versions still parse. 'firewall' is a security POLICY (NSG, security group,
// NACL, VPC firewall rule, Kubernetes NetworkPolicy); a device traffic passes through (Azure Firewall, NVA, AWS Network Firewall) is an 'appliance'.
export const ResourceKind = z.enum(['network','subnet','compute','firewall','appliance','gateway','loadbalancer','nat','database','storage','cluster','onprem','external','service',
  'nic','disk','fileshare','bucket','endpoint','identity','node','namespace','workload','pod','k8sservice','ingress','serviceaccount','pvc','pv']);
export type ResourceKind = z.infer<typeof ResourceKind>;
export const ResourceSchema = z.object({
  id: z.string(), nativeId: z.string(), name: z.string(), provider: Provider,
  kind: ResourceKind,
  type: z.string(), scope: z.string(), group: z.string().optional(), region: z.string(), parent: z.string().optional(),
  status: z.string().default('구성 수집됨'), ip: z.string().optional(), publicIp: z.string().optional(), cidr: z.string().optional(),
  // Every address a NIC or endpoint holds; ip/publicIp keep the primary one for older readers.
  addresses: z.array(z.object({ip:z.string(),public:z.boolean().optional(),primary:z.boolean().optional()})).optional(),
  // nextHopIp, target and origin are optional because route tables collected before they existed carry only the label.
  routes: z.array(z.object({destination:z.string(),nextHop:z.string(),via:z.string(),nextHopIp:z.string().optional(),target:z.string().optional(),priority:z.number().optional(),origin:z.enum(['user','system','propagated']).optional(),tags:z.array(z.string()).optional()})).default([]),
  // Kubernetes label selectors (Service, NetworkPolicy) and GCP network tags, read as matching keys rather than free text.
  selector: z.record(z.string(), z.string()).optional(), netTags: z.array(z.string()).optional(),
  // A router's own tables: which attached thing (a VPC, a VPN) uses which route table. Routes carry their table in tags.
  associations: z.record(z.string(), z.string()).optional(),
  specs: z.record(z.string(), z.string()).default({}),
  // peers names what a rule matches beyond addresses (a security group, an application security group, a service tag, a pod selector);
  // the analyser evaluates the ones it understands and reports the rest as unevaluated rather than guessing.
  rules: z.array(z.object({direction:z.string(),action:z.string(),protocol:z.string(),ports:z.string(),source:z.string(),destination:z.string(),priority:z.string(),name:z.string().optional(),peers:z.array(z.string()).optional()})).default([]),
  // Which members a policy applies to when that is narrower than where it is attached (GCP target tags and service accounts, a NetworkPolicy pod selector).
  appliesTo: z.object({tags:z.array(z.string()).optional(),serviceAccounts:z.array(z.string()).optional(),podSelector:z.record(z.string(),z.string()).optional(),namespace:z.string().optional(),policyTypes:z.array(z.string()).optional()}).optional(),
  iam: z.array(z.object({principal:z.string(),role:z.string(),scope:z.string()})).default([]),
  tags: z.record(z.string(), z.string()).default({}), source: z.string(),
  metrics: z.object({cpu:z.number(),memory:z.number(),disk:z.number().optional(),gpu:z.number().optional(),history:z.array(z.number())}).optional(),
});
export type Resource = z.infer<typeof ResourceSchema>;
// Relation kinds. The first five predate this list and keep their names so older snapshots read unchanged:
// attachment = attached_to (a NIC on a VM, a disk on a VM, a gateway on a network), peering = peers_with, route = routes_to,
// policy = policy_applies_to, simulation = demo traffic (never allowed in live data).
// contains is logical membership that parent cannot hold (a namespace holding a workload); parent stays network placement only.
// None of these is a statement that traffic flows: only the flow analyser decides that, from routes and policies.
export const LinkKind = z.enum(['attachment','policy','peering','route','simulation',
  'contains','owns','forwards_to','selects','resolves_to','private_link','runs_on','mounts','binds_to','uses_identity','role_binding','permission_evidence','observed_flow']);
export type LinkKind = z.infer<typeof LinkKind>;
// basis: configured = read as written in a cloud or Kubernetes API; inferred = derived by Atlas from configuration (and says how in evidence);
// observed = seen in flow or access logs; declared = entered by an operator (on-prem sites). Absent on links from older snapshots.
export const LinkSchema = z.object({id:z.string(),source:z.string(),target:z.string(),kind:LinkKind,transit:z.boolean().optional(),label:z.string(), evidence:z.string(),protocol:z.string().optional(),ports:z.string().optional(),rate:z.string().optional(),
  basis:z.enum(['configured','inferred','observed','declared']).optional(),ref:z.string().optional(),direction:z.enum(['forward','both']).optional(),note:z.string().optional()});
export type Link = z.infer<typeof LinkSchema>;
// A relation whose target lives in another collection (a Kubernetes node's VM, a PV's cloud disk). Resolved when snapshots are merged;
// one that finds nothing stays listed as unresolved instead of becoming an invented resource.
// match says how the target is found: its native ID (Azure IDs compared without case), the end of it (an AWS ID without account and region),
// or a spec value (an identity's clientId or e-mail). reverse makes the target the link's source (a cluster contains a namespace).
export const CrossRefSchema = z.object({source:z.string(),kind:LinkKind,provider:z.enum(['azure','aws','gcp']),nativeId:z.string(),match:z.enum(['id','suffix','clientId','email']).optional(),reverse:z.boolean().optional(),label:z.string(),evidence:z.string()});
export type CrossRef = z.infer<typeof CrossRefSchema>;
// Beyond inventory, each kind of data is read separately and can fail on its own; zero rows from a failed read must not look like zero findings.
export const Dataset = z.enum(['iam','activity','cost']);
export type Dataset = z.infer<typeof Dataset>;
export const Coverage = z.enum(['ok','partial','failed','unconfigured']);
export type Coverage = z.infer<typeof Coverage>;
export const CoverageMapSchema = z.partialRecord(Dataset, Coverage);
export const ConnectionSchema = z.object({provider:Provider,status:z.enum(['demo','collected','partial','missing','failed','unauthenticated','running']),api:z.string(),scopes:z.number(),collectedAt:z.string().optional(),message:z.string().optional(),stale:z.boolean().optional(),datasets:CoverageMapSchema.optional()});
export type Connection = z.infer<typeof ConnectionSchema>;
export const HierarchyNodeSchema = z.object({id:z.string(),parent:z.string().optional(),name:z.string(),provider:Provider,kind:z.enum(['tenant','managementGroup','subscription','organization','ou','account','folder','project']),nativeId:z.string(),scope:z.string().optional()});
export type HierarchyNode = z.infer<typeof HierarchyNodeSchema>;
export const ChangeSchema = z.object({kind:z.enum(['added','removed','changed']),id:z.string(),name:z.string(),provider:Provider,scope:z.string(),detail:z.string()});
export type Change = z.infer<typeof ChangeSchema>;
export const CostRowSchema = z.object({provider:Provider,scope:z.string(),service:z.string(),month:z.string().regex(/^\d{4}-\d{2}$/),amount:z.number(),currency:z.string()});
export type CostRow = z.infer<typeof CostRowSchema>;
export const IamAssignmentSchema = z.object({id:z.string(),provider:Provider,principal:z.string(),principalId:z.string().optional(),resourceScope:z.string().optional(),principalType:z.enum(['user','group','serviceAccount','role','public','unknown']),role:z.string(),scope:z.string(),scopeName:z.string().optional(),level:z.enum(['org','group','scope','resource']),privileged:z.boolean(),external:z.boolean().default(false),mfa:z.boolean().optional(),keyAgeDays:z.number().optional(),source:z.string()});
export type IamAssignment = z.infer<typeof IamAssignmentSchema>;
// A change someone made in a cloud, read from Azure Activity Log, AWS CloudTrail or GCP Admin Activity audit logs.
export const ActivitySchema = z.object({id:z.string(),provider:Provider,at:z.string(),actor:z.string(),actorType:z.enum(['user','service','unknown']),operation:z.string(),label:z.string(),kind:z.enum(['write','delete','action']),target:z.string(),targetName:z.string(),scope:z.string(),outcome:z.enum(['ok','failed']),ip:z.string().optional(),source:z.string()});
export type Activity = z.infer<typeof ActivitySchema>;
// What people did in the portal itself. Written by the server, never part of a collected snapshot.
export const AuditEventSchema = z.object({id:z.string(),at:z.string(),actor:z.string(),action:z.enum(['login','login_failed','logout','denied','view','open','collect','export']),target:z.string().optional(),detail:z.string().optional(),ip:z.string().optional(),agent:z.string().optional(),demo:z.boolean().optional()});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export const FxSchema = z.object({base:z.string().regex(/^[A-Z]{3}$/),rates:z.record(z.string(),z.number().positive()),source:z.string()});
// The tag keys this deployment reads ownership from; an operator setting, applied when read like fx.
export const OwnershipKeysSchema = z.object({owner:z.array(z.string()),service:z.array(z.string())});
export const SnapshotSchema = z.object({version:z.literal(1),fx:FxSchema.optional(),ownership:OwnershipKeysSchema.optional(),activity:z.array(ActivitySchema).default([]),mode:z.enum(['mock','live']),scenario:z.string().optional(),collectedAt:z.string().datetime(),resources:z.array(ResourceSchema),links:z.array(LinkSchema),warnings:z.array(z.string()),scopes:z.array(z.string()),scopeLabels:z.record(z.string(),z.string()).default({}),connections:z.array(ConnectionSchema).default([]),hierarchy:z.array(HierarchyNodeSchema).default([]),incomplete:z.array(z.string()).default([]),crossRefs:z.array(CrossRefSchema).optional(),unresolved:z.array(z.object({source:z.string(),kind:z.string(),nativeId:z.string(),label:z.string()})).optional(),cost:z.array(CostRowSchema).default([]),costAt:z.string().optional(),iam:z.array(IamAssignmentSchema).default([]),coverage:CoverageMapSchema.optional(),changes:z.object({since:z.string(),items:z.array(ChangeSchema)}).optional()});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export function validateSnapshot(input: unknown): Snapshot {
  const s=SnapshotSchema.parse(input), ids=new Set(s.resources.map(r=>r.id));
  if(ids.size!==s.resources.length) throw new Error('Duplicate resource ID');
  for(const r of s.resources) if(r.parent&&!ids.has(r.parent)) throw new Error(`Missing parent: ${r.parent}`);
  const edgeIds=new Set<string>();
  for(const e of s.links){if(edgeIds.has(e.id))throw new Error('Duplicate link ID');edgeIds.add(e.id);if(!ids.has(e.source)||!ids.has(e.target))throw new Error(`Unresolved link: ${e.id}`);}
  const nodes=new Set(s.hierarchy.map(n=>n.id));
  for(const n of s.hierarchy)if(n.parent&&!nodes.has(n.parent))throw new Error(`Missing hierarchy parent: ${n.parent}`);
  if(s.mode==='live'&&s.activity.some(a=>a.id.startsWith('demo-')))throw new Error('Live collector must not include demo activity');
  if(s.mode==='live'&&(s.links.some(e=>e.kind==='simulation')||s.resources.some(r=>r.metrics||r.iam.length)))throw new Error('Live collector must not include synthetic telemetry or IAM');
  // No flow or access log source is connected yet, so a live observed relation can only be a mistake.
  if(s.mode==='live'&&s.links.some(e=>e.kind==='observed_flow'||e.basis==='observed'))throw new Error('Live collector has no observation source; observed relations are not allowed');
  return s;
}
