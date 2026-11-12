// All durations stay below Node's 32-bit timer limit. Invalid values never
// disable a deadline or accidentally create a millisecond interval.
export function collectionSettings(env:NodeJS.ProcessEnv=process.env,warn:(line:string)=>void=()=>{}){
  const duration=(key:string,fallback:number,max:number,allowZero=false)=>{
    const raw=env[key];
    if(raw===undefined)return fallback;
    const value=Number(raw);
    if(raw.trim()!==''&&Number.isFinite(value)&&(value>0||(allowZero&&value===0))&&value<=max&&value>=0.001)return value;
    if(allowZero&&raw.trim()!==''&&value===0)return 0;
    warn(`${key} 값이 허용 범위를 벗어나 기본값 ${fallback}을 사용합니다.`);
    return fallback;
  };
  return{
    minutes:duration('ATLAS_COLLECT_MINUTES',60,10_080,true),
    timeoutMinutes:duration('ATLAS_COLLECT_TIMEOUT_MIN',15,180),
    costHours:duration('ATLAS_COST_HOURS',24,8760),
  };
}
