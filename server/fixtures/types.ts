export type Raw=Record<string,any>;
export type AwsAccount={account:string;label:string;region:string;api:Record<string,any>};
// One shape for all three org trees; the demo transports render it as each provider's API response.
export type OrgTree={id:string;name:string;scope?:string;children?:OrgTree[]};
export type Site={id:string;name:string;region:string;cidr:string;connects:{name:string;label:string}[]};
export type Scenario={azure?:{subscriptions:Record<string,string>;rows:Raw[];tree?:OrgTree};aws?:AwsAccount[];awsOrg?:OrgTree;gcp?:{parent:string;assets:Raw[];tree?:OrgTree};onprem?:Site[];flows?:{hops:string[];rate:string}[]};
