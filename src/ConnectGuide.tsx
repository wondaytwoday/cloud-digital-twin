import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Check,Copy,Info,TriangleAlert,X} from 'lucide-react';
import {connectors,troubleshooting} from '../shared/connectors';
import {ProviderMark} from './graph';
function CodeBlock({code,label}:{code:string;label:string}){
  const [copied,setCopied]=useState(false);
  return <div className="code-box"><pre>{code}</pre><button className="icon-button" aria-label={`${label} 복사`} onClick={async()=>{try{await navigator.clipboard.writeText(code);setCopied(true);setTimeout(()=>setCopied(false),1500);}catch{setCopied(false);}}}>{copied?<Check size={15}/>:<Copy size={15}/>}</button></div>;
}
type Health={mode:string;collector:boolean;serverless:boolean};
// Says up front whether this server can collect at all, since credentials put in the wrong place fail silently.
function WhereBanner({health}:{health:Health|null}){
  if(!health)return null;
  if(health.serverless)return <div className="notice warn guide-where"><TriangleAlert size={15}/><div><p><strong>이 웹사이트에서는 수집할 수 없습니다.</strong> Vercel 배포본은 예시 데이터만 보여줍니다. Vercel 환경 변수에 자격 증명을 넣어도 수집되지 않습니다.</p><p>아래 절차는 클라우드에 접근되는 PC나 서버에서 진행하세요.</p></div></div>;
  if(health.collector)return <div className="notice guide-where"><Info size={15}/><p><strong>이 서버는 실제 수집 모드입니다.</strong> 자격 증명을 바꾼 뒤에는 서버를 다시 시작하세요. 시작할 때 다시 수집합니다.</p></div>;
  return <div className="notice warn guide-where"><TriangleAlert size={15}/><p><strong>이 서버는 목데이터 모드입니다.</strong> 자격 증명을 넣어도 수집하지 않습니다. 서버를 끄고 <code>npm run live</code>로 다시 실행하세요.</p></div>;
}
export function ConnectGuide({close,firstVisit}:{close:()=>void;firstVisit:boolean}){
  const ref=useRef<HTMLDialogElement>(null),[provider,setProvider]=useState<'azure'|'aws'|'gcp'>('azure'),[health,setHealth]=useState<Health|null>(null);
  useEffect(()=>{const d=ref.current;if(d&&!d.open)d.showModal();return()=>d?.close();},[]);
  useEffect(()=>{let stale=false;fetch('/api/health').then(r=>r.json()).then(h=>{if(!stale)setHealth(h);}).catch(()=>{});return()=>{stale=true;};},[]);
  const connector=connectors.find(c=>c.provider===provider)!;
  return <dialog ref={ref} className="connector-dialog guide" aria-labelledby="guide-title" onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===e.currentTarget)close();}}>
    <div className="dialog-header"><div><h2 id="guide-title">클라우드 연결 가이드</h2><p>{firstVisit?'지금 보이는 데이터는 예시입니다. 실제 환경을 연결하려면 아래 순서를 따르세요. 닫으면 목데이터로 둘러볼 수 있습니다.':'자격 증명을 설정하고 npm run live로 서버를 실행하면 자원, IAM, 비용을 수집합니다.'}</p></div><button className="icon-button" onClick={close} aria-label="가이드 닫기"><X size={18}/></button></div>
    <div className="connector-tabs" role="tablist" aria-label="클라우드 선택">{connectors.map(c=><button key={c.provider} role="tab" aria-selected={provider===c.provider} className={provider===c.provider?'active':''} onClick={()=>setProvider(c.provider)}><ProviderMark provider={c.provider}/>{c.name}</button>)}</div>
    <div className="connector-body" role="tabpanel">
      <WhereBanner health={health}/>
      <h3 className="guide-heading first">빠른 시작</h3>
      <p className="guide-summary">{connector.quick.summary}</p>
      <ol className="guide-steps">
        <li><h3>프로젝트 준비</h3><p>클라우드에 접근되는 PC나 서버에서 실행합니다.</p><CodeBlock code={'git clone https://github.com/wondaytwoday/cloud-digital-twin.git\ncd cloud-digital-twin\nnpm install'} label="프로젝트 준비 명령"/></li>
        <li><h3>자격 증명 설정</h3><p>{connector.quick.detail}</p><CodeBlock code={connector.quick.code} label="자격 증명 설정"/></li>
        <li><h3>연결 확인</h3><p>자원을 읽지 않고 자격 증명만 확인합니다. 안 되면 클라우드별 사유를 알려줍니다.</p><CodeBlock code="npm run check" label="연결 확인 명령"/></li>
        <li><h3>서버 실행</h3><p>시작하면 바로 수집하고, 터미널에 표시된 주소에서 단계별 진행 상황을 볼 수 있습니다. 자원은 1시간마다, 비용은 하루에 한 번 다시 읽습니다.</p><CodeBlock code="npm run live" label="실행 명령"/></li>
      </ol>
      <h3 className="guide-heading">조직 전체 수집</h3>
      <p className="guide-summary">{connector.summary}</p>
      <ol className="guide-steps">{connector.steps.map(s=><li key={s.title}><h3>{s.title}</h3><p>{s.detail}</p>{s.code&&<CodeBlock code={s.code} label={s.title}/>}</li>)}</ol>
      <h3 className="guide-heading">필요한 권한</h3>
      <table className="guide-perms"><tbody>{connector.permissions.map(p=><tr key={p.domain}><th scope="row">{p.domain}</th><td>{p.items.map(i=><div key={i}>{i}</div>)}</td></tr>)}</tbody></table>
      <h3 className="guide-heading">수집이 안 될 때</h3>
      <table className="guide-perms"><tbody>{[...troubleshooting,...connector.troubleshooting].map(t=><tr key={t.problem}><th scope="row">{t.problem}</th><td>{t.fix}</td></tr>)}</tbody></table>
      <div className="notice"><Info size={15}/><div>{connector.notes.map(n=><p key={n}>{n}</p>)}<p>이 절차와 수집기는 아직 실제 계정으로 검증하지 않았습니다. 인증 정보는 브라우저에 입력하지 않습니다.</p></div></div>
      <div className="guide-links">{connector.docs.map(d=><a key={d.url} className="text-link" href={d.url} target="_blank" rel="noreferrer">{d.label}<ArrowUpRight size={14}/></a>)}</div>
    </div>
    <div className="dialog-footer"><span>이 가이드는 상단의 클라우드 연결에서 다시 볼 수 있습니다.</span><button className="button primary" onClick={close}>{firstVisit?'목데이터로 둘러보기':'닫기'}</button></div>
  </dialog>;
}
