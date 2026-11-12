import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {mockSnapshot} from '../server/mock.js';
import {DEFAULT_SCENARIO} from '../shared/scenarios.js';
import {projectSnapshot} from '../shared/presentation.js';
import {health} from '../shared/topology.js';

test('default demo represents a large governed organization with genuine normalized relationships',async()=>{
  const s=await mockSnapshot();
  assert.equal(s.mode,'mock');assert.equal(s.scenario,DEFAULT_SCENARIO);
  assert.ok(s.scopes.length>=200);assert.ok(s.resources.length>=4500);
  assert.ok(s.activity.length>=5000);assert.ok(s.iam.length>=600);assert.ok(s.cost.length>=7000);
  for(const provider of ['azure','aws','gcp']){
    const rows=s.resources.filter(r=>r.provider===provider&&r.kind!=='external');
    const scopes=new Set(rows.map(r=>r.scope));
    assert.ok(scopes.size>=60,provider);
    assert.ok(new Set(rows.filter(r=>r.kind==='compute').map(r=>r.region)).size>=3,provider);
    assert.ok(rows.some(r=>health(r.status)==='stopped'),provider);
    assert.ok(s.iam.some(a=>a.provider===provider),provider);
    assert.ok(s.cost.some(c=>c.provider===provider),provider);
    const byId=new Map(rows.map(r=>[r.id,r]));
    assert.ok(rows.some(r=>r.kind==='compute'&&r.parent&&byId.get(r.parent)?.kind==='subnet'),`${provider}: concrete subnet placement`);
  }
  assert.ok(s.resources.some(r=>r.provider==='gcp'&&r.kind==='compute'&&r.parent&&s.resources.find(p=>p.id===r.parent)?.scope!==r.scope),'shared VPC service projects');
  const ids=new Set(s.resources.map(r=>r.id));
  assert.ok(s.activity.every(a=>!a.target||ids.has(a.target)));
  assert.ok(s.links.some(l=>l.kind==='peering'));
  // Browser requests accept gzip; retain headroom below the function response limit.
  for(const part of ['dashboard','map','full'])assert.ok(gzipSync(JSON.stringify(projectSnapshot(s,part))).length<3_000_000,part);
});
