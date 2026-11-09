import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import {fetchRetry} from '../server/async.ts';
import {azurePages} from '../server/collectors.ts';

test('HTTP retry delays do not expire the next request timeout',async()=>{
  const signals:AbortSignal[]=[];
  const request=(async(_url,init)=>{
    const signal=init?.signal!;signal.throwIfAborted();signals.push(signal);
    return new Response('{}',{status:signals.length===1?429:200});
  }) as typeof fetch;
  const response=await fetchRetry('https://example.invalid',{},request,{timeoutMs:20,wait:async()=>{await pause(40);}});
  assert.equal(response.status,200);
  assert.equal(signals.length,2);
  assert.equal(signals[0].aborted,true);
  assert.notEqual(signals[0],signals[1]);
  assert.equal(signals[1].aborted,false);
});

test('per-attempt HTTP timeouts still abort a stalled request',async()=>{
  let calls=0;
  const request=(async(_url,init)=>{calls++;await pause(40);init?.signal?.throwIfAborted();return new Response('{}');}) as typeof fetch;
  await assert.rejects(fetchRetry('https://example.invalid',{},request,{timeoutMs:20}),{name:'TimeoutError'});
  assert.equal(calls,1);
});

test('Azure Resource Graph retries stop when the collection is cancelled during a wait',async()=>{
  const controller=new AbortController();let calls=0;
  const request=(async()=>{calls++;return new Response('{}',{status:429});}) as typeof fetch;
  await assert.rejects(azurePages(['a'],async()=>'fake',request,undefined,undefined,{signal:controller.signal,wait:async()=>{controller.abort();}}));
  assert.equal(calls,1);
});
