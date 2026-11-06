import test from 'node:test';
import assert from 'node:assert/strict';
import {azureActivity,collectAwsActivity,gcpActivity} from '../server/collectors.ts';
import {audit,readAudit,resetAuditMemory} from '../server/audit.ts';
import {demoAudit} from '../server/fixtures/audit.ts';
import {mockSnapshot} from '../server/mock.ts';
const NOW=new Date('2026-11-06T00:00:00Z');
test('Azure activity keeps only finished writes, deletes and actions',async()=>{
  const seen:string[]=[];
  const request=(async(url:string)=>{seen.push(url);return new Response(JSON.stringify(url.includes('page2')?{value:[{eventDataId:'3',eventTimestamp:'2026-11-05T01:00:00Z',caller:'sp-ci',operationName:{value:'Microsoft.Network/networkSecurityGroups/securityRules/delete',localizedValue:'Delete rule'},status:{value:'Failed'},resourceId:'/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/networkSecurityGroups/nsg/securityRules/r1'}]}:{nextLink:'https://management.azure.com/page2',value:[
    {eventDataId:'1',eventTimestamp:'2026-11-05T00:00:00Z',caller:'kim@x.com',operationName:{value:'Microsoft.Compute/virtualMachines/write',localizedValue:'Create or Update VM'},status:{value:'Succeeded'},resourceId:'/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1',httpRequest:{clientIpAddress:'1.2.3.4'}},
    {eventDataId:'2',eventTimestamp:'2026-11-05T00:00:00Z',caller:'kim@x.com',operationName:{value:'Microsoft.Compute/virtualMachines/write'},status:{value:'Started'},resourceId:'/x'},
    {eventDataId:'4',eventTimestamp:'2026-11-05T00:00:00Z',caller:'kim@x.com',operationName:{value:'Microsoft.Compute/virtualMachines/read'},status:{value:'Succeeded'},resourceId:'/x'}]}));}) as typeof fetch;
  const rows=await azureActivity(['s'],async()=>'t',request,NOW);
  assert.match(decodeURIComponent(seen[0]),/eventTimestamp ge '2026-10-30/);
  assert.deepEqual(rows.map(r=>[r.targetName,r.kind,r.outcome,r.actorType]),[['vm1','write','ok','user'],['r1','delete','failed','service']]);
  assert.equal(rows[0].ip,'1.2.3.4');assert.equal(rows[0].target,'azure:/subscriptions/s/resourcegroups/rg/providers/microsoft.compute/virtualmachines/vm1');
});
test('CloudTrail activity asks for write events only and reads who did it',async()=>{
  let input:any;
  const rows=await collectAwsActivity(async(_s,_op,i)=>{input=i;return{Events:[{EventId:'e1',EventName:'AuthorizeSecurityGroupIngress',EventTime:new Date('2026-11-05T00:00:00Z'),Resources:[{ResourceName:'sg-1'}],CloudTrailEvent:JSON.stringify({userIdentity:{type:'AssumedRole',arn:'arn:aws:sts::1:assumed-role/Admin/kim'},eventSource:'ec2.amazonaws.com',sourceIPAddress:'5.6.7.8',errorCode:'UnauthorizedOperation'})}]};},'111','ap-northeast-2',NOW);
  assert.deepEqual(input.LookupAttributes,[{AttributeKey:'ReadOnly',AttributeValue:'false'}]);
  assert.deepEqual([rows[0].kind,rows[0].outcome,rows[0].targetName,rows[0].scope,rows[0].ip],['write','failed','sg-1','111','5.6.7.8']);
});
test('GCP activity reads the admin activity log across projects',async()=>{
  let body:any;
  const rows=await gcpActivity(['organizations/1','projects/p1'],async(_u,init)=>{body=init?.data;return{entries:[{insertId:'i',timestamp:'2026-11-05T00:00:00Z',resource:{labels:{project_id:'p1'}},protoPayload:{methodName:'v1.compute.firewalls.delete',serviceName:'compute.googleapis.com',resourceName:'projects/p1/global/firewalls/allow-ssh',authenticationInfo:{principalEmail:'ci@p1.iam.gserviceaccount.com'}}}]};},NOW);
  assert.match(body.filter,/cloudaudit\.googleapis\.com%2Factivity/);assert.deepEqual(body.resourceNames,['organizations/1','projects/p1']);
  assert.deepEqual([rows[0].kind,rows[0].actorType,rows[0].scope,rows[0].targetName],['delete','service','p1','allow-ssh']);
});
test('portal audit keeps one record per repeated view and the demo shows a failed-login burst',async()=>{
  resetAuditMemory();const req={ip:'1.1.1.1',headers:{}} as any;
  await audit(req,{actor:'kim',action:'view',target:'cost'});await audit(req,{actor:'kim',action:'view',target:'cost'});await audit(req,{actor:'kim',action:'login'});
  const events=await readAudit(1);assert.equal(events.filter(e=>e.action==='view').length,1);assert.equal(events.length,2);
  assert.equal(events[0].ip,undefined,'mock mode keeps no addresses');
  assert.ok(demoAudit(NOW).filter(e=>e.action==='login_failed').length>=5);
});
test('mock snapshots carry change records tied to real resources',async()=>{
  const s=await mockSnapshot('standard'),ids=new Set(s.resources.map(r=>r.id));
  assert.ok(s.activity.length>10);assert.ok(s.activity.every(a=>ids.has(a.target)));
});
