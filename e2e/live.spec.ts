import {expect,test} from '@playwright/test';
test.use({baseURL:'http://127.0.0.1:4398'});
// These share one server, and the second test starts a real run that the first must not observe.
test.describe.configure({mode:'serial'});
test('with no setup beyond login, the portal collects and fills itself in',async({page})=>{
  await page.route('https://fonts.g*/**',r=>r.abort());
  await page.goto('/?view=scopes');
  await expect(page.getByRole('heading',{name:'Microsoft Azure'})).toBeVisible({timeout:20_000});
  await expect(page.locator('.cloud-card.azure .badge')).toHaveText('수집됨');
  await expect(page.locator('.cloud-card.aws .badge')).toHaveText('일부 누락');
  await expect(page.locator('.cloud-card.gcp .badge')).toHaveText('로그인 필요');
  await expect(page.locator('.cloud-card.gcp .code-box')).toContainText('gcloud auth application-default login');
  await expect(page.locator('.mode-pill')).toHaveText('실제 수집 스냅샷');
  await expect(page.getByLabel('예시 아키텍처')).toHaveCount(0);
  await expect(page.locator('.onprem-note')).toBeVisible();
  await page.locator('.scope-open',{hasText:'Shop Prod'}).click();await page.waitForSelector('.react-flow__node');
  await page.getByRole('button',{name:'워크로드',exact:true}).click();
  await page.getByRole('button',{name:/^VM · \d+개 펼치기$/}).click();
  await expect(page.locator('.rc',{hasText:'shop-web-01'})).toBeVisible();
});
test('collection cannot be triggered cross-site or from mock mode',async({request})=>{
  expect((await request.post('/api/collect')).status()).toBe(403);
  expect((await request.post('/api/collect',{headers:{'X-Atlas-Request':'1'}})).status()).toBe(202);
  expect((await request.post('http://127.0.0.1:4399/api/collect',{headers:{'X-Atlas-Request':'1'}})).status()).toBe(409);
});
test('a run shows what is being read and why a cloud was skipped',async({page})=>{
  await page.route('https://fonts.g*/**',r=>r.abort());await page.goto('/?view=scopes');
  await expect(page.locator('.cloud-card.gcp .cloud-note')).toContainText('GOOGLE_APPLICATION_CREDENTIALS');
  await page.locator('.collect-menu > summary').click();const pop=page.locator('.collect-pop');await expect(pop).toContainText('로그인 필요');
  await pop.getByRole('button',{name:'지금 수집'}).click();
  await expect(pop.getByRole('progressbar',{name:'전체 수집 진행률'})).toBeVisible();await expect(pop.locator('section',{hasText:'Microsoft Azure'}).locator('.collect-stage.is-running')).toContainText('자원 1,000개 읽음');
  await expect(page.locator('.collect-menu > summary')).toContainText('수집 중');
  await expect(pop.getByRole('button',{name:'지금 수집'})).toBeEnabled({timeout:15_000});await expect(page.locator('.toast')).toContainText('수집 완료');
  await expect(pop.locator('section',{hasText:'Amazon Web Services'})).toContainText('일부 누락');await expect(pop.locator('section',{hasText:'Amazon Web Services'}).locator('.collect-stage.is-skipped')).toContainText('비용');
});
