import {AlertTriangle} from 'lucide-react';
import type {Coverage,Dataset,Snapshot} from '../shared/schema';
import {PROVIDER_LABEL} from '@/ui/viz';
const DATASET:Record<Dataset,string>={iam:'IAM 역할 할당',activity:'클라우드 변경 기록',cost:'비용'};
const STATE:Record<Exclude<Coverage,'ok'>,string>={partial:'일부 누락',failed:'수집 실패',unconfigured:'설정 안 됨'};
// Clouds whose last run could not read this kind of data. Their zero is "unknown", not "none".
export function coverageGaps(snapshot:Snapshot,dataset:Dataset,provider='all'){
  return snapshot.connections.filter(c=>c.provider!=='onprem'&&(provider==='all'||c.provider===provider)).flatMap(c=>{const state=c.datasets?.[dataset];return state&&state!=='ok'?[{provider:c.provider,state}]:[];});
}
export const gapHint=(gaps:ReturnType<typeof coverageGaps>)=>gaps.map(g=>`${PROVIDER_LABEL[g.provider]} ${STATE[g.state]}`).join(' · ');
export function CoverageNotice({snapshot,dataset,provider}:{snapshot:Snapshot;dataset:Dataset;provider:string}){
  const gaps=coverageGaps(snapshot,dataset,provider);if(!gaps.length)return null;
  return <div className="notice warn page-notice" role="status"><AlertTriangle size={15}/><p>{DATASET[dataset]}: {gapHint(gaps)}. 해당 클라우드의 숫자는 실제보다 적거나 0으로 보일 수 있습니다. 사유는 수집 상태에서 확인하세요.</p></div>;
}
