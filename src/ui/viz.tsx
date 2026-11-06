import {Area,AreaChart,Bar,BarChart,CartesianGrid,Cell,Label,Pie,PieChart,XAxis,YAxis} from 'recharts';
import {ChartContainer,ChartLegend,ChartLegendContent,ChartTooltip,ChartTooltipContent,type ChartConfig} from '@/ui/components/chart';
import {cn} from '@/ui/lib/utils';
// Shared chart pieces for every page. Each one prints its numbers as text too, so colour is never the only signal.
export type Slice={key:string;label:string;value:number;color:string};
export const PROVIDER_COLOR:Record<string,string>={azure:'var(--azure)',aws:'var(--aws)',gcp:'var(--gcp)',onprem:'var(--onprem)'};
export const PROVIDER_LABEL:Record<string,string>={azure:'Azure',aws:'AWS',gcp:'Google Cloud',onprem:'사내망'};
export const SEVERITY_COLOR:Record<string,string>={critical:'#991b1b',high:'var(--warn)',medium:'var(--amber)',low:'var(--accent)',info:'var(--faint)'};
const configOf=(slices:{key:string;label:string;color:string}[])=>Object.fromEntries(slices.map(s=>[s.key,{label:s.label,color:s.color}])) as ChartConfig;
export function Donut({data,center,unit,format=v=>v.toLocaleString('ko-KR'),size=148,onPick,className}:{data:Slice[];center?:string;unit?:string;format?:(v:number)=>string;size?:number;onPick?:(key:string)=>void;className?:string}){
  const shown=data.filter(d=>d.value>0),total=shown.reduce((n,d)=>n+d.value,0);
  if(!total)return <p className="text-sm text-muted-foreground">표시할 데이터가 없습니다.</p>;
  return <div className={cn('shad flex flex-wrap items-center gap-4',className)}>
    <ChartContainer config={configOf(shown)} className="aspect-square shrink-0" style={{height:size,width:size}}><PieChart><ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel formatter={(v,n)=><><span className="text-muted-foreground">{shown.find(d=>d.key===n)?.label}</span><span className="ml-auto pl-2 font-medium tabular-nums">{format(Number(v))}</span></>}/>}/>
      <Pie data={shown} dataKey="value" nameKey="key" innerRadius={size*.3} outerRadius={size*.45} strokeWidth={2} stroke="var(--surface)" onClick={onPick?(d:any)=>onPick(d.key):undefined} className={onPick?'cursor-pointer':undefined}>{shown.map(d=><Cell key={d.key} fill={d.color}/>)}<Label content={({viewBox})=>viewBox&&'cx' in viewBox?<text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle"><tspan x={viewBox.cx} y={(viewBox.cy??0)-(unit?7:0)} className="fill-foreground text-lg font-semibold">{center??format(total)}</tspan>{unit&&<tspan x={viewBox.cx} y={(viewBox.cy??0)+13} className="fill-muted-foreground text-xs">{unit}</tspan>}</text>:null}/></Pie></PieChart></ChartContainer>
    <ul className="grid min-w-[140px] flex-1 gap-1.5 text-sm">{shown.map(d=><li key={d.key}>{onPick?<button className="flex w-full items-center gap-2 rounded px-1 text-left hover:bg-[var(--bg)]" onClick={()=>onPick(d.key)}><Row d={d} total={total} format={format}/></button>:<div className="flex items-center gap-2 px-1"><Row d={d} total={total} format={format}/></div>}</li>)}</ul>
  </div>;
}
const Row=({d,total,format}:{d:Slice;total:number;format:(v:number)=>string})=><><i className="size-2.5 shrink-0 rounded-sm" style={{background:d.color}} aria-hidden="true"/><span className="truncate">{d.label}</span><span className="ml-auto whitespace-nowrap tabular-nums text-muted-foreground">{format(d.value)} · {Math.round(d.value/total*100)}%</span></>;
// Horizontal bars, one row per item, with the value printed at the end.
export function HBars({data,format=v=>v.toLocaleString('ko-KR'),labelWidth=110,onPick}:{data:{key:string;label:string;value:number;color?:string}[];format?:(v:number)=>string;labelWidth?:number;onPick?:(key:string)=>void}){
  if(!data.length)return <p className="text-sm text-muted-foreground">표시할 데이터가 없습니다.</p>;
  return <div className="shad"><ChartContainer config={{value:{label:'값',color:'var(--accent)'}}} className="aspect-auto w-full" style={{height:data.length*26+12}}><BarChart data={data} layout="vertical" margin={{left:0,right:52,top:2,bottom:2}} accessibilityLayer><XAxis type="number" hide/><YAxis type="category" dataKey="label" width={labelWidth} tickLine={false} axisLine={false} tick={{fontSize:12}}/><ChartTooltip cursor={{fill:'var(--bg)'}} content={<ChartTooltipContent hideIndicator formatter={v=><span className="font-medium tabular-nums">{format(Number(v))}</span>}/>}/><Bar dataKey="value" radius={3} maxBarSize={16} label={{position:'right',className:'fill-foreground text-xs tabular-nums',formatter:(v:any)=>format(Number(v))}} onClick={onPick?(d:any)=>onPick(d.payload.key):undefined} className={onPick?'cursor-pointer':undefined}>{data.map(d=><Cell key={d.key} fill={d.color??'var(--accent)'}/>)}</Bar></BarChart></ChartContainer></div>;
}
// Columns over time, stacked by series.
export function Columns({data,series,format=v=>v.toLocaleString('ko-KR'),height=180,xKey='x'}:{data:Record<string,string|number>[];series:{key:string;label:string;color:string}[];format?:(v:number)=>string;height?:number;xKey?:string}){
  if(!data.length)return <p className="text-sm text-muted-foreground">표시할 데이터가 없습니다.</p>;
  return <div className="shad"><ChartContainer config={configOf(series)} className="aspect-auto w-full" style={{height}}><BarChart data={data} margin={{left:-8,right:4,top:8}} accessibilityLayer><CartesianGrid vertical={false}/><XAxis dataKey={xKey} tickLine={false} axisLine={false} minTickGap={12} tick={{fontSize:12}}/><YAxis tickLine={false} axisLine={false} allowDecimals={false} width={48} tick={{fontSize:12}} tickFormatter={v=>format(Number(v))}/><ChartTooltip cursor={{fill:'var(--bg)'}} content={<ChartTooltipContent formatter={(v,n)=><><i className="size-2.5 rounded-sm" style={{background:series.find(s=>s.key===n)?.color}}/><span className="text-muted-foreground">{series.find(s=>s.key===n)?.label}</span><span className="ml-auto pl-2 font-medium tabular-nums">{format(Number(v))}</span></>}/>}/>{series.length>1&&<ChartLegend verticalAlign="top" content={<ChartLegendContent className="justify-end pt-0 pb-2"/>}/>}{series.map((s,i)=><Bar key={s.key} dataKey={s.key} stackId="s" fill={s.color} maxBarSize={28} radius={i===series.length-1?[3,3,0,0]:0}/>)}</BarChart></ChartContainer></div>;
}
export function Spark({values,color='var(--accent)',height=36}:{values:number[];color?:string;height?:number}){
  if(values.length<2)return null;
  const data=values.map((v,i)=>({i,v}));
  return <div className="shad" aria-hidden="true"><ChartContainer config={{v:{label:'',color}}} className="aspect-auto w-full" style={{height}}><AreaChart data={data} margin={{left:0,right:0,top:2,bottom:0}}><Area dataKey="v" type="monotone" stroke={color} fill={color} fillOpacity={.15} strokeWidth={1.5} isAnimationActive={false}/></AreaChart></ChartContainer></div>;
}
// A labelled share bar: one track split into coloured parts, with the parts listed underneath.
export function ShareBar({parts,format=v=>v.toLocaleString('ko-KR')}:{parts:Slice[];format?:(v:number)=>string}){
  const total=parts.reduce((n,p)=>n+p.value,0);if(!total)return null;
  return <div className="shad grid gap-2"><div className="flex h-2.5 overflow-hidden rounded-full bg-[var(--bg)]" role="img" aria-label={parts.map(p=>`${p.label} ${format(p.value)}`).join(', ')}>{parts.filter(p=>p.value).map(p=><div key={p.key} style={{width:`${p.value/total*100}%`,background:p.color}} className="h-full border-r-2 border-[var(--surface)] last:border-r-0"/>)}</div><ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{parts.filter(p=>p.value).map(p=><li key={p.key} className="flex items-center gap-1.5"><i className="size-2 rounded-sm" style={{background:p.color}}/>{p.label} <span className="tabular-nums text-foreground">{format(p.value)}</span></li>)}</ul></div>;
}
