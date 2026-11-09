import {expect,test,type Page} from '@playwright/test';
import {validateSnapshot,type CostRow} from '../shared/schema';
import type {Fx} from '../shared/cost';

const cost=(currency:string,amount:number):CostRow=>({provider:'aws',scope:'allowed',service:'Compute',month:'2026-10',currency,amount});
async function serveCosts(page:Page,rows:CostRow[],fx?:Fx){
  await page.addInitScript(()=>{localStorage.setItem('atlas.guide.seen','1');localStorage.removeItem('atlas.fx.usdkrw');localStorage.setItem('atlas.cost.currency','KRW');});
  await page.route('https://fonts.g*/**',route=>route.abort());
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-09T00:00:00Z',resources:[],links:[],warnings:[],scopes:['allowed'],cost:rows,fx,costCoverage:[{provider:'aws',state:'complete',failedScopes:[]}]});
  await page.route('**/api/topology*',route=>route.fulfill({json:snapshot}));
}

test('the dashboard identifies excluded currencies and does not call missing conversions zero cost',async({page})=>{
  await serveCosts(page,[cost('USD',10)]);
  await page.goto('/?view=dashboard');
  const kpi=page.locator('.kpi').filter({has:page.locator('.kpi-label',{hasText:'최근 월 비용'})});
  await expect(kpi.locator('strong')).toHaveText('—');
  await expect(page.getByRole('status').filter({hasText:'환율이 없어'})).toContainText('USD 비용 1건');
  await kpi.click();
  await expect(page.locator('.kpi strong').first()).toHaveText('—');
  await page.getByLabel('환율 (1 USD당 원)').fill('1400');
  await expect(page.locator('.kpi strong').first()).toHaveText('₩14,000');
});

test('a USD based server rate displays and converts the reciprocal KRW rate',async({page})=>{
  await serveCosts(page,[cost('USD',10)],{base:'USD',rates:{KRW:1/1400},source:'settings'});
  await page.goto('/?view=cost');
  await expect(page.getByLabel('환율 (1 USD당 원)')).toHaveAttribute('placeholder','1400');
  await expect(page.locator('.kpi strong').first()).toHaveText('₩14,000');
  await page.getByRole('button',{name:'달러 $'}).click();
  await expect(page.locator('.kpi strong').first()).toHaveText('US$10.00');
});

test('an observed zero cost remains zero on the dashboard and cost page',async({page})=>{
  await serveCosts(page,[cost('KRW',0)]);
  await page.goto('/?view=dashboard');
  const kpi=page.locator('.kpi').filter({has:page.locator('.kpi-label',{hasText:'최근 월 비용'})});
  await expect(kpi.locator('strong')).toHaveText('₩0');
  await kpi.click();
  await expect(page.locator('.kpi strong').first()).toHaveText('₩0');
});
