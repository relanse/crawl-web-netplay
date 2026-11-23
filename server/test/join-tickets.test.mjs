import test from 'node:test';
import assert from 'node:assert/strict';
import {JoinTickets} from '../join-tickets.mjs';

const binding = {roomId:'1'.repeat(32),matchId:'2'.repeat(32),playerId:'3'.repeat(32),
  processLeaseId:'4'.repeat(32),slot:1,releaseId:'netplay-test-1'};
const code = expected => error => error.code === expected;

test('tickets bind an authenticated player and process, never trusting a supplied slot', () => {
  const tickets = new JoinTickets(); const issued = tickets.issue(binding);
  assert.ok(!JSON.stringify([...tickets.records]).includes(issued.ticket));
  assert.throws(() => tickets.redeem(issued.ticket,{...binding,processLeaseId:'5'.repeat(32)},()=>true),code('TICKET_BINDING_MISMATCH'));
  const result = tickets.redeem(issued.ticket,{...binding,slot:3},record=>record.playerId===binding.playerId);
  assert.equal(result.slot,1); assert.equal(result.playerId,binding.playerId);
  assert.throws(() => tickets.redeem(issued.ticket,binding,()=>true),code('TICKET_USED'));
});

test('expiry, authorization revocation and asynchronous truthy authorization cannot admit a player', () => {
  let now=1000;const tickets=new JoinTickets({now:()=>now});
  const first=tickets.issue(binding);
  assert.throws(()=>tickets.redeem(first.ticket,binding,()=>false),code('AUTH_REQUIRED'));
  assert.throws(()=>tickets.redeem(first.ticket,binding,()=>Promise.resolve(true)),code('AUTH_REQUIRED'));
  now=first.expiresAt;
  assert.throws(()=>tickets.redeem(first.ticket,binding,()=>true),code('TICKET_EXPIRED'));
  const second=tickets.issue(binding); tickets.revokePlayer(binding.playerId);
  assert.throws(()=>tickets.redeem(second.ticket,binding,()=>true),code('TICKET_INVALID'));
});

test('ticket store is bounded and stale matches cannot redeem retained tickets', () => {
  let now=0;const tickets=new JoinTickets({now:()=>now,ttlMs:100,capacity:1});
  const first=tickets.issue(binding);
  assert.throws(()=>tickets.issue(binding),code('TICKET_CAPACITY'));
  tickets.revokeMatch(binding.matchId);
  assert.throws(()=>tickets.redeem(first.ticket,binding,()=>true),code('TICKET_INVALID'));
  tickets.issue(binding); now=100; tickets.issue(binding);
  assert.equal(tickets.records.size,1);
});
