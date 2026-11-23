import test from 'node:test';
import assert from 'node:assert/strict';
import {Auth} from '../auth.mjs';
const key='private-test-key-0123456789';
test('keys are verified server-side and cookies are opaque, expiring and revocable',()=>{
  let now=10000;const auth=new Auth({key,now:()=>now,sessionMs:1000});
  assert.equal(auth.authenticate('incorrect','one').status,401);
  assert.equal(auth.authenticate({},'one').status,401);
  const result=auth.authenticate(key,'one');assert.equal(result.status,200);
  assert.equal(auth.authenticate(key,'one',result.token).session.id,result.session.id);
  assert.ok(auth.get(result.token));assert.equal(auth.get(key),null);
  assert.equal(auth.cookieToken('other=x; crawl_session='+result.token),result.token);
  auth.revoke(result.token);assert.equal(auth.get(result.token),null);
  const next=auth.authenticate(key,'two');now+=1001;assert.equal(auth.get(next.token),null);
});
test('failed-key attempts are rate limited without locking out other addresses',()=>{
  let now=0;const auth=new Auth({key,now:()=>now,maxFailures:2,windowMs:100});
  assert.equal(auth.authenticate('wrong','one').status,401);assert.equal(auth.authenticate('wrong','one').status,401);
  assert.equal(auth.authenticate(key,'one').status,429);assert.equal(auth.authenticate(key,'two').status,200);
  now=101;assert.equal(auth.authenticate(key,'one').status,200);
});
