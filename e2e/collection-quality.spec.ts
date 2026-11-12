import {expect,test,type Page} from '@playwright/test';
import {validateSnapshot,type Snapshot} from '../shared/schema';
const fakeLiveSnapshot=()=>validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-10T00:00:00Z',resources:[],links:[],warnings:[],scopes:['111111111111'],cost:[{provider:'aws',scope:'111111111111',service:'fake-compute',month:'2026-11',amount:10,currency:'USD'}]});
const inject=async(page:Page,change:(snapshot:Snapshot)=>void)=>{
  await page.route('**/api/topology?*',async route=>{
    // This helper edits a complete fixture. Transport reuse is tested separately;
    // request a full body so a previous core cannot hide the fixture mutation.
    const url=new URL(route.request().url());url.searchParams.delete('transport');url.searchParams.delete('base');
    const response=await route.fetch({url:url.href}),snapshot=await response.json() as Snapshot;
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

test('organization billing failures explain their cause without counting each member account',async({page})=>{
  let reason:'denied'|'throttled'|'network'|'skipped-timeout'='denied';
  await inject(page,s=>{s.cost=[];s.costCoverage=[{provider:'aws',state:'failed',unit:'organization',reason,failedScopes:[]}];});
  for(const [value,label] of [['denied','ce:GetCostAndUsage'],['throttled','속도 제한'],['network','프록시·DNS·인증서'],['skipped-timeout','전체 수집 시간 초과']] as const){
    reason=value;await page.goto('/?view=cost&scope=provider:aws');
    const notice=page.getByRole('status').filter({hasText:'비용 일부 누락'});
    await expect(notice).toContainText('조직 단위 비용 조회 1건');await expect(notice).toContainText(label);
    await expect(notice).not.toContainText('개 범위');
  }
});

test('legacy cached cost is labeled unverified until coverage exists',async({page})=>{
  await page.route('**/api/topology*',route=>route.fulfill({json:fakeLiveSnapshot()}));
  await page.goto('/?view=cost');
  await expect(page.getByRole('status').filter({hasText:'비용 일부 누락'})).toContainText('완전성 검증 안 됨');
  await expect(page.locator('.kpi-row')).toContainText('일부 누락');
});

test('unknown VM capacity distinguishes permission errors, unknown sizes and fallback values',async({page})=>{
  await inject(page,s=>{
    const base=s.resources.find(r=>r.kind==='compute')!;
    for(const [id,lookup,cause,vcpu] of [['denied','조회 실패: 권한 또는 API 설정 확인','조회 실패: 권한 또는 API 설정 확인','미확인'],['unknown','알 수 없는 크기','알 수 없는 크기','미확인'],['fallback','내장표 폴백','조회 실패: 속도 제한','2']]){
      s.resources.push({...base,id:`fake-size-${id}`,name:`fake-size-${id}`,parent:undefined,status:'running',specs:{'인스턴스':'fake-size','vCPU':vcpu,'메모리':vcpu==='2'?'4 GiB':'미확인','크기 조회':lookup,'크기 조회 사유':cause}});
    }
  });
  await page.goto('/?view=inventory');
  const notice=page.getByRole('status').filter({hasText:'VM 용량 확인 필요'});
  await expect(notice).toContainText('권한 또는 API 설정 확인 1대');
  await expect(notice).toContainText('알 수 없는 크기 1대');
  await expect(notice).toContainText('내장표 폴백 (조회 실패: 속도 제한) 1대');
  await page.screenshot({path:'/tmp/atlas-issue4-size.png'});
});

test('security group rules use the shared auxiliary classification and remain inspectable',async({page})=>{
  await inject(page,s=>{const base=s.resources.find(r=>r.provider==='aws')!;s.resources.push({...base,id:'fake-sg-rule',name:'fake-sg-child-rule',kind:'security',type:'ec2:security-group-rule',parent:undefined,auxiliary:undefined});});
  await page.goto('/?view=inventory');
  await expect(page.getByText('fake-sg-child-rule',{exact:true})).toHaveCount(0);
  await page.getByRole('checkbox',{name:'구성 부속물 포함'}).check();
  await page.getByRole('tab',{name:/보안·정책/}).click();
  await expect(page.getByText('fake-sg-child-rule',{exact:true})).toBeVisible();
});

test('collection status shows account continuation and slow stages after a bounded run',async({page})=>{
  await page.route('**/api/topology*',route=>route.fulfill({json:fakeLiveSnapshot()}));
  await page.route('**/api/collect/status',route=>route.fulfill({json:{enabled:true,running:false,finishedAt:'2026-11-10T00:00:00Z',providers:{azure:{state:'idle'},gcp:{state:'idle'},aws:{state:'partial',resources:1,message:'수집 시간 초과 · 완료 1 / 전체 3계정. 다음 수집에서 미수집·오래된 계정부터 이어서 진행합니다.',slowStages:[{id:'resources',detail:'가짜 계정 · 나머지 서비스 목록',elapsedMs:12000}]}}}}));
  await page.goto('/?view=scopes');await page.getByLabel('수집 상태 보기',{exact:true}).click();
  const pop=page.locator('.collect-pop');await expect(pop).toContainText('완료 1 / 전체 3계정');
  await pop.getByText('느린 수집 구간 상위 1개').click();await expect(pop).toContainText('나머지 서비스 목록 · 12초');
  await page.screenshot({path:'/tmp/atlas-issue4-status.png'});
});
