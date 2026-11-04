import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Check,Copy,Info,X} from 'lucide-react';
import {connectors} from '../shared/connectors';
import {ProviderMark} from './graph';
function CodeBlock({code,label}:{code:string;label:string}){
  const [copied,setCopied]=useState(false);
  return <div className="code-box"><pre>{code}</pre><button className="icon-button" aria-label={`${label} 복사`} onClick={async()=>{try{await navigator.clipboard.writeText(code);setCopied(true);setTimeout(()=>setCopied(false),1500);}catch{setCopied(false);}}}>{copied?<Check size={15}/>:<Copy size={15}/>}</button></div>;
}
export function ConnectGuide({close,firstVisit}:{close:()=>void;firstVisit:boolean}){
  const ref=useRef<HTMLDialogElement>(null),[provider,setProvider]=useState<'azure'|'aws'|'gcp'>('azure');
  useEffect(()=>{const d=ref.current;if(d&&!d.open)d.showModal();return()=>d?.close();},[]);
  const connector=connectors.find(c=>c.provider===provider)!;
  return <dialog ref={ref} className="connector-dialog guide" aria-labelledby="guide-title" onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===e.currentTarget)close();}}>
    <div className="dialog-header"><div><h2 id="guide-title">클라우드 연결 가이드</h2><p>{firstVisit?'지금 보이는 데이터는 예시입니다. 실제 환경을 연결하려면 아래 순서를 따르세요. 닫으면 목데이터로 둘러볼 수 있습니다.':'CSP별 읽기 권한을 준비하고 서버를 실행하면 자원, IAM, 비용이 자동으로 수집됩니다.'}</p></div><button className="icon-button" onClick={close} aria-label="가이드 닫기"><X size={18}/></button></div>
    <div className="connector-tabs" role="tablist" aria-label="클라우드 선택">{connectors.map(c=><button key={c.provider} role="tab" aria-selected={provider===c.provider} className={provider===c.provider?'active':''} onClick={()=>setProvider(c.provider)}><ProviderMark provider={c.provider}/>{c.name}</button>)}</div>
    <div className="connector-body" role="tabpanel">
      <p className="guide-summary">{connector.summary}</p>
      <ol className="guide-steps">{connector.steps.map(s=><li key={s.title}><h3>{s.title}</h3><p>{s.detail}</p>{s.code&&<CodeBlock code={s.code} label={s.title}/>}</li>)}<li><h3>서버 실행</h3><p>로그인된 클라우드를 찾아 수집합니다. 자원은 1시간마다, 비용은 하루에 한 번 다시 읽습니다. 수집한 클라우드부터 화면에 나타납니다.</p><CodeBlock code="npm run live" label="실행 명령"/></li></ol>
      <h3 className="guide-heading">필요한 권한</h3>
      <table className="guide-perms"><tbody>{connector.permissions.map(p=><tr key={p.domain}><th scope="row">{p.domain}</th><td>{p.items.map(i=><div key={i}>{i}</div>)}</td></tr>)}</tbody></table>
      <div className="notice"><Info size={15}/><div>{connector.notes.map(n=><p key={n}>{n}</p>)}<p>이 절차와 수집기는 아직 실제 계정으로 검증하지 않았습니다. 인증 정보는 브라우저에 입력하지 않습니다.</p></div></div>
      <div className="guide-links">{connector.docs.map(d=><a key={d.url} className="text-link" href={d.url} target="_blank" rel="noreferrer">{d.label}<ArrowUpRight size={14}/></a>)}</div>
    </div>
    <div className="dialog-footer"><span>이 가이드는 상단의 클라우드 연결에서 다시 볼 수 있습니다.</span><button className="button primary" onClick={close}>{firstVisit?'목데이터로 둘러보기':'닫기'}</button></div>
  </dialog>;
}
