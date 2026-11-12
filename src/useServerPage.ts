import {useEffect,useState} from 'react';
import type {z} from 'zod';
import type {Focus} from '../shared/hierarchy';
export function scopeQuery(focus:Focus){
  const query=new URLSearchParams({provider:focus.provider});
  if(focus.scopes){query.set('scoped','1');for(const scope of [...focus.scopes].sort())query.append('scope',scope);}
  return query;
}
export function useServerPage<T extends {nextCursor?:string}>(endpoint:string,query:URLSearchParams,schema:z.ZodType<T>,generation:object){
  const key=`${endpoint}?${query}`;
  const [paging,setPaging]=useState({key,cursors:[undefined] as (string|undefined)[],index:0});
  const current=paging.key===key?paging:{key,cursors:[undefined],index:0};
  const cursor=current.cursors[current.index];
  const [state,setState]=useState<{key:string;cursor?:string;value?:T;error?:string;loading?:boolean}>({key});
  const [tick,setTick]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let restart=false;
    const load=async()=>{
      setState(old=>old.key===key&&old.cursor===cursor?{...old,error:undefined,loading:true}:{key,cursor,loading:true});
      try{
        const url=new URL(key,location.origin);if(cursor)url.searchParams.set('cursor',cursor);
        const response=await fetch(url,{signal:controller.signal}),body=await response.json();
        if(!response.ok){
          if(response.status===409&&cursor){restart=true;setPaging({key,cursors:[undefined],index:0});return;}
          throw new Error(body.error??'목록을 불러오지 못했습니다.');
        }
        const value=schema.parse(body);if(!controller.signal.aborted)setState({key,cursor,value,loading:false});
      }catch(e){if(!controller.signal.aborted&&!restart)setState(old=>({key,cursor,value:old.key===key&&old.cursor===cursor?old.value:undefined,error:e instanceof Error?e.message:'목록을 불러오지 못했습니다.',loading:false}));}
    };
    void load();return()=>controller.abort();
  },[key,cursor,schema,generation,tick]);
  const matching=state.key===key&&state.cursor===cursor;
  return{loading:!matching||!!state.loading,value:matching?state.value:undefined,error:matching?state.error:undefined,index:current.index,
    retry:()=>setTick(t=>t+1),
    previous:()=>setPaging({...current,index:Math.max(0,current.index-1)}),
    next:()=>{const next=matching?state.value?.nextCursor:undefined;if(next)setPaging({key,cursors:[...current.cursors.slice(0,current.index+1),next],index:current.index+1});},
  };
}
