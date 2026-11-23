import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const context=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../../site/stream-policy.js',import.meta.url),'utf8'),context);
const step=context.CrawlStreamPolicy.step;
const good={now:10000,fps:60,expectedFps:60,bufferMs:20,loss:0,freezes:0};
const fresh=()=>({level:0,bad:0,good:0,cooldownUntil:0});
test('quality only drops after sustained congestion, with cooldown and bounded levels',()=>{
  const poor={...good,loss:.1};let state=step(fresh(),poor);assert.equal(state.level,0);
  state=step(state,{...poor,now:12000});assert.equal(state.level,1);
  state=step(state,{...poor,now:14000});assert.equal(state.level,1);assert.equal(state.bad,0);
  state=step(state,{...poor,now:22000});state=step(state,{...poor,now:24000});assert.equal(state.level,2);
  for(let i=0;i<20;i++)state=step(state,{...poor,now:40000+i*2000});assert.equal(state.level,2);
});
test('quality restores one step only after 20 stable seconds, transient loss resets recovery',()=>{
  let state={...fresh(),level:2};
  for(let i=0;i<9;i++)state=step(state,{...good,now:10000+i*2000});assert.equal(state.level,2);
  state=step(state,{...good,now:28000,loss:.02});assert.equal(state.good,0);
  for(let i=0;i<10;i++)state=step(state,{...good,now:30000+i*2000});assert.equal(state.level,1);
  assert.ok(state.cooldownUntil>48000);
});
test('30 fps software renderer is not falsely treated as a struggling 60 fps source',()=>{
  let state=fresh();for(let i=0;i<10;i++)state=step(state,{...good,fps:29,expectedFps:30,now:10000+i*2000});assert.equal(state.level,0);
});
