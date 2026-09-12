// Test-only observation of direct async spawn stdio closure, not whole-graph death.
import cp from 'node:child_process';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
export function observeSpawnClosure() {
 const original=cp.spawn;const pending=new Set();const events=new EventEmitter();let count=0;
 const wrapped=(...args)=>{
  const child=original(...args);pending.add(child);count++;
  child.once('close',()=>{pending.delete(child);events.emit('change');});
  return child;
 };
 cp.spawn=wrapped;syncBuiltinESMExports();
 return {
  get count(){return count;},get pending(){return pending.size;},
  wait(timeoutMs=10000){
   if(!pending.size)return Promise.resolve(true);
   return new Promise(resolve=>{
    const done=value=>{clearTimeout(timer);events.off('change',changed);resolve(value);};
    const changed=()=>{if(!pending.size)done(true);};
    const timer=setTimeout(()=>done(false),timeoutMs);events.on('change',changed);changed();
   });
  },
  restore(){if(cp.spawn===wrapped){cp.spawn=original;syncBuiltinESMExports();}},
 };
}
