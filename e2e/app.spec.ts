import {expect,test,type Page} from '@playwright/test';
const settled=async(page:Page)=>{await page.waitForSelector('.react-flow__node');await expect(page.locator('.tool-busy')).toHaveCount(0);await page.waitForTimeout(500);};
const openMap=async(page:Page,scenario='standard',extra='')=>{await page.goto(`/?scenario=${scenario}&view=map${extra}`);await settled(page);};
const search=(page:Page)=>page.getByLabel('리소스와 범위 검색');
// External fonts are not under test, and their network timing must not decide whether the suite passes.
test.beforeEach(async({page})=>{page.on('pageerror',e=>{throw e;});await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://fonts.gstatic.com/**',r=>r.abort());});
test('home shows all three org hierarchies and opens a scope as a tab',async({page})=>{
  await page.goto('/?scenario=enterprise');
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
  await page.goto('/?scenario=standard',{waitUntil:'commit'});await expect(page.locator('.scope-tree').first()).toBeVisible({timeout:5_000});
});
test('official icons all load under the CSP',async({page})=>{
  await openMap(page);
  expect(await page.locator('img').evaluateAll(imgs=>imgs.filter(i=>!(i as HTMLImageElement).naturalWidth).length)).toBe(0);
});
test('a slow earlier scenario cannot overwrite the current one',async({page})=>{
  await page.route('**/api/topology?scenario=enterprise',async r=>{await new Promise(s=>setTimeout(s,800));await r.continue().catch(()=>{});});
  await page.goto('/?scenario=standard');await page.waitForSelector('.scope-tree');
  const pick=page.getByLabel('예시 아키텍처');await pick.selectOption('enterprise');await pick.selectOption('single-vm');await page.waitForTimeout(1300);
  await expect(page.locator('.home-stats dd').nth(1)).toHaveText('5');
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
  await page.goto('/?scenario=standard');await page.locator('.attention-rail .relation-row',{hasText:'sg-alb'}).click();await settled(page);
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
  const page=await (await browser.newContext({viewport:{width:390,height:844}})).newPage();await page.goto('/?scenario=standard');await page.waitForSelector('.scope-tree');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
