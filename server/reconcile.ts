import type {Snapshot} from '../shared/schema.js';
import {finish,type Normalized} from './normalize.js';

// A partial read cannot prove that an old item disappeared. Keep its last known value
// with its age exposed, while replacing every item that was actually read this time.
export function retainIncomplete(result:Normalized,previous:Snapshot|null):Normalized{
  if(!previous||!result.incomplete?.length)return result;
  const missing=new Set(result.incomplete),fresh=new Set(result.resources.filter(r=>r.kind!=='external').map(r=>r.id));
  const retained=previous.resources.filter(r=>missing.has(r.scope)&&!fresh.has(r.id)).map(r=>({
    ...r,specs:{...r.specs,'수집 상태':'이번 수집에서 읽지 못해 이전 값 유지','이전 수집 시각':r.specs['이전 수집 시각']??previous.collectedAt},
  }));
  const retainedIds=new Set(retained.map(r=>r.id)),known=new Set([...fresh,...retainedIds]);
  const oldLinks=previous.links.filter(l=>(retainedIds.has(l.source)||retainedIds.has(l.target))&&
    [l.source,l.target].every(id=>known.has(id)||previous.resources.some(r=>r.id===id&&r.kind==='external')));
  const externals=previous.resources.filter(r=>r.kind==='external'&&!known.has(r.id)&&oldLinks.some(l=>l.source===r.id||l.target===r.id));
  const merged=finish([{...result,resources:[...result.resources.filter(r=>!retainedIds.has(r.id)),...retained,...externals],links:[...result.links,...oldLinks],
    hierarchy:[...new Map([...previous.hierarchy,...result.hierarchy??[]].map(n=>[n.id,n])).values()],
    scopeLabels:{...previous.scopeLabels,...result.scopeLabels},
    iam:[...result.iam??[],...previous.iam.filter(a=>missing.has(a.scope)&&!result.collectedScopes?.includes(a.scope)&&!(result.iam??[]).some(n=>n.id===a.id)).map(a=>({...a,source:`${a.source} · 이전 수집 ${previous.collectedAt}`}))],
    activity:[...result.activity??[],...previous.activity.filter(a=>missing.has(a.scope))],
  }]);
  return{...merged,collectedScopes:[...new Set([...result.collectedScopes??[],...previous.scopes.filter(s=>missing.has(s))])]};
}
