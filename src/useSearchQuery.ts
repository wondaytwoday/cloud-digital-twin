import {useEffect,useState} from 'react';

export function useSearchQuery(query:string,composing:boolean){
  const [settled,setSettled]=useState(query);
  useEffect(()=>{
    if(composing)return;
    const timer=setTimeout(()=>setSettled(query),200);
    return()=>clearTimeout(timer);
  },[query,composing]);
  return query===''?'':settled;
}
