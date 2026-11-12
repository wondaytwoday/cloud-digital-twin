import {useState,useRef,useEffect} from 'react';
import {collectionItems,collectionLabels,selectedItems,coreCollectionItems,type CollectionItem,type CollectionProvider,type CollectionSelection} from '../shared/collection-items';
import type {ItemCollection} from '../shared/schema';
const providers:CollectionProvider[]=['azure','aws','gcp'];
const names={azure:'Microsoft Azure',aws:'Amazon Web Services',gcp:'Google Cloud'};
export function CollectionPicker({running,records,onCollect}:{running:boolean;records:ItemCollection[];onCollect:(selection:CollectionSelection)=>Promise<void>}){
  const root=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(running&&root.current){root.current.open=false;root.current.parentElement?.scrollTo({top:0});}},[running]);
  const [checked,setChecked]=useState(new Set(providers.flatMap(p=>coreCollectionItems.map(i=>`${p}:${i}`))));
  const selected=[...checked].map(key=>{const [provider,item]=key.split(':');return{provider:provider as CollectionProvider,item:item as CollectionItem};});
  const run=(items:typeof selected)=>onCollect({mode:'selected',items});
  return <details className="collection-picker" ref={root}><summary>제공자·항목 선택 수집</summary>
    <p className="muted small">선택하지 않은 데이터와 시각은 유지합니다. VM·DB·클러스터에는 네트워크 조회가 함께 필요합니다. 비용을 선택하면 정기 조회 간격과 관계없이 조회합니다.</p>
    <fieldset disabled={running}><legend className="sr-only">수집 항목</legend>
      {providers.map(provider=><details key={provider}><summary>{names[provider]}</summary>
        <button className="button" onClick={()=>run(collectionItems.map(item=>({provider,item})))}>{names[provider]} 전체 수집</button>
        {collectionItems.map(item=>{
          const key=`${provider}:${item}`,own=records.filter(r=>r.provider===provider&&r.item===item);
          const dates=own.flatMap(r=>r.collectedAt?[r.collectedAt]:[]).sort(),latest=dates.at(-1);
          const dependencies=selectedItems({mode:'selected',items:[{provider,item}]},provider).filter(i=>i!==item);
          return <div className="collection-item" key={key}>
            <label><input type="checkbox" checked={checked.has(key)} onChange={e=>setChecked(old=>{const next=new Set(old);if(e.target.checked)next.add(key);else next.delete(key);return next;})}/>{collectionLabels[item]}</label>
            <button className="link-button small" onClick={()=>run([{provider,item}])} aria-label={`${names[provider]} ${collectionLabels[item]}만 수집`}>이 항목 수집</button>
            <small>{own.length?`완료 ${own.filter(r=>r.state==='complete').length}/${own.length}범위 · 최근 성공 ${latest?new Date(latest).toLocaleString('ko-KR'):'없음'}`:'항목별 수집 기록 없음'}{dependencies.length?` · 함께 조회: ${dependencies.map(i=>collectionLabels[i]).join(', ')}`:''}</small>
          </div>;
        })}
      </details>)}
      <button className="button primary" disabled={!selected.length} onClick={()=>run(selected)}>선택 항목 수집 ({selected.length}개)</button>
    </fieldset>
  </details>;
}
