import type {Snapshot} from './schema.js';
import {health} from './topology.js';
export function projectSnapshot(snapshot:Snapshot,part:string):Snapshot{
  const parts=['scopes','dashboard','map','inventory','network','security','iam','audit','cost','findings','changes'];
  if(!parts.includes(part))return snapshot;
  const scopeStats:Record<string,{resources:number;networks:number;warn:number;stopped:number}>={};
  for(const r of snapshot.resources){
    if(r.scope==='external'||r.provider==='onprem')continue;
    const s=scopeStats[r.scope]??={resources:0,networks:0,warn:0,stopped:0};
    s.resources++;if(r.kind==='network')s.networks++;
    if(r.kind!=='firewall'&&r.kind!=='subnet'){if(health(r.status)==='warn')s.warn++;if(health(r.status)==='stopped')s.stopped++;}
  }
  const resources=['scopes','cost','iam','inventory'].includes(part)?[]:snapshot.resources;
  const iam=['iam','map','dashboard','findings'].includes(part)?snapshot.iam:[];
  const cost=['cost','dashboard','findings'].includes(part)?snapshot.cost:[];
  const activity:Snapshot['activity']=[];
  const activityGroups=new Map<string,{provider:Snapshot['activity'][number]['provider'];scope:string;day:string;kind:Snapshot['activity'][number]['kind'];count:number}>();
  if(part==='dashboard')for(const a of snapshot.activity){const key=JSON.stringify([a.provider,a.scope,a.at.slice(0,10),a.kind]);let group=activityGroups.get(key);if(!group){group={provider:a.provider,scope:a.scope,day:a.at.slice(0,10),kind:a.kind,count:0};activityGroups.set(key,group);}group.count++;}
  return{...snapshot,resources,links:resources.length?snapshot.links:[],iam,cost,activity,
    changes:['changes','dashboard','findings'].includes(part)?snapshot.changes:undefined,
    presentation:{part,scopeStats,...(part==='dashboard'?{activitySummary:[...activityGroups.values()]}:{})},
  };
}
