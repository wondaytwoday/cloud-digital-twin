import test from 'node:test';
import assert from 'node:assert/strict';
import {convertTo,parseFx} from '../shared/cost.ts';
import {resolveCostFx} from '../shared/currency.ts';
import {restrictSnapshot} from '../server/auth.ts';
import {costIssues} from '../shared/collectionView.ts';
import {ALL_FOCUS} from '../shared/hierarchy.ts';
import {validateSnapshot,type CostRow} from '../shared/schema.ts';

const row=(currency:string,amount=1):CostRow=>({provider:'aws',scope:'allowed',service:'Compute',month:'2026-10',currency,amount});
const near=(actual:number|undefined,expected:number)=>assert.ok(actual!==undefined&&Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);

test('display FX derives the USD/KRW ratio from either base currency',()=>{
  const krw=resolveCostFx({base:'KRW',rates:{USD:1400},source:'settings'},'');
  const usd=resolveCostFx({base:'USD',rates:{KRW:1/1400,EUR:1.1},source:'settings'},'');
  near(krw.rate,1400);near(usd.rate,1400);
  near(convertTo([row('USD',2)],'KRW',usd.fx).rows[0].amount,2800);
  near(convertTo([row('KRW',2800)],'USD',usd.fx).rows[0].amount,2);
  near(convertTo([row('EUR')],'KRW',usd.fx).rows[0].amount,1540);
});

test('display FX preserves a third base and existing conversions without a USD/KRW bridge',()=>{
  const euro={base:'EUR',rates:{USD:.9,KRW:.9/1400,JPY:.006},source:'settings'};
  const resolved=resolveCostFx(euro,'');
  near(resolved.rate,1400);assert.equal(resolved.fx?.base,'EUR');
  near(convertTo([row('EUR')],'KRW',resolved.fx).rows[0].amount,1400/.9);
  near(convertTo([row('JPY')],'USD',resolved.fx).rows[0].amount,.006/.9);
  const usdOnly=resolveCostFx({base:'USD',rates:{EUR:1.1},source:'settings'},'');
  assert.equal(usdOnly.rate,undefined);
  near(convertTo([row('EUR',100)],'USD',usdOnly.fx).rows[0].amount,110);
  assert.equal(convertTo([row('EUR')],'KRW',usdOnly.fx).rows.length,0);
});

test('a typed USD/KRW rate keeps other rates in their configured base',()=>{
  const krw=resolveCostFx({base:'KRW',rates:{USD:1400,EUR:1500},source:'settings'},'1600');
  near(convertTo([row('USD')],'KRW',krw.fx).rows[0].amount,1600);
  near(convertTo([row('EUR')],'KRW',krw.fx).rows[0].amount,1500);
  const usd=resolveCostFx({base:'USD',rates:{KRW:1/1400,EUR:1.1},source:'settings'},'1600');
  near(convertTo([row('USD')],'KRW',usd.fx).rows[0].amount,1600);
  near(convertTo([row('EUR')],'KRW',usd.fx).rows[0].amount,1760);
  const euro=resolveCostFx({base:'EUR',rates:{USD:.9},source:'settings'},'1600');
  near(convertTo([row('USD')],'KRW',euro.fx).rows[0].amount,1600);
  near(convertTo([row('EUR')],'KRW',euro.fx).rows[0].amount,1600/.9);
  assert.equal(euro.source,'직접 입력');
});

test('invalid and infinite rates never replace valid settings or enter parsed FX',()=>{
  const server={base:'KRW',rates:{USD:1400,EUR:Infinity},source:'settings'};
  for(const typed of ['Infinity','1e999','NaN','-3','0','']){
    const resolved=resolveCostFx(server,typed);
    assert.equal(resolved.rate,1400);assert.equal(resolved.fx?.rates.EUR,undefined);
  }
  assert.equal(parseFx({ATLAS_FX_RATES:'USD=Infinity'}),undefined);
  assert.deepEqual(parseFx({ATLAS_FX_RATES:'USD=1400,EUR=1e999'})?.rates,{USD:1400});
  assert.equal(resolveCostFx(undefined,'').fx,undefined,'live has no assumed exchange rate');
  const demo=resolveCostFx(undefined,'',1380);
  assert.equal(demo.rate,1380);assert.equal(demo.source,'예시 환율');
});

test('restricted empty scopes keep their cost failures without leaking other scopes',()=>{
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-09T00:00:00Z',resources:[],links:[],warnings:[],scopes:['allowed','secret'],costCoverage:[
    {provider:'aws',state:'failed',failedScopes:['allowed','secret']},
    {provider:'azure',state:'partial',failedScopes:['secret']},
  ]});
  const restricted=restrictSnapshot(snapshot,['allowed']);
  assert.deepEqual(restricted.costCoverage,[{provider:'aws',state:'failed',failedScopes:['allowed']}]);
  assert.equal(costIssues(restricted,ALL_FOCUS).length,1);
  assert.ok(!JSON.stringify(restricted).includes('secret'));
  assert.deepEqual(snapshot.costCoverage[0].failedScopes,['allowed','secret'],'source is unchanged');
});

test('restricted empty scopes retain unconfigured costs when their hierarchy identifies the provider',()=>{
  const snapshot=validateSnapshot({version:1,mode:'live',collectedAt:'2026-11-09T00:00:00Z',resources:[],links:[],warnings:[],scopes:['allowed'],hierarchy:[
    {id:'gcp:allowed',nativeId:'allowed',name:'Allowed',provider:'gcp',kind:'project',scope:'allowed'},
  ],costCoverage:[{provider:'gcp',state:'unconfigured',failedScopes:[]}]});
  assert.deepEqual(restrictSnapshot(snapshot,['allowed']).costCoverage,snapshot.costCoverage);
});
