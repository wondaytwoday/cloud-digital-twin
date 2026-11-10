import {expect,test,type Page} from '@playwright/test';
const settled=async(page:Page)=>{await page.waitForSelector('.react-flow__node');await expect(page.locator('.tool-busy')).toHaveCount(0);await page.waitForTimeout(500);};
const openMap=async(page:Page,scenario='standard',extra='')=>{await page.goto(`/?scenario=${scenario}&view=map${extra}`);await settled(page);};
const search=(page:Page)=>page.getByLabel('리소스와 범위 검색');
// External fonts are not under test, and their network timing must not decide whether the suite passes.
test.beforeEach(async({page})=>{await page.addInitScript(()=>localStorage.setItem('atlas.guide.seen','1'));page.on('pageerror',e=>{throw e;});await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());});
test('home shows all three org hierarchies and opens a scope as a tab',async({page})=>{
  await page.goto('/?scenario=enterprise&view=scopes');
  for(const name of ['Microsoft Azure','Amazon Web Services','Google Cloud'])await expect(page.getByRole('heading',{name})).toBeVisible();
  await page.locator('.scope-open',{hasText:'Corp KR'}).click();await settled(page);
  await expect(page.locator('.map-tab.active')).toContainText('Corp KR');
  await expect(page.locator('.crumbs')).toContainText('Landing Zones');
  await page.goBack();await expect(page.locator('.scope-tree').first()).toBeVisible();
});
test('deep link restores view and scope',async({page})=>{
  await openMap(page,'enterprise','&scope='+encodeURIComponent('aws:ou:ou-prod-kr'));
  await expect(page.locator('.map-tab.active')).toContainText('Prod KR');
});
test('a hanging font CDN does not delay the page',async({page})=>{
  await page.unroute('https://fonts.googleapis.com/**');await page.route('https://fonts.googleapis.com/**',()=>{/* never answers */});
  await page.goto('/?scenario=standard&view=scopes',{waitUntil:'commit'});await expect(page.locator('.scope-tree').first()).toBeVisible({timeout:5_000});
});
test('official icons all load under the CSP',async({page})=>{
  await openMap(page);
  expect(await page.locator('img').evaluateAll(imgs=>imgs.filter(i=>!(i as HTMLImageElement).naturalWidth).length)).toBe(0);
});
test('a slow earlier scenario cannot overwrite the current one',async({page})=>{
  await page.route('**/api/topology?scenario=enterprise*',async r=>{await new Promise(s=>setTimeout(s,800));await r.continue().catch(()=>{});});
  await page.goto('/?scenario=standard&view=scopes');await page.waitForSelector('.scope-tree');
  const pick=page.getByLabel('예시 아키텍처');await pick.selectOption('enterprise');await pick.selectOption('single-vm');await page.waitForTimeout(1300);
  await expect.poll(async()=>Number(await page.locator('.home-stats dd').nth(1).textContent())).toBeLessThan(20);
});
test('clicking blank frame space does not collapse it',async({page})=>{
  await openMap(page);const before=await page.locator('.react-flow__node').count(),box=(await page.locator('.frame.v-provider.aws').boundingBox())!;
  await page.mouse.click(box.x+box.width-12,box.y+box.height/2);await page.waitForTimeout(400);
  expect(await page.locator('.react-flow__node').count()).toBe(before);
});
test('expanding in one cloud leaves other clouds internally untouched',async({page})=>{
  await openMap(page);
  const positions=()=>page.locator('.react-flow__node').evaluateAll(n=>Object.fromEntries(n.map(e=>[(e as HTMLElement).dataset.id,(e as HTMLElement).style.transform])));
  const before=await positions();await page.getByLabel('vpc-commerce 접기').click();await settled(page);const after=await positions();
  const azure=Object.keys(before).filter(k=>k.startsWith('azure:')&&after[k]);expect(azure.length).toBeGreaterThan(5);
  for(const k of azure)expect(after[k]).toBe(before[k]);
});
test('path hop click moves the map and keeps the panel',async({page})=>{
  await openMap(page);await page.getByRole('button',{name:'경로 추적'}).click();await settled(page);
  const transform=()=>page.locator('.react-flow__viewport').evaluate(e=>(e as HTMLElement).style.transform),before=await transform();
  await page.locator('.hops li').nth(2).getByRole('button').click();await page.waitForTimeout(600);
  expect(await transform()).not.toBe(before);await expect(page.locator('.hops button.is-active')).toHaveCount(1);
});
test('path picker finds a target by typing',async({page})=>{
  await openMap(page);await page.getByRole('button',{name:'경로 추적'}).click();await settled(page);
  await page.getByRole('combobox',{name:'목적지'}).fill('sql-pl');await page.keyboard.press('Enter');await settled(page);
  await expect(page.locator('.hops li').last()).toContainText('sql-platform');
});
test('jumping out of a scope updates tab and URL together',async({page})=>{
  await openMap(page,'standard','&scope='+encodeURIComponent('aws:ou:ou-workloads'));
  await search(page).fill('api-prod-01');await page.keyboard.press('Enter');await settled(page);
  await expect(page.locator('.map-tab.active')).toContainText('전체 지도');expect(page.url()).not.toContain('scope=');
});
test('opening a policy turns its layer on',async({page})=>{
  await page.goto('/?scenario=standard&view=scopes');await page.getByRole('button',{name:/^sg-alb/}).click();await settled(page);
  await expect(page.locator('.rc',{hasText:'sg-alb'})).toBeVisible();
});
test('keyboard opens a node',async({page})=>{
  await openMap(page);await page.locator('.react-flow__node-resource').first().focus();await page.keyboard.press('Enter');
  await expect(page.locator('.inspector')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('.inspector')).toHaveCount(0);
});
test('search results close on outside press',async({page})=>{
  await page.goto('/?scenario=standard');await search(page).fill('web');await expect(page.locator('.search-results')).toBeVisible();
  await page.mouse.click(600,160);await expect(page.locator('.search-results')).toHaveCount(0);
});
test('collapse control stays usable when zoomed far out',async({page})=>{
  await openMap(page);await expect(page.locator('.canvas.lod-far')).toHaveCount(1);await expect(page.getByLabel('vpc-commerce 접기')).toBeVisible();
});
test('inventory filters and sorts',async({page})=>{
  await page.goto('/?scenario=standard&view=inventory');await page.waitForSelector('table');
  await page.getByLabel('유형').selectOption('compute');await page.getByRole('button',{name:'상태'}).click();
  await expect(page.getByRole('columnheader',{name:'상태'})).toHaveAttribute('aria-sort','ascending');
  expect(await page.locator('tbody tr').count()).toBeGreaterThan(5);
});
test('resources is its own page: no map tabs or scope tree, charts per category',async({page})=>{
  await page.goto('/?scenario=standard&view=inventory');await expect(page.getByRole('heading',{name:'리소스',level:1})).toBeVisible();
  await expect(page.getByRole('tablist',{name:'열린 범위'})).toHaveCount(0);await expect(page.getByRole('complementary',{name:'관리 범위 탐색'})).toHaveCount(0);await expect(page.getByText('전체 지도')).toHaveCount(0);
  await expect(page.getByRole('img').or(page.locator('.recharts-surface')).first()).toBeVisible();
  await page.getByRole('tab',{name:/^컴퓨팅/}).click();
  await expect(page.getByText('VM 사용률')).toBeVisible();await expect(page.getByText('GPU 인스턴스')).toBeVisible();
  expect(await page.getByRole('meter').count()).toBeGreaterThan(5);
  await page.getByRole('button',{name:/^api-prod-01/}).click();await expect(page).toHaveURL(/view=map/);
});
test('cost shows one currency at a time and converts with the rate',async({page})=>{
  await page.goto('/?scenario=standard&view=cost');await page.waitForSelector('.kpi-row');
  await page.getByRole('button',{name:'달러 $'}).click();await expect(page.locator('.kpi strong').first()).toContainText('$');
  await page.getByRole('button',{name:'원화 ₩'}).click();await expect(page.locator('.kpi strong').first()).toContainText('₩');
  const before=await page.locator('.kpi strong').first().textContent();
  await page.getByLabel('환율 (1 USD당 원)').fill('2760');await expect(page.locator('.kpi strong').first()).not.toHaveText(before!);
  await expect(page.getByText('직접 입력').first()).toBeVisible();
});
test('access log shows portal use and cloud changes',async({page})=>{
  await page.goto('/?scenario=standard&view=audit');await expect(page.getByRole('heading',{name:'접근 로그'})).toBeVisible();
  await expect(page.getByText('로그인 실패가 몰린 구간')).toBeVisible();
  await page.getByLabel('행동').selectOption('login_failed');expect(await page.locator('tbody tr').count()).toBeGreaterThan(4);
  await page.getByRole('tab',{name:'클라우드 변경'}).click();await expect(page.getByText('변경 기록').first()).toBeVisible();
  await page.getByLabel('변경 종류').selectOption('sensitive');await expect(page.locator('tbody tr').first()).toContainText('민감');
  await page.locator('tbody .table-link').first().click();await expect(page).toHaveURL(/view=map/);
});
test('the dashboard summarises every area with links into each',async({page})=>{
  await page.goto('/?scenario=standard');await expect(page.getByRole('heading',{name:'통합 대시보드'})).toBeVisible();
  for(const t of ['클라우드별 리소스','월별 비용','우선 조치','보안','네트워크','VM 용량','클라우드 변경 기록','포털 접근'])await expect(page.getByRole('heading',{name:new RegExp('^'+t)})).toBeVisible();
  await page.getByRole('heading',{name:/^VM 용량/}).locator('xpath=../..').getByRole('button',{name:'자세히'}).click();await expect(page).toHaveURL(/view=inventory/);
});
test('exports produce files',async({page})=>{
  await openMap(page);
  for(const [label,ext] of [['draw.io','.drawio'],['지도 PNG','.png'],['지도 SVG','.svg'],['스냅샷 JSON','.json']] as const){
    await page.locator('.export-menu summary').click();
    const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:label}).click()]);
    expect(file.suggestedFilename()).toContain(ext);
    if(ext==='.svg'){const stream=await file.createReadStream();let body='';for await(const chunk of stream)body+=chunk;expect((body.match(/<path d=/g)??[]).length,'connections are in the file').toBeGreaterThan(5);expect(body).toContain('<image');}
  }
});
test('phone width has no horizontal page scroll',async({browser})=>{
  const page=await (await browser.newContext({viewport:{width:390,height:844}})).newPage();await page.addInitScript(()=>localStorage.setItem('atlas.guide.seen','1'));await page.goto('/?scenario=standard');await page.waitForSelector('.kpi-row');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test.describe('first visit',()=>{
  test('guide opens once, covers each cloud, and closing shows mock dashboards',async({browser})=>{
    const context=await browser.newContext({viewport:{width:1600,height:1000}}),page=await context.newPage();
    await page.route('https://fonts.g*/**',r=>r.abort());await page.goto('/?scenario=standard');
    const guide=page.getByRole('dialog',{name:'클라우드 연결 가이드'});await expect(guide).toBeVisible();
    await expect(guide).toContainText('목데이터 모드');await expect(guide).toContainText('npm run check');
    for(const [tab,text] of [['Microsoft Azure','Cost Management Reader'],['Amazon Web Services','AtlasCollector'],['Google Cloud','ATLAS_GCP_BILLING_TABLE']]){await guide.getByRole('tab',{name:tab}).click();await expect(guide).toContainText(text);}
    await guide.getByRole('button',{name:'목데이터로 둘러보기'}).click();await expect(guide).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'통합 대시보드'})).toBeVisible();await expect(page.locator('.kpi-row')).toContainText('이번 달 예상 비용');
    await page.getByRole('button',{name:'토폴로지',exact:true}).click();await page.waitForSelector('.react-flow__node');
    await page.reload();await page.waitForSelector('.react-flow__node');await expect(guide).toHaveCount(0);
    await page.getByRole('button',{name:'클라우드 연결'}).click();await expect(guide).toBeVisible();await page.keyboard.press('Escape');await expect(guide).toHaveCount(0);
    await context.close();
  });
});
test('findings page filters by area and jumps to the evidence',async({page})=>{
  await page.goto('/?scenario=standard&view=findings');await page.waitForSelector('.finding-list');
  await page.getByRole('group',{name:'영역 필터'}).getByRole('button',{name:'네트워크'}).click();
  await page.locator('.finding-list button',{hasText:'dev-sandbox-01'}).click();await settled(page);
  await expect(page.locator('.inspector')).toContainText('dev-sandbox-01');
});
test('cost page filters and exports what is shown',async({page})=>{
  await page.goto('/?scenario=standard&view=cost');await page.waitForSelector('.bars');
  await page.getByRole('group',{name:'클라우드 필터'}).getByRole('button',{name:'AWS'}).click();await expect(page.locator('.chart-legend li')).toHaveCount(1);
  await page.getByRole('button',{name:'표 보기'}).click();await expect(page.locator('.cost-trend table tbody tr')).toHaveCount(6);
  const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'CSV'}).click()]);expect(file.suggestedFilename()).toBe('cloud-atlas-cost-KRW.csv');
});
test('IAM page lists principals across clouds and opens assignments',async({page})=>{
  await page.goto('/?scenario=standard&view=iam');await page.waitForSelector('.data-table');
  await page.getByLabel('조건').selectOption('external');await expect(page.locator('tbody tr')).not.toHaveCount(0);
  await page.getByLabel('조건').selectOption('all');await page.getByLabel('주체와 역할 검색').fill('legacy-admin');
  await page.locator('tbody tr button').first().click();await expect(page.locator('.drawer')).toContainText('AdministratorAccess');
});
test('security page finds rules by port',async({page})=>{
  await page.goto('/?scenario=standard&view=security');await page.waitForSelector('.data-table');
  await page.getByLabel('포트로 찾기').fill('22');await expect(page.locator('.table-link',{hasText:'nsg-dev'}).first()).toBeVisible();
});
test('network page lists peerings and jumps to the map',async({page})=>{
  await page.goto('/?scenario=standard&view=network');await page.waitForSelector('.data-table');
  await expect(page.locator('.overlap-rows li').first()).toBeVisible();await expect(page.getByRole('heading',{name:/^피어링/})).toBeVisible();
  await page.locator('.table-link',{hasText:'er-seoul-01'}).first().click();await settled(page);await expect(page.locator('.inspector')).toContainText('er-seoul-01');
});
test('non-network services open in the inventory, not an empty map',async({page})=>{
  await page.goto('/?scenario=standard');await page.waitForSelector('.kpi-row');await page.getByLabel('리소스와 범위 검색').fill('commerce-prod-assets');await page.keyboard.press('Enter');
  await expect(page.locator('tbody tr',{hasText:'commerce-prod-assets'})).toBeVisible();
});
test('a scope chosen on one page applies everywhere and survives back',async({page})=>{
  await page.goto('/?scenario=enterprise');await page.waitForSelector('.kpi-row');
  const total=Number(await page.locator('.kpi',{hasText:/^리소스/}).locator('strong').textContent());
  await page.locator('.scope-picker summary').click();await page.locator('.scope-pop .scope-open',{hasText:'Corp KR'}).click();
  await expect(page.locator('.scope-pop')).toBeHidden();await expect(page.locator('.scope-picker summary')).toContainText('Corp KR');expect(page.url()).toContain('scope=');
  await expect.poll(async()=>Number(await page.locator('.kpi',{hasText:/^리소스/}).locator('strong').textContent())).toBeLessThan(total);
  for(const name of ['조치 항목','변경 이력','네트워크','노출·방화벽','IAM','비용']){await page.getByRole('button',{name,exact:true}).click();await expect(page.locator('.scope-picker summary')).toContainText('Corp KR');}
  await page.getByRole('button',{name:'토폴로지',exact:true}).click();await settled(page);await expect(page.locator('.map-tab.active')).toContainText('Corp KR');
  await page.getByRole('button',{name:'대시보드',exact:true}).click();await page.getByRole('button',{name:'필터 해제'}).click();
  await expect(page.locator('.scope-picker summary')).toContainText('전체 범위');await page.goBack();await expect(page.locator('.scope-picker summary')).toContainText('Corp KR');
});
test('switching clouds in the bar does not pile up map tabs',async({page})=>{
  await page.goto('/?scenario=standard');const bar=page.getByRole('group',{name:'클라우드 필터'});await bar.waitFor();
  await bar.getByRole('button',{name:'Azure'}).click();await bar.getByRole('button',{name:'AWS'}).click();await bar.getByRole('button',{name:'Google Cloud'}).click();
  await page.getByRole('button',{name:'토폴로지',exact:true}).click();await settled(page);await expect(page.locator('.map-tab')).toHaveCount(2);await expect(page.locator('.map-tab.active')).toContainText('Google Cloud');
});
test('changes page says what it compares and filters by kind',async({page})=>{
  await page.goto('/?scenario=standard&view=changes');await expect(page.locator('.page-head p')).toContainText('그 이전 회차는');
  const all=await page.locator('tbody tr').count();expect(all).toBeGreaterThan(0);
  await page.getByRole('group',{name:'변경 유형 필터'}).getByRole('button',{name:'삭제'}).click();expect(await page.locator('tbody tr').count()).toBeLessThan(all);
});
