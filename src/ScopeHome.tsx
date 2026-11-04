import {ArrowRight,Network,Plug} from 'lucide-react';
import type {Snapshot} from '../shared/schema';
import {hierarchyNouns,type ScopeIndex} from '../shared/hierarchy';
import {ProviderMark} from './graph';
import {Attention} from './Detail';
import {providerNames} from './layout';
import {ScopeTree} from './ScopeTree';
import {connectors} from '../shared/connectors';
const leafNoun:Record<string,string>={azure:'구독',aws:'계정',gcp:'프로젝트'};
const badgeLabel:Record<string,string>={demo:'로그인 전',collected:'수집됨',partial:'일부 누락',missing:'미수집',failed:'수집 실패',unauthenticated:'로그인 필요',running:'수집 중'};
const badgeTone:Record<string,string>={demo:'amber',collected:'',partial:'amber',missing:'neutral',failed:'red',unauthenticated:'amber',running:'neutral'};
const groupKinds=new Set(['managementGroup','ou','folder']);
export function ScopeHome({snapshot,index,onOpen,onConnect,onSelectResource}:{snapshot:Snapshot;index:ScopeIndex;onOpen:(id:string)=>void;onConnect:()=>void;onSelectResource:(id:string)=>void}){
  const leaves=snapshot.hierarchy.filter(n=>n.scope),real=snapshot.resources.filter(r=>r.provider!=='onprem'&&r.scope!=='external');
  const total=Object.values(index.roots).flat().reduce((s,n)=>{const x=index.stats.get(n.id);return{warn:s.warn+(x?.warn??0),stopped:s.stopped+(x?.stopped??0)};},{warn:0,stopped:0});
  return <div className="home"><div className="home-head"><div><h1>관리 범위</h1><p>조직 계층에서 범위를 고르면 그 범위의 토폴로지가 새 탭으로 열립니다.</p></div>
      <dl className="home-stats"><div><dt>범위</dt><dd>{leaves.length}</dd></div><div><dt>자원</dt><dd>{real.length}</dd></div><div className={total.warn?'warn':''}><dt>이상</dt><dd>{total.warn}</dd></div><div><dt>중지</dt><dd>{total.stopped}</dd></div></dl>
      <button className="button primary" onClick={()=>onOpen('all')}><Network size={15}/>전체 연결 지도</button></div>
    <div className="home-grid">
      {(['azure','aws','gcp'] as const).map(p=>{
        const roots=index.roots[p],nodes=snapshot.hierarchy.filter(n=>n.provider===p),scopes=nodes.filter(n=>n.scope).length,groups=nodes.filter(n=>groupKinds.has(n.kind)).length,count=real.filter(r=>r.provider===p).length,hasOrg=nodes.some(n=>!n.scope);
        const connection=snapshot.connections.find(c=>c.provider===p);
        return <section className={`cloud-card ${p}`} key={p} aria-label={providerNames[p]}>
          <header><ProviderMark provider={p}/><div><h2>{providerNames[p]}</h2>{nodes.length?<p>{groups>0&&<>{hierarchyNouns[p==='azure'?'managementGroup':p==='aws'?'ou':'folder']} {groups} · </>}{leafNoun[p]} {scopes} · 자원 {count}</p>:<p>{snapshot.mode==='live'?'아직 수집되지 않음':'이 예시에는 없음'}</p>}</div>
            {connection&&<span className={`badge ${badgeTone[connection.status]}`}>{badgeLabel[connection.status]}</span>}</header>
          {connection?.message&&connection.status!=='unauthenticated'&&<p className="cloud-note" role="status">{connection.message}</p>}
          {nodes.length?<>
            <div className="cloud-body"><ScopeTree index={index} nodes={roots} onOpen={onOpen}/></div>
            {!hasOrg&&<p className="cloud-note">조직 계층을 읽지 않았거나 조직을 쓰지 않아 {leafNoun[p]}만 표시합니다.</p>}
            <footer><button className="link-button" onClick={()=>onOpen(`provider:${p}`)}>{p==='azure'?'Azure':p==='aws'?'AWS':'Google Cloud'} 토폴로지<ArrowRight size={14}/></button></footer>
          </>:<div className="cloud-empty">{connection?.status==='unauthenticated'&&<div className="code-box"><pre>{connectors.find(c=>c.provider===p)?.command}</pre></div>}<button className="button" onClick={onConnect}><Plug size={14}/>연결 방법 보기</button></div>}
        </section>;
      })}
      <aside className="attention-rail" aria-label="확인 필요">{snapshot.mode==='live'&&!snapshot.resources.some(r=>r.provider==='onprem')&&<p className="cloud-note onprem-note">사내망은 CSP API로 알 수 없습니다. 지도에 표시하려면 <code>data/onprem.json</code>에 등록하세요. 자세한 형식은 README에 있습니다.</p>}<Attention snapshot={snapshot} onSelect={onSelectResource}/>
        <p className="rail-note">{snapshot.mode==='live'?'수집 시점의 구성입니다. 사용률과 IAM은 미수집입니다.':'자원·사용률·트래픽은 모두 예제입니다.'} 수집 시각 {new Date(snapshot.collectedAt).toLocaleTimeString('ko-KR',{hour12:false})}</p></aside>
    </div></div>;
}
