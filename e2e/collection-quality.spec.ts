import {expect,test,type Page} from '@playwright/test';
import type {Snapshot} from '../shared/schema';
const inject=async(page:Page,change:(snapshot:Snapshot)=>void)=>{
  await page.route('**/api/topology?*',async route=>{
    const response=await route.fetch(),snapshot=await response.json() as Snapshot;
    change(snapshot);await route.fulfill({response,json:snapshot});
  });
};
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('atlas.guide.seen','1'));
  await page.route('https://fonts.g*/**',r=>r.abort());
});
test('partial costs stay visible beside the total and on the dashboard',async({page})=>{
  await inject(page,s=>{s.costCoverage=[{provider:'azure',state:'partial',failedScopes:['fake-subscription']}];});
  await page.goto('/?view=cost');
  await expect(page.getByRole('status').filter({hasText:'비용 일부 누락'})).toContainText('1개 범위 조회 실패');
  await expect(page.locator('.kpi-row')).toContainText('일부 누락');
  await page.getByRole('button',{name:'대시보드',exact:true}).click();
  await expect(page.locator('.kpi-row')).toContainText('일부 누락 · 비용 수집 확인');
});
test('a cost failure with no rows is shown as unread, with recovery guidance',async({page})=>{
  await inject(page,s=>{s.cost=[];s.costCoverage=[{provider:'aws',state:'failed',failedScopes:['111111111111']}];});
  await page.goto('/?view=cost');
  await expect(page.getByText('이 범위의 비용 수집을 완료하지 못했습니다.')).toBeVisible();
  await expect(page.getByRole('status').filter({hasText:'비용 일부 누락'})).toContainText('조회 권한을 확인');
  await expect(page.locator('.kpi-row')).toHaveCount(0);
});
test('auxiliary configuration stays available behind an explicit inventory filter',async({page})=>{
  await inject(page,s=>{const r=s.resources[0];s.resources.push({...r,id:'fake-extension',name:'quality-test-extension',kind:'configuration',type:'Microsoft.Compute/virtualMachines/extensions',auxiliary:true,parent:undefined});});
  await page.goto('/?view=inventory');
  await expect(page.getByRole('heading',{name:'리소스',exact:true})).toBeVisible();
  await expect(page.getByText('quality-test-extension',{exact:true})).toHaveCount(0);
  await page.getByRole('checkbox',{name:'구성 부속물 포함'}).check();
  await page.getByRole('tab',{name:/구성 관리/}).click();
  await expect(page.getByText('quality-test-extension',{exact:true})).toBeVisible();
});
test('network is the default map layer and a workload search reveals its node',async({page})=>{
  await page.goto('/?scenario=standard&view=map');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await expect(page.getByRole('button',{name:'워크로드',exact:true})).toHaveAttribute('aria-pressed','false');
  await expect(page.locator('.rc.kind-compute')).toHaveCount(0);
  await page.getByLabel('리소스와 범위 검색').fill('api-prod-01');await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'워크로드',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.rc',{hasText:'api-prod-01'})).toBeVisible();
});
test('an empty AWS map explains the denied API instead of implying no resources exist',async({page})=>{
  await inject(page,s=>{
    s.resources=[];s.links=[];s.collectionGaps=[{provider:'aws',scope:'111111111111',region:'fake-region',operation:'DescribeVpcs',reason:'denied',code:'AccessDenied'}];
    s.incomplete=['111111111111'];s.scopes=['111111111111'];
  });
  await page.goto('/?view=map&scope=provider:aws');
  await expect(page.locator('.canvas-empty')).toContainText('권한이 없어');
  await page.getByText('조회하지 못한 API 1건 · 사유 보기').click();
  await expect(page.locator('.collection-notice')).toContainText('DescribeVpcs: 권한 없음');
  await expect(page.getByRole('button',{name:'연결 방법 보기'})).toBeVisible();
});
