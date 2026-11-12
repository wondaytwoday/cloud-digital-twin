import {test,expect} from '@playwright/test';

test('large default demo opens, searches across projects, and renders a scoped map',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('atlas.guide.seen','1'));
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.route('https://fonts.gstatic.com/**',r=>r.abort());
  await page.goto('/?view=scopes');
  await expect(page.getByLabel('예시 아키텍처')).toHaveValue('global-scale');
  for(const name of ['Microsoft Azure','Amazon Web Services','Google Cloud'])await expect(page.getByRole('heading',{name})).toBeVisible();
  const search=page.getByLabel('리소스와 범위 검색');
  await search.fill('retail-us-prod-gce-18');
  await expect(page.getByRole('button',{name:/retail-us-prod-gce-18/}).first()).toBeVisible();
  await page.goto('/?scenario=global-scale&view=map&scope='+encodeURIComponent('aws:scope:300000000036'));
  await expect(page.locator('.react-flow__node').first()).toBeVisible({timeout:20_000});
  await expect(page.locator('.tool-busy')).toHaveCount(0);
  await expect(page.locator('.map-tab.active')).toContainText('retail 미국 prod');
  await page.getByRole('button',{name:'워크로드',exact:true}).click();
  await expect(page.locator('.react-flow__node').filter({hasText:'VM · 18개'})).toBeVisible();
  await expect(page.getByText('목데이터',{exact:true})).toBeVisible();
  expect(await page.locator('.react-flow__node').count()).toBeLessThan(100);
  await page.screenshot({path:'/tmp/atlas-global-scale-map.png',fullPage:true});
  expect(errors).toEqual([]);
});
