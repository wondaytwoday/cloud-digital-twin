import type {AuditEvent} from '../../shared/schema.js';
// Two weeks of made-up portal use for the demo: a few operators, a failed login burst, collections and exports.
const PEOPLE=['kim.ops','lee.sec','park.finops','choi.dev','jung.net'];
const PAGES=['dashboard','map','inventory','network','security','iam','cost','audit','findings','changes'];
const OPENED=['api-prod-01','vnet-hub','rds-orders','checkout-api-01','afw-hub','tgw-core','web-01','vpc-commerce','sql-platform','analytics-api-01'];
const rand=(seed:number)=>{let x=seed;return()=>{x=(x*1103515245+12345)%2147483648;return x/2147483648;};};
export function demoAudit(now:Date):AuditEvent[]{
  const r=rand(42),out:AuditEvent[]=[],start=now.getTime()-14*86_400_000;let n=0;
  const add=(at:number,e:Omit<AuditEvent,'id'|'at'|'demo'>)=>out.push({id:`demo-${n++}`,at:new Date(at).toISOString(),demo:true,...e});
  for(let day=0;day<14;day++){
    const base=start+day*86_400_000,weekend=new Date(base).getUTCDay()%6===0;
    for(const person of PEOPLE){
      if(weekend&&r()<.8)continue;if(r()<.15)continue;
      let t=base+(8+r()*2)*3_600_000-9*3_600_000;add(t,{actor:person,action:'login'});
      const visits=3+Math.floor(r()*8);
      for(let i=0;i<visits;i++){t+=r()*40*60_000;const page=PAGES[Math.floor(r()*PAGES.length)];add(t,{actor:person,action:'view',target:page});if(page==='map'||page==='inventory'){t+=60_000;add(t,{actor:person,action:'open',target:OPENED[Math.floor(r()*OPENED.length)]});}}
      if(person==='park.finops'&&r()<.5)add(t+120_000,{actor:person,action:'export',target:'cost',detail:'비용 CSV'});
      if(person==='kim.ops'&&r()<.6)add(t+60_000,{actor:person,action:'collect',detail:'수집 시작'});
      if(r()<.6)add(t+30*60_000,{actor:person,action:'logout'});
    }
  }
  // A burst of bad tokens from one address, the kind of thing this page exists to show.
  const burst=now.getTime()-2*86_400_000-3*3_600_000;for(let i=0;i<7;i++)add(burst+i*20_000,{actor:'알 수 없음',action:'login_failed',detail:'잘못된 토큰'});
  add(burst+200_000,{actor:'인증 안 됨',action:'denied',target:'/api/topology'});
  return out.filter(e=>Date.parse(e.at)<=now.getTime()).sort((a,b)=>b.at.localeCompare(a.at));
}
