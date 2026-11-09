import type {Snapshot} from '../shared/schema';
import type {Focus} from '../shared/hierarchy';
import {costIssues} from '../shared/collectionView';
const NAMES:Record<string,string>={azure:'Azure',aws:'AWS',gcp:'Google Cloud'};
export function CostNotice({snapshot,focus}:{snapshot:Snapshot;focus:Focus}){
  const issues=costIssues(snapshot,focus);
  if(!issues.length)return null;
  return <div className="notice warn page-notice" role="status"><p><strong>비용 일부 누락 · </strong>{issues.map(c=>`${NAMES[c.provider]??c.provider}: ${c.state==='unconfigured'?'비용 수집 미설정':c.failedScopes.length?`${c.failedScopes.length}개 범위 조회 실패`:'비용 조회 실패'}`).join(' / ')}. 이전에 수집한 비용이 있으면 유지합니다. 합계는 최신 전체 금액이 아닐 수 있습니다. 수집 상태와 비용 조회 권한을 확인하세요.</p></div>;
}
