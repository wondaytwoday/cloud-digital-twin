export type Raw=Record<string,any>;
export type AwsAccount={account:string;label:string;region:string;api:Record<string,any>};
// One shape for all three org trees; the demo transports render it as each provider's API response.
export type OrgTree={id:string;name:string;scope?:string;children?:OrgTree[]};
export type {Site} from '../onprem.js';
import type {Site} from '../onprem.js';
// assignments: role assignments beyond the per-subscription defaults, at any scope, for a principal ID the fixture also gives an identity.
export type AzureAssignment={scope:string;principalId:string;principalType:string;role:string;name:string};
// kubernetes: clusters read through the Kubernetes API, as kubectl would return them.
export type KubeFixture={binding:import('../kubernetes.js').ClusterBinding;items:import('../kubernetes.js').KubeList};
// firewallPolicies: rule collection groups per policy ID, served as GET {policy}/ruleCollectionGroups returns them.
export type Scenario={kubernetes?:KubeFixture[];azure?:{subscriptions:Record<string,string>;rows:Raw[];tree?:OrgTree;assignments?:AzureAssignment[];firewallPolicies?:Record<string,Raw[]>;serviceTags?:{name:string;prefixes:string[]}[]};aws?:AwsAccount[];awsOrg?:OrgTree;gcp?:{parent:string;assets:Raw[];tree?:OrgTree;routerStatus?:Record<string,Raw>};onprem?:Site[];flows?:{hops:string[];rate:string}[]};
