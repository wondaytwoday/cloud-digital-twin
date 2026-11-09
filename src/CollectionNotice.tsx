import type {Snapshot} from '../shared/schema';
import {inScope,type Focus} from '../shared/hierarchy';
const reasons={denied:'권한 없음',failed:'조회 실패',unavailable:'해당 리전 미지원·비활성'};
export function CollectionNotice({snapshot,focus}:{snapshot:Snapshot;focus:Focus}){
  const gaps=snapshot.collectionGaps.filter(g=>inScope(focus,g.provider,g.scope));
  if(!gaps.length)return null;
  return <details className="collection-notice"><summary>조회하지 못한 API {gaps.length}건 · 사유 보기</summary><ul>{gaps.map((g,i)=><li key={`${g.scope}:${g.region}:${g.operation}:${i}`}>{g.provider.toUpperCase()} · {snapshot.scopeLabels[g.scope]??g.scope} · {g.region??'전역'} · {g.operation}: <strong>{reasons[g.reason]}</strong> ({g.code})</li>)}</ul></details>;
}
