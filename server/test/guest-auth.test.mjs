import test from 'node:test';
import assert from 'node:assert/strict';
import {GuestAuth} from '../guest-auth.mjs';
const key='test-only-private-key-0123456789',ip='127.0.0.1';
function setup(options={}){let now=0;return {auth:new GuestAuth({key,now:()=>now,sessionMs:1000,guestMs:10_000,...options}),advance:ms=>now+=ms};}
test('expired login can reauthenticate into the same guest; shared key alone cannot claim that identity',()=>{
  const {auth,advance}=setup(),first=auth.login({key,ip});assert.equal(first.status,200);advance(1001);
  assert.equal(auth.session(first.sessionToken),null);
  const again=auth.login({key,ip,guestToken:first.guestToken});assert.equal(again.playerId,first.playerId);assert.notEqual(again.sessionToken,first.sessionToken);
  const stranger=auth.login({key,ip,playerId:first.playerId});assert.notEqual(stranger.playerId,first.playerId);
  assert.equal(auth.login({key:'incorrect',ip,guestToken:first.guestToken}).status,401);
});
test('logout ends authorization, forget revokes identity and all sessions',()=>{
  const {auth}=setup(),first=auth.login({key,ip});auth.logout(first.sessionToken);
  assert.equal(auth.session(first.sessionToken),null);assert.equal(auth.guest(first.guestToken).playerId,first.playerId);
  const a=auth.login({key,ip,guestToken:first.guestToken}),b=auth.login({key,ip,guestToken:first.guestToken});
  assert.equal(auth.forget(a.sessionToken,first.guestToken),first.playerId);
  assert.equal(auth.session(b.sessionToken),null);assert.equal(auth.guest(first.guestToken),null);
});
test('bounded identity storage retains pinned match records without treating expired credentials as valid',()=>{
  const {auth,advance}=setup({capacity:1}),first=auth.login({key,ip});auth.pin(first.playerId);advance(10_001);auth.sweep();
  assert.equal(auth.byPlayer.has(first.playerId),true);assert.equal(auth.guest(first.guestToken),null);
  assert.equal(auth.login({key,ip}).status,503);auth.unpin(first.playerId);auth.sweep();assert.equal(auth.byPlayer.size,0);
  assert.equal(auth.login({key,ip}).status,200);
});
test('valid session restores a lost guest cookie by rotation and rejects conflicting identities',()=>{
  const {auth}=setup(),a=auth.login({key,ip}),b=auth.login({key,ip});
  assert.equal(auth.login({key,ip,sessionToken:a.sessionToken,guestToken:b.guestToken}).status,409);
  const restored=auth.login({key,ip,sessionToken:a.sessionToken});assert.equal(restored.playerId,a.playerId);
  assert.equal(auth.guest(a.guestToken),null);assert.ok(auth.guest(restored.guestToken));
});
