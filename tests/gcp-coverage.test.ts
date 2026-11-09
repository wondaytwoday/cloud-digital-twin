import test from 'node:test';
import assert from 'node:assert/strict';
import {collectGcpAuto,collectGcpWith,type GcpRequest} from '../server/collectors.ts';
import {toSnapshot} from '../server/runner.ts';
import {retainIncomplete} from '../server/reconcile.ts';

const options={withActivity:false,withCost:false};
const network=(project:string)=>({name:`//compute.googleapis.com/projects/${project}/global/networks/n`,assetType:'compute.googleapis.com/Network',resource:{location:'global',data:{name:`${project}-network`}}});
const projectAsset=(project:string)=>({name:`//cloudresourcemanager.googleapis.com/projects/${project}`,assetType:'cloudresourcemanager.googleapis.com/Project',resource:{data:{projectId:project,projectNumber:project==='p1'?'1':'2',name:project}}});

test('GCP still reads projects outside successful organizations and falls back for failed organizations',async()=>{
  const projectReads:string[]=[];
  const request:GcpRequest=async url=>{
    if(url.includes('organizations:search'))return{organizations:[{name:'organizations/1'},{name:'organizations/2'}]};
    if(url.includes('/v1/projects?'))return{projects:['p1','p2','standalone'].map(projectId=>({projectId}))};
    if(url.includes('/assets?')){
      const u=new URL(url),types=u.searchParams.getAll('assetTypes');
      if(url.includes('/organizations/2/'))throw new Error('403 denied');
      if(url.includes('/organizations/1/'))return{assets:types.length?[projectAsset('p1')]:[network('p1')]};
      const project=url.match(/\/projects\/([^/]+)\/assets/)?.[1]!;
      if(!types.length)projectReads.push(project);
      return{assets:types.length?[]:[network(project)]};
    }
    return{};
  };
  const result=await collectGcpAuto(request,options);
  assert.deepEqual(projectReads.sort(),['p2','standalone']);
  assert.deepEqual(result.resources.map(r=>r.scope).sort(),['p1','p2','standalone']);
  assert.deepEqual(result.collectedScopes?.sort(),['p1','p2','standalone']);
  assert.deepEqual(result.incomplete,[]);
});

test('a failed project fallback is incomplete even when another organization succeeded',async()=>{
  const request:GcpRequest=async url=>{
    if(url.includes('organizations:search'))return{organizations:[{name:'organizations/1'},{name:'organizations/2'}]};
    if(url.includes('/v1/projects?'))return{projects:['p1','p2'].map(projectId=>({projectId}))};
    if(url.includes('/organizations/2/')||url.includes('/projects/p2/assets'))throw new Error('403 denied');
    if(url.includes('/organizations/1/assets?'))return{assets:new URL(url).searchParams.has('assetTypes')?[projectAsset('p1')]:[network('p1')]};
    return{};
  };
  const result=await collectGcpAuto(request,options);
  assert.deepEqual(result.resources.map(r=>r.scope),['p1']);
  assert.deepEqual(result.incomplete,['p2']);
  assert.deepEqual(result.collectedScopes,['p1']);
});

test('an empty GCP project remains a successfully collected scope and hierarchy leaf',async()=>{
  const request:GcpRequest=async url=>url.includes('organizations:search')?{organizations:[]}:url.includes('/v1/projects?')?{projects:[{projectId:'empty',name:'Empty project'}]}:{assets:[]};
  const result=await collectGcpAuto(request,options),snapshot=toSnapshot(result);
  assert.deepEqual(result.resources,[]);
  assert.deepEqual(snapshot.scopes,['empty']);
  assert.deepEqual(snapshot.incomplete,[]);
  assert.equal(snapshot.hierarchy.find(n=>n.scope==='empty')?.name,'Empty project');
  assert.deepEqual((await collectGcpWith('projects/direct-empty',async()=>({assets:[]}),options)).collectedScopes,['direct-empty']);
});

test('empty projects listed by a successful organization need no redundant project read',async()=>{
  const projectReads:string[]=[];
  const result=await collectGcpAuto(async url=>{
    if(url.includes('organizations:search'))return{organizations:[{name:'organizations/1'}]};
    if(url.includes('/v1/projects?'))return{projects:[{projectId:'empty'}]};
    if(url.includes('/projects/empty/assets'))projectReads.push(url);
    if(url.includes('/assets?')&&new URL(url).searchParams.has('assetTypes'))return{assets:[projectAsset('empty')]};
    return{assets:[]};
  },options);
  assert.deepEqual(result.collectedScopes,['empty']);
  assert.deepEqual(toSnapshot(result).scopes,['empty']);
  assert.deepEqual(projectReads,[]);
});

test('GCP IAM read failures preserve project, folder, and organization assignments independently of assets',async()=>{
  const hierarchy=[
    {assetType:'cloudresourcemanager.googleapis.com/Organization',resource:{data:{name:'organizations/1',displayName:'example.test'}}},
    {assetType:'cloudresourcemanager.googleapis.com/Folder',resource:{data:{name:'folders/10',parent:'organizations/1',displayName:'Folder'}}},
    projectAsset('p1'),
  ];
  const request:GcpRequest=async url=>{
    const query=new URL(url).searchParams;
    if(query.get('contentType')==='IAM_POLICY')throw new Error('403 denied');
    return{assets:query.has('assetTypes')?hierarchy:[network('p1')]};
  };
  const result=await collectGcpWith('organizations/1',request,options);
  assert.deepEqual(new Set(result.iamIncomplete),new Set(['p1','10','1']));
  const previous=toSnapshot({...result,iam:['p1','10','1'].map((scope,index)=>({
    id:`gcp:assignment:${scope}`,provider:'gcp',principal:'reader@example.test',principalType:'user',role:'roles/viewer',scope,level:index===0?'scope':index===1?'group':'org',privileged:false,external:false,source:'Cloud Asset Inventory · IAM_POLICY',
  }))});
  const merged=retainIncomplete(result,previous);
  assert.equal(merged.resources.length,1);
  assert.deepEqual(merged.iam?.map(a=>a.scope),['p1','10','1']);
  assert.ok(merged.iam?.every(a=>a.source.includes('이전 수집')));
  const complete=await collectGcpWith('organizations/1',async url=>new URL(url).searchParams.get('contentType')==='IAM_POLICY'?{assets:[]}:request(url),options);
  assert.deepEqual(retainIncomplete(complete,previous).iam,[]);
});
