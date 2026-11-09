import type {Snapshot} from './schema.js';
import {inScope,type Focus} from './hierarchy.js';

export const costIssues=(snapshot:Snapshot,focus:Focus)=>snapshot.costCoverage.filter(c=>
  c.state!=='complete'&&(focus.provider==='all'||focus.provider===c.provider)&&
  (!focus.scopes||c.state==='unconfigured'||c.state==='failed'||c.failedScopes.some(s=>inScope(focus,c.provider,s)))
).map(c=>({...c,failedScopes:c.failedScopes.filter(s=>inScope(focus,c.provider,s))}));

export function networkEmptyMessage(snapshot:Snapshot,focus:Focus){
  const resources=snapshot.resources.filter(r=>inScope(focus,r.provider,r.scope));
  const gaps=snapshot.collectionGaps.filter(g=>inScope(focus,g.provider,g.scope)&&/Describe(Vpcs|Subnets|.*Gateway.*|VpcPeeringConnections|RouteTables|SecurityGroups|LoadBalancers)/.test(g.operation));
  const knownScopes=new Set(snapshot.hierarchy.filter(n=>n.scope&&(focus.provider==='all'||n.provider===focus.provider)).map(n=>n.scope!));
  for(const r of resources)knownScopes.add(r.scope);
  if(gaps.some(g=>g.reason==='denied'))return '권한이 없어 일부 네트워크 구성을 읽지 못했습니다. 수집 상태의 실패한 API와 읽기 권한을 확인하세요.';
  if(gaps.some(g=>g.reason==='failed')||snapshot.incomplete.some(s=>focus.scopes?focus.scopes.has(s):focus.provider==='all'||knownScopes.has(s)))return '일부 범위를 수집하지 못했습니다. 수집 상태를 확인하고 다시 수집하세요.';
  const connections=snapshot.connections.filter(c=>focus.provider==='all'||c.provider===focus.provider);
  if(connections.some(c=>['failed','unauthenticated','running','missing'].includes(c.status)))return '아직 네트워크 수집을 완료하지 못했습니다. 클라우드 연결과 수집 상태를 확인하세요.';
  const collected=focus.scopes?snapshot.scopes.some(s=>focus.scopes!.has(s)):focus.provider==='all'?snapshot.scopes.length>0:knownScopes.size>0||connections.some(c=>['collected','partial'].includes(c.status)&&c.scopes>0);
  if(!resources.length&&!collected)return '이 범위는 아직 수집하지 않았습니다. 수집 범위와 클라우드 연결을 확인하세요.';
  return resources.length?'이 범위에 수집된 네트워크 자원이 없습니다. 워크로드 표시를 켜거나 리소스 목록을 확인하세요.':'완료된 수집 결과에 이 범위의 자원이 없습니다.';
}
