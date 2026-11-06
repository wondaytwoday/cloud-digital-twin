import { z } from 'zod';
export const Provider = z.enum(['azure', 'aws', 'gcp', 'onprem']);
export type Provider = z.infer<typeof Provider>;
export const ResourceKind = z.enum(['network','subnet','compute','firewall','appliance','gateway','loadbalancer','nat','database','storage','cluster','onprem','external','service']);
export type ResourceKind = z.infer<typeof ResourceKind>;
export const ResourceSchema = z.object({
  id: z.string(), nativeId: z.string(), name: z.string(), provider: Provider,
  kind: ResourceKind,
  type: z.string(), scope: z.string(), group: z.string().optional(), region: z.string(), parent: z.string().optional(),
  status: z.string().default('구성 수집됨'), ip: z.string().optional(), publicIp: z.string().optional(), cidr: z.string().optional(),
  routes: z.array(z.object({destination:z.string(),nextHop:z.string(),via:z.string()})).default([]),
  specs: z.record(z.string(), z.string()).default({}),
  rules: z.array(z.object({direction:z.string(),action:z.string(),protocol:z.string(),ports:z.string(),source:z.string(),destination:z.string(),priority:z.string()})).default([]),
  iam: z.array(z.object({principal:z.string(),role:z.string(),scope:z.string()})).default([]),
  tags: z.record(z.string(), z.string()).default({}), source: z.string(),
  metrics: z.object({cpu:z.number(),memory:z.number(),disk:z.number().optional(),gpu:z.number().optional(),history:z.array(z.number())}).optional(),
});
export type Resource = z.infer<typeof ResourceSchema>;
export const LinkSchema = z.object({id:z.string(),source:z.string(),target:z.string(),kind:z.enum(['attachment','policy','peering','route','simulation']),transit:z.boolean().optional(),label:z.string(), evidence:z.string(),protocol:z.string().optional(),ports:z.string().optional(),rate:z.string().optional()});
export type Link = z.infer<typeof LinkSchema>;
export const ConnectionSchema = z.object({provider:Provider,status:z.enum(['demo','collected','partial','missing','failed','unauthenticated','running']),api:z.string(),scopes:z.number(),collectedAt:z.string().optional(),message:z.string().optional()});
export type Connection = z.infer<typeof ConnectionSchema>;
export const HierarchyNodeSchema = z.object({id:z.string(),parent:z.string().optional(),name:z.string(),provider:Provider,kind:z.enum(['tenant','managementGroup','subscription','organization','ou','account','folder','project']),nativeId:z.string(),scope:z.string().optional()});
export type HierarchyNode = z.infer<typeof HierarchyNodeSchema>;
export const ChangeSchema = z.object({kind:z.enum(['added','removed','changed']),id:z.string(),name:z.string(),provider:Provider,scope:z.string(),detail:z.string()});
export type Change = z.infer<typeof ChangeSchema>;
export const CostRowSchema = z.object({provider:Provider,scope:z.string(),service:z.string(),month:z.string().regex(/^\d{4}-\d{2}$/),amount:z.number(),currency:z.string()});
export type CostRow = z.infer<typeof CostRowSchema>;
export const IamAssignmentSchema = z.object({id:z.string(),provider:Provider,principal:z.string(),principalType:z.enum(['user','group','serviceAccount','role','public','unknown']),role:z.string(),scope:z.string(),scopeName:z.string().optional(),level:z.enum(['org','group','scope','resource']),privileged:z.boolean(),external:z.boolean().default(false),mfa:z.boolean().optional(),keyAgeDays:z.number().optional(),source:z.string()});
export type IamAssignment = z.infer<typeof IamAssignmentSchema>;
// A change someone made in a cloud, read from Azure Activity Log, AWS CloudTrail or GCP Admin Activity audit logs.
export const ActivitySchema = z.object({id:z.string(),provider:Provider,at:z.string(),actor:z.string(),actorType:z.enum(['user','service','unknown']),operation:z.string(),label:z.string(),kind:z.enum(['write','delete','action']),target:z.string(),targetName:z.string(),scope:z.string(),outcome:z.enum(['ok','failed']),ip:z.string().optional(),source:z.string()});
export type Activity = z.infer<typeof ActivitySchema>;
// What people did in the portal itself. Written by the server, never part of a collected snapshot.
export const AuditEventSchema = z.object({id:z.string(),at:z.string(),actor:z.string(),action:z.enum(['login','login_failed','logout','denied','view','open','collect','export']),target:z.string().optional(),detail:z.string().optional(),ip:z.string().optional(),agent:z.string().optional(),demo:z.boolean().optional()});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export const FxSchema = z.object({base:z.string().regex(/^[A-Z]{3}$/),rates:z.record(z.string(),z.number().positive()),source:z.string()});
export const SnapshotSchema = z.object({version:z.literal(1),fx:FxSchema.optional(),activity:z.array(ActivitySchema).default([]),mode:z.enum(['mock','live']),scenario:z.string().optional(),collectedAt:z.string().datetime(),resources:z.array(ResourceSchema),links:z.array(LinkSchema),warnings:z.array(z.string()),scopes:z.array(z.string()),scopeLabels:z.record(z.string(),z.string()).default({}),connections:z.array(ConnectionSchema).default([]),hierarchy:z.array(HierarchyNodeSchema).default([]),incomplete:z.array(z.string()).default([]),cost:z.array(CostRowSchema).default([]),costAt:z.string().optional(),iam:z.array(IamAssignmentSchema).default([]),changes:z.object({since:z.string(),items:z.array(ChangeSchema)}).optional()});
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
  return s;
}
