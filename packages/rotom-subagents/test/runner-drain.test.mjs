import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunnerDrain} from '../src/runs/background/runner-drain.ts';

test('fault drain stops live handles and waits for actual close, fencing new writers',async()=>{
 const drain=createRunnerDrain(),stops=[];
 const closeA=drain.track(()=>stops.push('a'));
 const closeB=drain.track(()=>{stops.push('b');throw Error('signal unavailable')});
 let done=false;
 const operation=drain.drain();
 assert.equal(drain.drain(),operation);
 const pending=operation.then(()=>{done=true});
 assert.deepEqual(stops,['a','b']);
 assert.throws(()=>drain.assertOpen(),/draining/);
 assert.throws(()=>drain.track(()=>{}),/draining/);
 closeA(); await Promise.resolve(); assert.equal(done,false);
 closeB(); await pending; assert.equal(done,true);
});
test('already observed children are not signaled during fault teardown',async()=>{
 const drain=createRunnerDrain();
 const closed=drain.track(()=>assert.fail('closed handle replayed'));
 closed();closed();await drain.drain();
});
