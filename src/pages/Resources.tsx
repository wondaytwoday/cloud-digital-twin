import {CollectionNotice} from '../CollectionNotice';
import {isAuxiliary} from '../../shared/classification';
import {useMemo,useState} from 'react';
import {Bar,BarChart,CartesianGrid,Cell,Label,Pie,PieChart,XAxis,YAxis,Area,AreaChart} from 'recharts';
import {ArrowDown,ArrowUp,ArrowUpRight,Cpu,HardDrive,MemoryStick,Server,Boxes,Gauge,Activity} from 'lucide-react';
import type {Resource,Snapshot} from '../../shared/schema';
import {inScope,type Focus} from '../../shared/hierarchy';
import {health,type Health} from '../../shared/topology';
import {CATEGORIES,capacityOf,capacityIssues,categoryOf,countBy,fleetTotals,statusCounts,type CategoryId} from '../../shared/capacity';
import {kindNames,ResourceIcon} from '../graph';
import {Card,CardAction,CardContent,CardDescription,CardHeader,CardTitle} from '@/ui/components/card';
import {ChartContainer,ChartLegend,ChartLegendContent,ChartTooltip,ChartTooltipContent,type ChartConfig} from '@/ui/components/chart';
import {Tabs,TabsList,TabsTrigger} from '@/ui/components/tabs';
import {Badge} from '@/ui/components/badge';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/ui/components/table';
import {cn} from '@/ui/lib/utils';
const PROVIDERS=['azure','aws','gcp','onprem'] as const;
const providerLabel:Record<string,string>={azure:'Azure',aws:'AWS',gcp:'Google Cloud',onprem:'사내망'};
const providerChart={azure:{label:'Azure',color:'var(--azure)'},aws:{label:'AWS',color:'var(--aws)'},gcp:{label:'Google Cloud',color:'var(--gcp)'},onprem:{label:'사내망',color:'var(--onprem)'}} satisfies ChartConfig;
const healthLabel:Record<Health,string>={ok:'정상',warn:'이상',stopped:'중지',unknown:'권한 없음',neutral:'구성만 수집'};
const healthColor:Record<Health,string>={ok:'var(--path)',warn:'var(--warn)',stopped:'var(--faint)',unknown:'var(--amber)',neutral:'var(--line-strong)'};
const num=(v:number)=>v.toLocaleString('ko-KR',{maximumFractionDigits:1});
const gib=(v:number)=>v>=1024?`${num(v/1024)} TiB`:`${num(v)} GiB`;
// Thresholds follow common alerting defaults; the number is always printed, so colour is never the only signal.
const tone=(v:number)=>v>=85?'bad':v>=70?'warn':'ok';
const toneBar:Record<string,string>={bad:'bg-[var(--warn)]',warn:'bg-[var(--amber)]',ok:'bg-[var(--accent)]'};
type Metric='cpu'|'memory'|'disk'|'gpu';
const METRICS:{id:Metric;label:string}[]=[{id:'cpu',label:'CPU'},{id:'memory',label:'메모리'},{id:'disk',label:'디스크'},{id:'gpu',label:'GPU'}];
function Kpi({icon:Icon,label,value,hint,tone:t}:{icon:typeof Cpu;label:string;value:string;hint?:string;tone?:'bad'}){
  return <Card className="gap-1 py-3"><CardContent className="px-4"><div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Icon size={14} aria-hidden="true"/>{label}</div><div className={cn('mt-1 text-2xl font-semibold tabular-nums tracking-tight',t==='bad'&&'text-destructive')}>{value}</div>{hint&&<div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}</CardContent></Card>;
}
function Panel({title,description,action,className,children}:{title:string;description?:string;action?:React.ReactNode;className?:string;children:React.ReactNode}){
  return <Card className={cn('min-w-0 gap-3 py-4',className)}><CardHeader className="px-4"><CardTitle className="text-sm">{title}</CardTitle>{description&&<CardDescription className="text-xs">{description}</CardDescription>}{action&&<CardAction>{action}</CardAction>}</CardHeader><CardContent className="px-4">{children}</CardContent></Card>;
}
// A bullet bar: the value as a filled track plus the printed percentage.
function Meter({label,value}:{label:string;value?:number}){
  if(value===undefined)return <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="w-10 shrink-0">{label}</span><span>—</span></div>;
  const t=tone(value);
  return <div className="flex items-center gap-2 text-xs" title={`${label} ${value}%`}><span className="w-10 shrink-0 text-muted-foreground">{label}</span><div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--bg)]" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><div className={cn('h-full rounded-full',toneBar[t])} style={{width:`${value}%`}}/></div><span className={cn('w-9 shrink-0 text-right tabular-nums',t==='bad'&&'font-semibold text-destructive',t==='warn'&&'text-[var(--amber)]')}>{value}%</span></div>;
}
function StatusBadge({status}:{status:string}){const h=health(status);return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs"><i className="size-2 rounded-full" style={{background:healthColor[h]}} aria-hidden="true"/>{status}</span>;}
function KindChart({rows,onPick}:{rows:Resource[];onPick:(c:CategoryId)=>void}){
  const data=useMemo(()=>{const m=new Map<string,Record<string,number|string>>();for(const r of rows){const k=kindNames[r.kind];const row=m.get(k)??{kind:k,cat:categoryOf(r.kind),total:0};row[r.provider]=((row[r.provider] as number)??0)+1;(row.total as number)++;m.set(k,row);}return [...m.values()].sort((a,b)=>(b.total as number)-(a.total as number));},[rows]);
  const present=PROVIDERS.filter(p=>rows.some(r=>r.provider===p));
  return <ChartContainer config={providerChart} className="aspect-auto w-full" style={{height:Math.max(180,data.length*24+56)}}>
    <BarChart data={data} layout="vertical" margin={{left:4,right:12}} accessibilityLayer>
      <CartesianGrid horizontal={false}/><XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false}/><YAxis type="category" dataKey="kind" width={84} tickLine={false} axisLine={false}/>
      <ChartTooltip cursor={{fill:'var(--bg)'}} content={<ChartTooltipContent/>}/><ChartLegend verticalAlign="top" content={<ChartLegendContent className="justify-end pt-0 pb-2"/>}/>
      {present.map((p,i)=><Bar key={p} dataKey={p} stackId="k" fill={`var(--color-${p})`} radius={i===present.length-1?[0,3,3,0]:0} maxBarSize={16} className="cursor-pointer" onClick={(d:any)=>onPick(d.payload.cat)}/>)}
    </BarChart>
  </ChartContainer>;
}
function StatusDonut({rows}:{rows:Resource[]}){
  const counts=statusCounts(rows),data=(Object.keys(counts) as Health[]).filter(h=>counts[h]).map(h=>({key:h,name:healthLabel[h],value:counts[h],fill:healthColor[h]}));
  const config=Object.fromEntries(data.map(d=>[d.key,{label:d.name,color:d.fill}])) as ChartConfig;
  return <div className="flex items-center gap-4"><ChartContainer config={config} className="aspect-square h-[150px] shrink-0"><PieChart><ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel/>}/><Pie data={data} dataKey="value" nameKey="key" innerRadius={44} outerRadius={66} strokeWidth={2} stroke="var(--surface)">{data.map(d=><Cell key={d.key} fill={d.fill}/>)}<Label content={({viewBox})=>viewBox&&'cx' in viewBox?<text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle"><tspan x={viewBox.cx} y={(viewBox.cy??0)-6} className="fill-foreground text-xl font-semibold">{rows.length}</tspan><tspan x={viewBox.cx} y={(viewBox.cy??0)+14} className="fill-muted-foreground text-xs">자원</tspan></text>:null}/></Pie></PieChart></ChartContainer>
    <ul className="grid flex-1 gap-1.5 text-sm">{data.map(d=><li key={d.key} className="flex items-center gap-2"><i className="size-2.5 rounded-sm" style={{background:d.fill}} aria-hidden="true"/><span>{d.name}</span><span className="ml-auto tabular-nums text-muted-foreground">{d.value} · {Math.round(d.value/rows.length*100)}%</span></li>)}</ul></div>;
}
type CapMetric='vcpu'|'memoryGiB'|'diskGiB'|'gpus';
const CAP:{id:CapMetric;label:string;unit:(v:number)=>string}[]=[{id:'vcpu',label:'vCPU',unit:v=>`${num(v)}개`},{id:'memoryGiB',label:'메모리',unit:gib},{id:'diskGiB',label:'디스크',unit:gib},{id:'gpus',label:'GPU',unit:v=>`${num(v)}개`}];
function CapacityByProvider({vms}:{vms:Resource[]}){
  const [metric,setMetric]=useState<CapMetric>('vcpu'),spec=CAP.find(c=>c.id===metric)!;
  const data=(['azure','aws','gcp'] as const).map(p=>({provider:providerLabel[p],key:p,...fleetTotals(vms.filter(v=>v.provider===p))})).filter(d=>d.count);
  return <Panel title="클라우드별 할당 용량" description="실행 중인 VM 기준. 디스크는 중지된 VM도 포함" action={<Tabs value={metric} onValueChange={v=>setMetric(v as CapMetric)}><TabsList className="h-7">{CAP.map(c=><TabsTrigger key={c.id} value={c.id} className="h-6 px-2 text-xs">{c.label}</TabsTrigger>)}</TabsList></Tabs>}>
    <ChartContainer config={{...providerChart,[metric]:{label:spec.label}}} className="aspect-auto h-[180px] w-full"><BarChart data={data} margin={{top:18,left:-12,right:4}} accessibilityLayer><CartesianGrid vertical={false}/><XAxis dataKey="provider" tickLine={false} axisLine={false}/><YAxis tickLine={false} axisLine={false} allowDecimals={false}/><ChartTooltip cursor={{fill:'var(--bg)'}} content={<ChartTooltipContent hideLabel formatter={(v)=><span className="font-medium tabular-nums">{spec.label} {spec.unit(Number(v))}</span>}/>}/><Bar dataKey={metric} radius={4} maxBarSize={56} label={{position:'top',className:'fill-foreground text-xs tabular-nums',formatter:(v:any)=>spec.unit(Number(v))}}>{data.map(d=><Cell key={d.key} fill={`var(--color-${d.key})`}/>)}</Bar></BarChart></ChartContainer>
  </Panel>;
}
function Utilization({vms,live}:{vms:Resource[];live:boolean}){
  const [sort,setSort]=useState<Metric>('cpu'),[all,setAll]=useState(false);
  const measured=vms.filter(v=>v.metrics),sorted=[...measured].sort((a,b)=>(b.metrics?.[sort]??-1)-(a.metrics?.[sort]??-1)),shown=all?sorted:sorted.slice(0,6);
  const hot=measured.filter(v=>METRICS.some(m=>(v.metrics?.[m.id]??0)>=85)).length;
  if(!measured.length)return <Panel title="VM 사용률" description="CPU · 메모리 · 디스크 · GPU"><div className="flex flex-col items-center gap-2 rounded-lg bg-[var(--bg)] px-4 py-8 text-center text-sm text-muted-foreground"><Gauge size={22} aria-hidden="true"/><p>{live?'사용률은 Azure Monitor, CloudWatch, Cloud Monitoring 지표를 연동한 뒤 표시됩니다. 지금은 구성에서 읽은 할당 용량만 보여줍니다.':'이 범위에서 실행 중인 VM이 없습니다.'}</p></div></Panel>;
  return <Panel title="VM 사용률" description={`${measured.length}대 측정 · 85% 이상 ${hot}대${live?'':' · 예시 지표'}`} action={<Tabs value={sort} onValueChange={v=>{setSort(v as Metric);}}><TabsList className="h-7">{METRICS.map(m=><TabsTrigger key={m.id} value={m.id} className="h-6 px-2 text-xs">{m.label}순</TabsTrigger>)}</TabsList></Tabs>}>
    <ul className="grid gap-3">{shown.map(v=>{const c=capacityOf(v);return <li key={v.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] items-center gap-4"><div className="flex min-w-0 items-center gap-2"><ResourceIcon resource={v} size={20}/><div className="min-w-0"><div className="truncate text-sm font-medium">{v.name}</div><div className="truncate text-xs text-muted-foreground">{providerLabel[v.provider]} · {c.size??'크기 미확인'}{c.vcpu?` · ${c.vcpu} vCPU`:''}{c.memoryGiB?` · ${c.memoryGiB} GiB`:''}</div></div></div><div className="grid gap-1">{METRICS.map(m=>m.id==='gpu'&&v.metrics?.gpu===undefined?null:<Meter key={m.id} label={m.label} value={v.metrics?.[m.id]}/>)}</div></li>;})}</ul>
    {sorted.length>6&&<button className="mt-3 text-xs font-medium text-primary hover:underline" onClick={()=>setAll(!all)}>{all?'상위 6대만 보기':`${sorted.length}대 모두 보기`}</button>}
  </Panel>;
}
// Twelve samples per VM; the fleet line is their hourly mean, with the busiest machine drawn beside it.
function CpuTrend({vms}:{vms:Resource[]}){
  const series=vms.map(v=>v.metrics?.history).filter((h):h is number[]=>!!h?.length);
  if(!series.length)return null;
  const data=series[0].map((_,i)=>({t:`${series[0].length-1-i}시간 전`,avg:Math.round(series.reduce((s,h)=>s+(h[i]??0),0)/series.length),max:Math.max(...series.map(h=>h[i]??0))}));
  data[data.length-1].t='지금';
  const config={avg:{label:'평균 CPU',color:'var(--accent)'},max:{label:'최대 CPU',color:'var(--warn)'}} satisfies ChartConfig;
  return <Panel title="CPU 추이" description="최근 12시간 · 측정된 VM 전체"><ChartContainer config={config} className="aspect-auto h-[180px] w-full"><AreaChart data={data} margin={{left:-16,right:8,top:6}} accessibilityLayer><CartesianGrid vertical={false}/><XAxis dataKey="t" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24}/><YAxis domain={[0,100]} ticks={[0,50,85,100]} tickLine={false} axisLine={false} unit="%"/><ChartTooltip content={<ChartTooltipContent indicator="line" formatter={(v,n)=><><span className="text-muted-foreground">{config[n as 'avg'|'max'].label}</span><span className="ml-auto font-medium tabular-nums">{v}%</span></>}/>}/><Area dataKey="max" type="monotone" stroke="var(--color-max)" fill="var(--color-max)" fillOpacity={.08} strokeWidth={1.5} strokeDasharray="4 3"/><Area dataKey="avg" type="monotone" stroke="var(--color-avg)" fill="var(--color-avg)" fillOpacity={.18} strokeWidth={2}/></AreaChart></ChartContainer></Panel>;
}
function SizeChart({vms}:{vms:Resource[]}){
  const data=countBy(vms,v=>capacityOf(v).size).slice(0,8).map(([size,count])=>({size,count}));
  return <Panel title="인스턴스 크기 분포" description="많이 쓰는 크기 상위 8개"><ChartContainer config={{count:{label:'VM',color:'var(--accent)'}}} className="aspect-auto w-full" style={{height:Math.max(120,data.length*26+16)}}><BarChart data={data} layout="vertical" margin={{left:4,right:28}} accessibilityLayer><XAxis type="number" hide allowDecimals={false}/><YAxis type="category" dataKey="size" width={160} tickLine={false} axisLine={false}/><ChartTooltip cursor={{fill:'var(--bg)'}} content={<ChartTooltipContent hideIndicator/>}/><Bar dataKey="count" fill="var(--color-count)" radius={3} maxBarSize={16} label={{position:'right',className:'fill-foreground text-xs tabular-nums'}}/></BarChart></ChartContainer></Panel>;
}
function GpuHosts({vms}:{vms:Resource[]}){
  const hosts=vms.filter(v=>capacityOf(v).gpus);
  return <Panel title="GPU 인스턴스" description={hosts.length?`${hosts.length}대 · GPU ${hosts.reduce((s,v)=>s+capacityOf(v).gpus,0)}개`:'GPU가 붙은 VM이 없습니다'}>{hosts.length?<ul className="grid gap-2">{hosts.map(v=>{const c=capacityOf(v);return <li key={v.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-[var(--bg)] px-3 py-2"><div className="min-w-0"><div className="truncate text-sm font-medium">{v.name}</div><div className="truncate text-xs text-muted-foreground">{c.gpus} × {c.gpuModel} · {c.size}</div></div><StatusBadge status={v.status}/>{v.metrics?.gpu!==undefined&&<div className="col-span-2"><Meter label="GPU" value={v.metrics.gpu}/></div>}</li>;})}</ul>:<p className="text-sm text-muted-foreground">GPU 크기(예: NC, g5, a2 계열)를 쓰는 VM이 생기면 여기에 표시됩니다.</p>}</Panel>;
}
function SpecTable({rows,columns}:{rows:Resource[];columns:{label:string;get:(r:Resource)=>string}[]}){
  return <Table><TableHeader><TableRow><TableHead>이름</TableHead><TableHead>클라우드</TableHead>{columns.map(c=><TableHead key={c.label}>{c.label}</TableHead>)}<TableHead>상태</TableHead></TableRow></TableHeader><TableBody>{rows.map(r=><TableRow key={r.id}><TableCell className="font-medium">{r.name}</TableCell><TableCell>{providerLabel[r.provider]}</TableCell>{columns.map(c=><TableCell key={c.label}>{c.get(r)}</TableCell>)}<TableCell><StatusBadge status={r.status}/></TableCell></TableRow>)}</TableBody></Table>;
}
function CategoryPanels({category,rows,live}:{category:CategoryId|'all';rows:Resource[];live:boolean}){
  const vms=rows.filter(r=>r.kind==='compute');
  if(category==='compute')return <div className="grid items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3"><Utilization vms={vms} live={live}/><CapacityByProvider vms={vms}/><CpuTrend vms={vms}/><SizeChart vms={vms}/><GpuHosts vms={vms}/></div>;
  const of=(kind:string)=>rows.filter(r=>r.kind===kind);
  if(category==='container')return <Panel title="Kubernetes 클러스터" description={`${of('cluster').length}개`}><SpecTable rows={of('cluster')} columns={[{label:'종류',get:r=>r.specs['종류']??r.type},{label:'버전',get:r=>r.specs['버전']??'—'},{label:'노드',get:r=>r.specs['노드']??'—'},{label:'위치',get:r=>r.region}]}/></Panel>;
  if(category==='data')return <div className="grid items-start gap-3 lg:grid-cols-2"><Panel title="엔진 분포" description="데이터베이스·스토리지 종류별"><EngineChart rows={rows}/></Panel><Panel title="공개 엔드포인트" description="사설 엔드포인트 없이 공용으로 열린 데이터 서비스"><SpecTable rows={rows.filter(r=>r.specs['연결']==='공용 엔드포인트'||r.publicIp)} columns={[{label:'종류',get:r=>r.specs['종류']??kindNames[r.kind]}]}/></Panel></div>;
  if(category==='all')return null;
  return <Panel title={`${CATEGORIES.find(c=>c.id===category)!.label} 구성`} description="종류별 개수와 상태"><KindChart rows={rows} onPick={()=>{}}/></Panel>;
}
function EngineChart({rows}:{rows:Resource[]}){
  const data=countBy(rows,r=>r.specs['종류']??kindNames[r.kind]).map(([engine,count])=>({engine,count}));
  if(!data.length)return <p className="text-sm text-muted-foreground">이 범위에 데이터 서비스가 없습니다.</p>;
  return <ChartContainer config={{count:{label:'개수',color:'var(--chart-2)'}}} className="aspect-auto w-full" style={{height:data.length*26+16}}><BarChart data={data} layout="vertical" margin={{right:28}} accessibilityLayer><XAxis type="number" hide allowDecimals={false}/><YAxis type="category" dataKey="engine" width={120} tickLine={false} axisLine={false}/><ChartTooltip cursor={{fill:'var(--bg)'}} content={<ChartTooltipContent hideIndicator/>}/><Bar dataKey="count" fill="var(--color-count)" radius={3} maxBarSize={16} label={{position:'right',className:'fill-foreground text-xs tabular-nums'}}/></BarChart></ChartContainer>;
}
type SortKey='name'|'provider'|'kind'|'scope'|'address'|'region'|'status'|'size';
function Inventory({snapshot,rows,onOpen}:{snapshot:Snapshot;rows:Resource[];onOpen:(r:Resource)=>void}){
  const [kind,setKind]=useState('all'),[state,setState]=useState('all'),[sort,setSort]=useState<{key:SortKey;dir:1|-1}>({key:'name',dir:1});
  const value=(r:Resource,key:SortKey)=>key==='scope'?snapshot.scopeLabels[r.scope]??r.scope:key==='address'?r.ip??r.cidr??'':key==='kind'?kindNames[r.kind]:key==='size'?r.specs['인스턴스']??r.specs['종류']??'':r[key];
  const kinds=[...new Set(rows.map(r=>r.kind))].sort(),present=(Object.keys(healthLabel) as Health[]).filter(h=>rows.some(r=>health(r.status)===h));
  const shown=rows.filter(r=>(kind==='all'||r.kind===kind)&&(state==='all'||health(r.status)===state)).sort((a,b)=>sort.dir*value(a,sort.key).localeCompare(value(b,sort.key),'ko',{numeric:true}));
  const head=(key:SortKey,label:string)=><TableHead aria-sort={sort.key===key?(sort.dir===1?'ascending':'descending'):undefined}><button className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={()=>setSort(s=>({key,dir:s.key===key?(s.dir===1?-1:1):1}))}>{label}{sort.key===key&&(sort.dir===1?<ArrowUp size={12}/>:<ArrowDown size={12}/>)}</button></TableHead>;
  const select='h-8 rounded-md border border-input bg-card px-2 text-sm';
  return <Panel title="리소스 목록" description={`${shown.length} / ${rows.length}개`} action={<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><label className="flex items-center gap-1.5">유형<select className={select} value={kind} onChange={e=>setKind(e.target.value)}><option value="all">전체</option>{kinds.map(k=><option key={k} value={k}>{kindNames[k]}</option>)}</select></label><label className="flex items-center gap-1.5">상태<select className={select} value={state} onChange={e=>setState(e.target.value)}><option value="all">전체</option>{present.map(h=><option key={h} value={h}>{healthLabel[h]}</option>)}</select></label></div>}>
    <div className="max-h-[560px] overflow-auto rounded-md border"><Table><TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--line)]"><TableRow>{head('name','리소스')}{head('provider','클라우드')}{head('kind','유형')}{head('size','크기·종류')}{head('scope','소유 범위')}{head('address','주소')}{head('region','위치')}{head('status','상태')}</TableRow></TableHeader>
      <TableBody>{shown.map(r=>{const mappable=r.kind!=='service';return <TableRow key={r.id}><TableCell>{mappable?<button className="inline-flex items-center gap-2 font-medium hover:text-primary" onClick={()=>onOpen(r)} title="토폴로지에서 보기"><ResourceIcon resource={r} size={18}/>{r.name}<ArrowUpRight size={12} className="text-muted-foreground"/></button>:<span className="inline-flex items-center gap-2 font-medium"><ResourceIcon resource={r} size={18}/>{r.name}</span>}</TableCell><TableCell>{providerLabel[r.provider]}</TableCell><TableCell>{kindNames[r.kind]}</TableCell><TableCell className="font-mono text-xs">{r.specs['인스턴스']??r.specs['종류']??'—'}</TableCell><TableCell className="max-w-[200px] truncate">{snapshot.scopeLabels[r.scope]??r.scope}</TableCell><TableCell className="font-mono text-xs">{r.ip??r.cidr??'—'}</TableCell><TableCell>{r.region}</TableCell><TableCell><StatusBadge status={r.status}/></TableCell></TableRow>;})}</TableBody></Table>
      {!shown.length&&<p className="p-6 text-center text-sm text-muted-foreground">조건에 맞는 자원이 없습니다.</p>}</div>
  </Panel>;
}
export function ResourcesPage({snapshot,focus,query,onOpen}:{snapshot:Snapshot;focus:Focus;query:string;onOpen:(r:Resource)=>void}){
  const [category,setCategory]=useState<CategoryId|'all'>('all'),[showAuxiliary,setShowAuxiliary]=useState(false);
  const q=query.trim().toLowerCase(),live=snapshot.mode==='live';
  const scoped=useMemo(()=>snapshot.resources.filter(r=>inScope(focus,r.provider,r.scope)&&(showAuxiliary||!isAuxiliary(r))&&(!q||`${r.name} ${r.ip??''} ${r.cidr??''} ${r.type} ${snapshot.scopeLabels[r.scope]??''}`.toLowerCase().includes(q))),[snapshot,focus,q,showAuxiliary]);
  const rows=category==='all'?scoped:scoped.filter(r=>categoryOf(r.kind)===category);
  const vms=scoped.filter(r=>r.kind==='compute'),fleet=fleetTotals(vms),sizeIssues=capacityIssues(vms),states=statusCounts(scoped);
  const counts=Object.fromEntries(CATEGORIES.map(c=>[c.id,scoped.filter(r=>categoryOf(r.kind)===c.id).length]));
  return <div className="page"><header className="page-head"><div><h1>리소스</h1><p>{live?'':'예시 데이터입니다. '}종류별 현황과 VM 용량·사용률을 봅니다. 이름을 누르면 토폴로지에서 위치를 보여줍니다.</p></div><div className="page-actions">{q&&<Badge variant="secondary">검색: {query}</Badge>}<label><input type="checkbox" checked={showAuxiliary} onChange={e=>setShowAuxiliary(e.target.checked)}/> 구성 부속물 포함</label></div></header>
    <CollectionNotice snapshot={snapshot} focus={focus}/>
    {sizeIssues.length>0&&<div className="notice warn page-notice" role="status"><p><strong>VM 용량 확인 필요 · </strong>{sizeIssues.map(c=>`${c.reason} ${c.count}대`).join(' / ')}. 실행 중 VM에서 확인되지 않은 vCPU·메모리 값은 합계에서 제외됩니다. 자원 상세의 크기 조회 사유를 확인하세요.</p></div>}
    <div className="shad grid grid-cols-[minmax(0,1fr)] gap-3">
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="리소스 지표">
        <Kpi icon={Boxes} label="전체 리소스" value={num(scoped.length)} hint={states.warn?`이상 ${states.warn}개`:'이상 없음'} tone={states.warn?'bad':undefined}/>
        <Kpi icon={Server} label="VM" value={num(fleet.count)} hint={`실행 ${fleet.running} · 중지 ${fleet.stopped}`}/>
        <Kpi icon={Cpu} label="vCPU" value={num(fleet.vcpu)} hint={fleet.unsized?`크기 미확인 ${fleet.unsized}대 제외`:'실행 중 VM 합계'}/>
        <Kpi icon={MemoryStick} label="메모리" value={gib(fleet.memoryGiB)} hint="실행 중 VM 합계"/>
        <Kpi icon={HardDrive} label="디스크" value={gib(fleet.diskGiB)} hint={fleet.undisked?`미수집 ${fleet.undisked}대`:'연결된 디스크 합계'}/>
        <Kpi icon={Activity} label="GPU" value={num(fleet.gpus)} hint={fleet.gpuHosts?`${fleet.gpuHosts}대에 장착`:'GPU 인스턴스 없음'}/>
      </section>
      <Tabs value={category} onValueChange={v=>setCategory(v as CategoryId|'all')} className="min-w-0"><TabsList className="h-9 max-w-full justify-start overflow-x-auto" aria-label="리소스 분류"><TabsTrigger value="all" className="px-3">전체 <span className="ml-1 tabular-nums text-muted-foreground">{scoped.length}</span></TabsTrigger>{CATEGORIES.filter(c=>counts[c.id]).map(c=><TabsTrigger key={c.id} value={c.id} className="px-3">{c.label} <span className="ml-1 tabular-nums text-muted-foreground">{counts[c.id]}</span></TabsTrigger>)}</TabsList></Tabs>
      {category==='all'&&<div className="grid items-start gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"><Panel title="종류별 리소스" description="막대를 누르면 그 분류로 이동합니다"><KindChart rows={scoped} onPick={setCategory}/></Panel><div className="grid gap-3"><Panel title="상태"><StatusDonut rows={scoped}/></Panel>{vms.length>0&&<Utilization vms={vms} live={live}/>}</div></div>}
      <CategoryPanels category={category} rows={rows} live={live}/>
      <Inventory key={category} snapshot={snapshot} rows={rows} onOpen={onOpen}/>
    </div></div>;
}
