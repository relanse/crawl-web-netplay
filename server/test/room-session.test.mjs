import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomSession} from '../room-session.mjs';
const a='a'.repeat(32),b='b'.repeat(32),c='c'.repeat(32),releaseId='test-v1',contentHash='c'.repeat(64);
function setup(){let now=0;const room=new RoomSession({releaseId,contentHash,now:()=>now});for(const p of [a,b]){room.join(p);room.lobbyConnection(p,true);}return {room,advance:ms=>now+=ms};}
function start(room){for(const p of [a,b])room.ready(p,room.revision,true,releaseId,contentHash);return room.start(a,room.revision,'start-1');}
function running(room){const tx=start(room);for(const p of [a,b])room.gameConnection(tx.matchId,tx.processLeaseId,p,1,true);room.started(tx.matchId,tx.processLeaseId);return tx;}
const code=expected=>error=>error.code===expected;
test('preparing one member preserves others; start retries allocate exactly one immutable roster',()=>{
  const {room}=setup();const revision=room.revision;
  assert.throws(()=>room.ready(a,revision-1,true,releaseId,contentHash),code('ROOM_CHANGED'));
  const tx=start(room);assert.deepEqual(room.start(a,revision,'start-1'),tx);
  assert.throws(()=>room.start(b,room.revision,'other'),code('NOT_IN_LOBBY'));
  assert.equal(room.match.roster.length,2);assert.equal(JSON.stringify(room.snapshot()).includes(tx.processLeaseId),false);
  assert.throws(()=>room.profile(a,room.revision,{nickname:'bad',tag:'AAA',deity:-1}),code('NOT_IN_LOBBY'));
  assert.throws(()=>room.join(c),code('NOT_IN_LOBBY'));
});
test('first load timeout and all-offline timeout have distinct clocks; old process cannot finish a new match',()=>{
  const {room,advance}=setup();const tx=start(room);advance(89_999);assert.equal(room.tick(),null);
  advance(1);assert.equal(room.tick().reason,'LOAD_TIMEOUT');assert.equal(room.phase,'Lobby');
  assert.throws(()=>room.start(a,room.revision,'start-1'),code('START_EXPIRED'));
  for(const p of [a,b])room.ready(p,room.revision,true,releaseId,contentHash);
  const fresh=room.start(a,room.revision,'start-2');assert.notEqual(fresh.matchId,tx.matchId);
  assert.throws(()=>room.ended(tx.matchId,tx.processLeaseId,c),code('STALE_PROCESS'));
});
test('game connection controls offline expiry; stale disconnection cannot remove replacement',()=>{
  const {room,advance}=setup(),tx=running(room),args=[tx.matchId,tx.processLeaseId];
  room.lobbyConnection(a,false);room.lobbyConnection(b,false);advance(180_001);assert.equal(room.tick(),null);
  room.gameConnection(...args,a,2,true);assert.equal(room.gameConnection(...args,a,1,false),false);
  assert.equal(room.member(a).gameConnected,true);
  room.gameConnection(...args,a,2,false);room.gameConnection(...args,b,1,false);
  advance(179_999);assert.equal(room.tick(),null);room.gameConnection(...args,a,3,true);advance(10);assert.equal(room.tick(),null);
  room.gameConnection(...args,a,3,false);advance(180_000);assert.equal(room.tick().reason,'ALL_OFFLINE');
});
test('a newer disconnected epoch clears a missed reconnect without reviving older sockets',()=>{
  const {room,advance}=setup(), tx=running(room), binding=[tx.matchId,tx.processLeaseId];
  assert.equal(room.gameConnection(...binding,a,2,false),true);
  assert.equal(room.members.get(a).connectionEpoch,2);
  assert.equal(room.members.get(a).gameConnected,false);
  assert.throws(()=>room.gameConnection(...binding,a,1,true),code('STALE_CONNECTION'));
  room.gameConnection(...binding,b,1,false);
  advance(180_000);
  assert.equal(room.tick().reason,'ALL_OFFLINE');
});
test('abandon revokes control and reserves the slot until next lobby, result commits once',()=>{
  const {room}=setup(),tx=running(room),args=[tx.matchId,tx.processLeaseId];
  room.abandon(a);assert.equal(room.members.size,2);
  assert.throws(()=>room.join(a),code('MATCH_ABANDONED'));
  assert.equal(room.authorizeTicket({...tx,releaseId,playerId:a,slot:0}),false);
  assert.throws(()=>room.gameConnection(...args,a,2,true),code('MATCH_ABANDONED'));
  assert.equal(room.ended(...args,c),true);assert.equal(room.ended(...args,c),false);
  assert.throws(()=>room.ended(...args,a),code('RESULT_CONFLICT'));room.returnToLobby();assert.equal(room.members.has(a),false);
});
test('loading barrier requires all game connections and aborts when anyone abandons',()=>{
  const {room}=setup(),tx=start(room);assert.throws(()=>room.started(tx.matchId,tx.processLeaseId),code('PLAYERS_NOT_CONNECTED'));
  assert.equal(room.abandon(b).cancelMatch,true);assert.equal(room.phase,'Lobby');assert.equal(room.member(a).ready,false);
});
test('owner departure transfers control and finished rooms can be left and cleaned up',()=>{
  const {room}=setup(),tx=running(room);room.abandon(a);assert.equal(room.ownerId,b);
  room.ended(tx.matchId,tx.processLeaseId,c);assert.equal(room.abandon(b).cancelMatch,false);
  assert.equal(room.abandon(a).cancelMatch,true);assert.equal(room.members.size,0);
  const other=setup(),match=running(other.room);other.room.crashed(match.matchId,match.processLeaseId);
  other.room.abandon(a);assert.equal(other.room.ownerId,b);assert.equal(other.room.abandon(b).cancelMatch,true);
});
test('profile validation enforces Unicode, unlocks and readiness; joining clears readiness',()=>{
  const {room}=setup();room.profile(a,room.revision,{nickname:'玩\u0000家🙂',tag:'ABC',deity:-1});assert.equal(room.member(a).nickname,'玩家🙂');
  assert.throws(()=>room.profile(a,room.revision,{nickname:'x',tag:'ABC',deity:42}),code('INVALID_PROFILE'));
  room.ready(a,room.revision,true,releaseId,contentHash);
  assert.throws(()=>room.profile(a,room.revision,{nickname:'x',tag:'ABC',deity:-1}),code('UNREADY_FIRST'));
  room.join(c);assert.equal(room.member(a).ready,false);
  assert.throws(()=>room.ready(a,room.revision,true,'wrong',contentHash),code('VERSION_MISMATCH'));
});
