import test from 'node:test';
import assert from 'node:assert/strict';
import { runReminderQueueUntilSettled } from '../../qa-lab/lib/reminder-queue-runner.mjs';

test('the lab cron simulator drains successive bounded batches to reach a member beyond row 1000',async()=>{
  let processed=0,dispatched=0,time=0;
  const answer=await runReminderQueueUntilSettled({
    read:()=>({status:processed>=1105?'sent':'pending'}),
    dispatch:()=>({ok:true,requests:[{id:++dispatched}]}),
    responses:async(ids)=>{processed+=20;time+=100;return ids.map(id=>({id,status_code:200,timed_out:false}));},
    pause:async ms=>{time+=ms;},now:()=>time,
  });
  assert.equal(answer.status,'sent');assert.equal(dispatched,56);
});
test('busy leases wait without manufacturing provider or SQL success',async()=>{
  let time=0,calls=0;
  const result=await runReminderQueueUntilSettled({read:()=>({status:time>=2000?'skipped':'leased'}),dispatch:()=>{calls++;return{ok:true,requests:[]};},responses:()=>assert.fail('no request to read'),pause:async ms=>{time+=ms;},now:()=>time});
  assert.equal(result.status,'skipped');assert.equal(calls,2);
});
test('missing work, failed dispatches, failed HTTP evidence and bounded timeouts cannot pass',async()=>{
  let time=0;
  const base={read:()=>({status:'pending'}),dispatch:()=>({ok:true,requests:[]}),responses:async()=>[],pause:async ms=>{time+=ms;},now:()=>time,timeoutMs:1500};
  await assert.rejects(runReminderQueueUntilSettled({...base,read:()=>null}),/did not enqueue/);
  await assert.rejects(runReminderQueueUntilSettled({...base,dispatch:()=>({ok:false,error:'synthetic'})}),/drain failed/);
  await assert.rejects(runReminderQueueUntilSettled({...base,dispatch:()=>({ok:true,requests:[{id:1}]})}),/did not answer/);
  await assert.rejects(runReminderQueueUntilSettled(base),/did not settle/);
  assert.equal(time,1500);
});

test('timeout names the persisted delivery failure without leaking message or lease data',async()=>{
  let time=0;
  const row={status:'pending',attempts:3,last_error:'queue_unavailable',email:'private@example.test',payload:{text:'private message'},lease_token:'private lease'};
  const args={read:()=>row,dispatch:()=>({ok:true,requests:[]}),responses:()=>assert.fail('no request'),pause:async ms=>{time+=ms;},now:()=>time,timeoutMs:1000};
  await assert.rejects(runReminderQueueUntilSettled(args),error=>{
    assert.match(error.message,/status=pending, attempts=3, last_error=queue_unavailable/);
    assert.doesNotMatch(error.message,/private|example|payload|lease/);return true;
  });
  time=0;row.last_error='provider echoed private@example.test';
  await assert.rejects(runReminderQueueUntilSettled(args),error=>{
    assert.match(error.message,/last_error=unclassified/);assert.doesNotMatch(error.message,/private|example/);return true;
  });
});
