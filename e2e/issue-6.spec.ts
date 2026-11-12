import {resourcePage,activityPage} from '../server/pages';
import {test,expect,type Page} from '@playwright/test';
import {validateSnapshot,type Snapshot} from '../shared/schema';
import {projectSnapshot} from '../shared/presentation';
const fake=()=>validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-10T00:00:00Z',resources:[
  {id:'vpc',nativeId:'vpc',name:'fake-vpc',provider:'aws',kind:'network',type:'AWS::EC2::VPC',scope:'111111111111',region:'r',source:'fake'},
  {id:'subnet',nativeId:'subnet',name:'fake-subnet',parent:'vpc',provider:'aws',kind:'subnet',type:'AWS::EC2::Subnet',scope:'111111111111',region:'r',source:'fake'},
],links:[],warnings:[],scopes:['111111111111'],hierarchy:[{id:'aws:scope:111111111111',nativeId:'111111111111',name:'Fake account',provider:'aws',kind:'account',scope:'111111111111'}]});
async function serve(page:Page,snapshot:Snapshot,onPart?:(part:string)=>void){
  await page.addInitScript(()=>localStorage.setItem('atlas.guide.seen','1'));
  await page.route('https://fonts.g*/**',route=>route.abort());
  await page.route('**/api/collect/status',route=>route.fulfill({json:{enabled:false,running:false,providers:{azure:{state:'idle'},aws:{state:'idle'},gcp:{state:'idle'}}}}));
  await page.route('**/api/resources?*',route=>route.fulfill({json:resourcePage(snapshot,new URL(route.request().url()).searchParams)}));
  await page.route('**/api/activity?*',route=>route.fulfill({json:activityPage(snapshot,new URL(route.request().url()).searchParams)}));
  await page.route('**/api/topology?*',route=>{const part=new URL(route.request().url()).searchParams.get('part')??'full';onPart?.(part);return route.fulfill({json:projectSnapshot(snapshot,part)});});
}
test('scope summary loads first, pages fetch their own data once, and export retrieves the full snapshot',async({page})=>{
  const snapshot=fake(),parts:string[]=[];snapshot.cost=[{provider:'aws',scope:'111111111111',service:'fake-compute',month:'2026-11',amount:10,currency:'USD'}];
  await serve(page,snapshot,part=>parts.push(part));
  await page.goto('/?view=scopes');await expect(page.locator('.home-stats dd').nth(1)).toHaveText('2');expect(parts).toEqual(['scopes']);
  await page.getByRole('button',{name:'비용',exact:true}).click();await expect(page.getByRole('heading',{name:'비용',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'리소스',exact:true}).click();await expect(page.getByRole('heading',{name:'리소스',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'비용',exact:true}).click();await expect(page.getByRole('heading',{name:'비용',exact:true})).toBeVisible();
  expect(parts.filter(p=>p==='cost')).toHaveLength(1);expect(parts.filter(p=>p==='inventory')).toHaveLength(1);
  await page.getByLabel('내보내기',{exact:true}).click();const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'스냅샷 JSON'}).click();await downloaded;
  expect(parts.at(-1)).toBe('full');
});
test('empty billing export is visibly pending rather than a successful zero cost',async({page})=>{
  const snapshot=fake();snapshot.costCoverage=[{provider:'gcp',state:'pending',reason:'waiting-data',failedScopes:[]}];
  await serve(page,snapshot);await page.goto('/?view=cost&scope=provider:gcp');
  await expect(page.getByRole('status').filter({hasText:'비용 데이터 대기'})).toContainText('결제 내보내기 데이터 대기 중');
  await expect(page.locator('.kpi-row')).toHaveCount(0);
});
test('large inventories use bounded pages and summarized configuration remains inspectable',async({page})=>{
  const snapshot=fake();snapshot.resources.push(...Array.from({length:1000},(_,i)=>({...snapshot.resources[0],id:`vm-${i}`,nativeId:`vm-${i}`,name:`fake-vm-${String(i).padStart(4,'0')}`,kind:'compute' as const,type:'AWS::EC2::Instance',status:'running',parent:'subnet'})));
  snapshot.inventoryMode='summary';snapshot.inventorySummary=[{provider:'aws',scope:'111111111111',type:'ssm:association',tier:3,count:500,examples:[{id:'fake-config',name:'fake-config-example'}]}];
  await serve(page,snapshot);await page.goto('/?view=inventory');
  await expect(page.locator('tbody tr')).toHaveCount(100);await page.getByRole('button',{name:'다음 페이지'}).click();await expect(page.locator('tbody tr')).toHaveCount(100);
  await page.getByRole('checkbox',{name:'구성 부속물 포함'}).check();await expect(page.getByText('fake-config-example',{exact:false})).toBeVisible();
  await page.setViewportSize({width:375,height:812});await expect(page.getByRole('heading',{name:'리소스',exact:true})).toBeVisible();
});
test('workloads start grouped, isolated counts are visible, and exact searches reveal a member',async({page})=>{
  const snapshot=fake();snapshot.resources.push(...Array.from({length:100},(_,i)=>({...snapshot.resources[0],id:`vm-${i}`,nativeId:`vm-${i}`,name:`grouped-vm-${i}`,kind:'compute' as const,type:'AWS::EC2::Instance',status:'running',parent:'subnet'})));
  snapshot.resources.push({...snapshot.resources[0],id:'isolated',nativeId:'isolated',name:'isolated-service',kind:'service',type:'future:type'});
  await serve(page,snapshot);await page.goto('/?view=map');await page.getByRole('button',{name:'워크로드',exact:true}).click();
  await expect(page.locator('.summary.v-workload')).toContainText('VM · 100개');await expect(page.locator('.map-workload-note')).toContainText('지도 밖 자원 1개');
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  await page.getByLabel('리소스와 범위 검색').fill('grouped-vm-42');await page.keyboard.press('Enter');await expect(page.locator('.rc',{hasText:'grouped-vm-42'})).toBeVisible();
});
test('access layer separates policy and role evidence from network connectivity',async({page})=>{
  const snapshot=fake();snapshot.resources.push({...snapshot.resources[0],id:'policy',nativeId:'policy',name:'fake-security-group',kind:'firewall',parent:'vpc',rules:[{direction:'Inbound',action:'Allow',protocol:'tcp',ports:'22',source:'0.0.0.0/0',destination:'All',priority:'1'}]});
  snapshot.links=[{id:'policy-subnet',source:'policy',target:'subnet',kind:'policy',label:'fake-apply',evidence:'fake subnet securityGroups field'}];
  snapshot.iam=[{id:'binding',provider:'aws',principal:'fake-reader',principalType:'role',role:'ReadOnly',scope:'111111111111',targetResource:'subnet',level:'resource',privileged:false,external:false,source:'fake binding'}];
  await serve(page,snapshot);await page.goto('/?view=map');await page.getByRole('button',{name:'접근 관계',exact:true}).click();
  const panel=page.getByRole('region',{name:'접근 관계도'});await expect(panel).toContainText('실제 통신·도달 가능 여부·실효 권한을 뜻하지 않습니다');await expect(panel.locator('.access-row')).toHaveCount(2);
  await panel.locator('.access-row').filter({hasText:'정책 적용'}).locator('summary').click();await expect(panel).toContainText('fake subnet securityGroups field');await expect(panel).toContainText('0.0.0.0/0');
  await page.screenshot({path:'/tmp/atlas6-access.png'});await page.getByRole('button',{name:'네트워크 관계',exact:true}).click();await expect(page.locator('.react-flow')).toBeVisible();
});
