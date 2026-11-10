import type {Snapshot,CostCoverage} from './schema.js';
import {inScope,type Focus} from './hierarchy.js';

export const costIssues=(snapshot:Snapshot,focus:Focus)=>[
  ...snapshot.costCoverage,
  // Missing coverage in version 1 is unverified, including a cached empty result.
  ...(['azure','aws','gcp'] as const).filter(provider=>!snapshot.costCoverage.some(c=>c.provider===provider)&&snapshot.mode==='live'&&(snapshot.cost.some(c=>c.provider===provider)||snapshot.resources.some(r=>r.provider===provider)||snapshot.hierarchy.some(n=>n.provider===provider))).map(provider=>({provider,state:'failed' as const,failedScopes:[],reason:'unverified' as const})),
].filter(c=>
  c.state!=='complete'&&(focus.provider==='all'||focus.provider===c.provider)&&
  (!focus.scopes||c.state==='unconfigured'||c.state==='failed'||c.state==='pending'||c.failedScopes.some(s=>inScope(focus,c.provider,s)))
).map(c=>({...c,failedScopes:c.failedScopes.filter(s=>inScope(focus,c.provider,s))}));

export function costCoverageMessage(c:CostCoverage){
  const unit=c.unit==='organization'?'조직 단위 비용 조회 1건':c.failedScopes.length?`${c.failedScopes.length}개 범위 조회`:'비용 조회';
  if(c.state==='unconfigured')return '비용 수집 미설정';
  switch(c.reason){
    case 'waiting-data':return '결제 내보내기 데이터 대기 중. 첫 데이터가 쌓인 뒤 수집하면 자동 반영됩니다. 이전 비용이 있으면 유지합니다.';
    case 'unverified':return '이전 비용의 완전성 검증 안 됨. 다음 수집에서 다시 조회합니다.';
    case 'skipped-timeout':return `${unit} 미완료: 전체 수집 시간 초과로 건너뛰었거나 완료하지 못했습니다. 제한 시간을 늘리면 다음 수집에서 재시도합니다.`;
    case 'timeout':return `${unit} 실패: 요청 시간 초과. 다음 수집에서 재시도하며 제한 시간과 네트워크를 확인하세요.`;
    case 'denied':return `${unit} 실패: 권한 거부. 결제 조회 자격 증명과 ce:GetCostAndUsage 권한을 확인하세요.`;
    case 'throttled':return `${unit} 실패: 속도 제한. 다음 수집에서 다시 조회합니다.`;
    case 'network':return `${unit} 실패: 네트워크 오류. 프록시·DNS·인증서 연결을 확인하세요.`;
    default:return `${unit} 실패: 원인 미확인. 수집 상태를 확인하세요.`;
  }
}

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
