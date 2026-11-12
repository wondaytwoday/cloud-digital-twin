import {expect,test} from '@playwright/test';
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('atlas.guide.seen','1'));
  await page.route('https://fonts.g*/**',r=>r.abort());
});

test('resource sorting survives category changes and route revisits',async({page})=>{
  await page.goto('/?scenario=standard&view=inventory');
  const heading=page.getByRole('columnheader',{name:'리소스',exact:true});
  await heading.getByRole('button').click();
  await expect(heading).toHaveAttribute('aria-sort','descending');
  await page.getByRole('tab',{name:/^컴퓨팅/}).click();
  await expect(heading).toHaveAttribute('aria-sort','descending');
  await page.getByRole('navigation',{name:'주 메뉴'}).getByRole('button',{name:'비용',exact:true}).click();
  await expect(page.getByRole('heading',{name:'비용',exact:true})).toBeVisible();
  await page.getByRole('navigation',{name:'주 메뉴'}).getByRole('button',{name:'리소스',exact:true}).click();
  await expect(heading).toHaveAttribute('aria-sort','descending');
  await expect(page.getByRole('tab',{name:/^컴퓨팅/})).toHaveAttribute('aria-selected','true');
});

test('first visits to different views reuse the validated resource core',async({page})=>{
  await page.goto('/?scenario=standard&view=inventory');
  await expect(page.getByRole('heading',{name:'리소스',exact:true})).toBeVisible();
  const response=page.waitForResponse(r=>r.url().includes('/api/topology?')&&r.url().includes('part=network'));
  await page.getByRole('navigation',{name:'주 메뉴'}).getByRole('button',{name:'네트워크',exact:true}).click();
  const body=await (await response).json();
  expect(body.transport).toBe(1);expect(body.metadata).toBeDefined();
  expect(body.metadata.resources).toBeUndefined();expect(body.snapshot).toBeUndefined();
  await expect(page.getByRole('heading',{name:'네트워크',exact:true})).toBeVisible();
});

test('keyboard opens edge evidence and Escape returns to the focused edge',async({page})=>{
  await page.goto('/?scenario=standard&view=map');
  const edge=page.locator('.react-flow__edge').first();await expect(edge).toBeVisible();
  await edge.focus();await page.keyboard.press('Enter');
  await expect(page.locator('.panel-host')).toContainText('근거');
  await page.keyboard.press('Escape');await expect(edge).toBeFocused();
  await expect(page.locator('.panel-host')).toBeEmpty();
});

test('refresh retains content and filters while a different view waits for its own data',async({page})=>{
  await page.goto('/?scenario=standard&view=inventory');
  await page.getByRole('tab',{name:/^컴퓨팅/}).click();
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/topology?**',async route=>{await held;await route.continue();});
  await page.getByRole('button',{name:'데이터 새로고침'}).click();
  await expect(page.getByRole('heading',{name:'리소스',exact:true})).toBeVisible();
  await expect(page.getByRole('tab',{name:/^컴퓨팅/})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.body-main')).toHaveAttribute('aria-busy','true');
  await expect(page.locator('.refresh-notice')).toBeVisible();
  release();await expect(page.locator('.body-main')).toHaveAttribute('aria-busy','false');
  await page.unroute('**/api/topology?**');
  let releaseNext!:()=>void;const next=new Promise<void>(resolve=>{releaseNext=resolve;});
  await page.route('**/api/topology?**',async route=>{await next;await route.continue();});
  await page.getByRole('navigation',{name:'주 메뉴'}).getByRole('button',{name:'비용',exact:true}).click();
  await expect(page.getByRole('heading',{name:'비용',exact:true})).toHaveCount(0);
  await expect(page.locator('.body-main .skeleton')).toBeVisible();
  releaseNext();await expect(page.getByRole('heading',{name:'비용',exact:true})).toBeVisible();
});

test('IME composition does not navigate and Enter searches the current input immediately',async({page})=>{
  await page.goto('/?scenario=standard&view=inventory');
  const input=page.getByLabel('리소스와 범위 검색');
  await expect(page.getByRole('heading',{name:'리소스',exact:true})).toBeVisible();
  await input.dispatchEvent('compositionstart');
  await input.fill('api-prod-01');await input.press('Enter');
  await expect(page).toHaveURL(/view=inventory/);
  await input.dispatchEvent('compositionend');await input.press('Enter');
  await expect(page).toHaveURL(/view=map/);
  await expect(page.locator('.react-flow__node')).not.toHaveCount(0);
});

test('live inventory receives summaries, pages on the server, and opens a selected resource',async({page})=>{
  const {validateSnapshot}=await import('../shared/schema');
  const {projectSnapshot}=await import('../shared/presentation');
  const {resourcePage}=await import('../server/pages');
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-12T00:00:00Z',resources:[{id:'subnet',nativeId:'subnet',name:'fake-subnet',provider:'aws',scope:'a',region:'r',kind:'subnet',type:'AWS::EC2::Subnet',source:'fake'},...Array.from({length:205},(_,i)=>({id:`vm-${i}`,nativeId:`vm-${i}`,name:`VM ${i}`,provider:'aws',scope:'a',region:'r',kind:'compute',parent:'subnet',type:'AWS::EC2::Instance',source:'fake',specs:{large:'x'.repeat(1000)}}))],links:[],warnings:[],scopes:['a']});
  await page.route('**/api/collect/status',r=>r.fulfill({json:{enabled:false,running:false,providers:{}}}));
  await page.route('**/api/topology?*',route=>route.fulfill({json:projectSnapshot(snapshot,new URL(route.request().url()).searchParams.get('part')??'full')}));
  await page.route('**/api/resources?*',route=>route.fulfill({json:resourcePage(snapshot,new URL(route.request().url()).searchParams)}));
  await page.route('**/api/resource?*',route=>route.fulfill({json:{version:1,resource:snapshot.resources.find(r=>r.id===new URL(route.request().url()).searchParams.get('id'))}}));
  const response=page.waitForResponse(r=>r.url().includes('/api/topology?'));
  await page.goto('/?view=inventory');const body=await (await response).json();expect(body.resources).toEqual([]);
  await expect(page.locator('tbody tr')).toHaveCount(100);await expect(page.locator('.recharts-label-list text').first()).toBeVisible();await page.screenshot({path:'/tmp/atlas-issue8-resources.png',fullPage:true});
  await page.setViewportSize({width:375,height:812});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/atlas-issue8-resources-mobile.png',fullPage:true});await page.setViewportSize({width:1600,height:1000});
  await page.getByRole('button',{name:'다음 페이지'}).click();await expect(page.locator('tbody tr')).toHaveCount(100);
  await page.getByRole('tab',{name:/^컴퓨팅/}).click();await expect(page.getByRole('group',{name:'리소스 페이지'})).toContainText('1 / 3');
  const name=await page.locator('tbody .table-link').first().textContent();await page.locator('tbody .table-link').first().click();
  await expect(page).toHaveURL(/view=map/);await expect(page.locator('.inspector h2')).toHaveText(name!.trim());
});

test('the item picker submits exactly one requested item and disables input during that run',async({page})=>{
  const {validateSnapshot}=await import('../shared/schema');
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-12T00:00:00Z',resources:[],links:[],warnings:[],scopes:[]});let running=false;
  await page.route('**/api/topology?*',route=>route.fulfill({json:snapshot}));
  await page.route('**/api/collect/status',route=>route.fulfill({json:{enabled:true,running,selectedItems:running?[{provider:'azure',item:'compute'},{provider:'azure',item:'network'}]:undefined,providers:{azure:{state:running?'running':'idle',stages:[{id:'resources',label:'자원·네트워크',state:'running'}]},aws:{state:'idle'},gcp:{state:'idle'}}}}));
  await page.route('**/api/collect',route=>{running=true;return route.fulfill({status:202,json:{started:true,runId:'fake-run'}});});
  await page.goto('/?view=scopes');await page.getByLabel('수집 상태 보기').click();await page.getByText('제공자·항목 선택 수집',{exact:true}).click();
  await page.locator('.collection-picker summary').filter({hasText:'Microsoft Azure'}).click();
  const posted=page.waitForRequest(r=>r.url().endsWith('/api/collect')&&r.method()==='POST');await page.getByRole('button',{name:'Microsoft Azure VM만 수집',exact:true}).click();
  expect((await posted).postDataJSON()).toEqual({mode:'selected',items:[{provider:'azure',item:'compute'}]});
  await expect(page.locator('.collection-picker input').first()).toBeDisabled();await expect(page.locator('.collect-progress')).toContainText('선택 항목: VM, 네트워크·보안 정책');
  await expect(page.locator('.collect-progress section')).toHaveCount(1);await page.screenshot({path:'/tmp/atlas-issue8-collection.png',fullPage:true});
});

test('policy badges open configured rule evidence without enabling policy edges',async({page})=>{
  await page.goto('/?scenario=standard&view=map');
  await expect(page.getByRole('button',{name:'정책',exact:true})).toHaveAttribute('aria-pressed','false');
  await expect(page.getByRole('button',{name:/^보안 정책 \d+개 근거 보기$/}).first()).toBeVisible();await expect(page.locator('.tool-busy')).toHaveCount(0);expect(await page.locator('.bar-tools').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.waitForTimeout(350);
  await page.screenshot({path:'/tmp/atlas-issue8-map.png',fullPage:true});
  await page.getByRole('button',{name:/^보안 정책 \d+개 근거 보기$/}).first().click();
  await expect(page.getByRole('region',{name:'접근 관계도'})).toBeVisible();
  await expect(page.locator('.access-row').first()).toContainText('정책 적용');
});
