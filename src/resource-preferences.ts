import {useMemo,useState} from 'react';
import type {CategoryId} from '../shared/capacity';
export type SortKey='name'|'provider'|'kind'|'scope'|'address'|'region'|'status'|'size';

// Kept by Workspace so changing routes does not discard list preferences.
export function useResourcePreferences(){
  const [category,setCategory]=useState<CategoryId|'all'>('all');
  const [showAuxiliary,setShowAuxiliary]=useState(false);
  const [kind,setKind]=useState('all'),[state,setState]=useState('all');
  const [sort,setSort]=useState<{key:SortKey;dir:1|-1}>({key:'name',dir:1});
  return useMemo(()=>({category,setCategory,showAuxiliary,setShowAuxiliary,kind,setKind,state,setState,sort,setSort}),[category,showAuxiliary,kind,state,sort]);
}
export type ResourcePreferences=ReturnType<typeof useResourcePreferences>;
