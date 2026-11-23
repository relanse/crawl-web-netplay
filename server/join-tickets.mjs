import {createHash, randomBytes} from 'node:crypto';

export class TicketError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Only the trusted game-process control channel may call redeem().
// Tokens are opaque, short lived and only their hashes are retained.
export class JoinTickets {
  constructor({now = () => Date.now(), ttlMs = 30_000, capacity = 1024} = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(capacity) || capacity < 1)
      throw new TypeError('Invalid ticket limits');
    this.now = now; this.ttlMs = ttlMs; this.capacity = capacity; this.records = new Map();
  }
  digest(token) { return createHash('sha256').update(token).digest('hex'); }
  issue(binding) {
    this.sweep();
    for (const name of ['roomId','matchId','playerId','processLeaseId'])
      if (!/^[a-f0-9]{32}$/.test(binding[name] ?? '')) throw new TypeError('Invalid ticket binding');
    if (!Number.isInteger(binding.slot) || binding.slot < 0 || binding.slot > 3 ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(binding.releaseId ?? '')) throw new TypeError('Invalid ticket binding');
    if (this.records.size >= this.capacity) throw new TicketError('TICKET_CAPACITY');
    const ticket = randomBytes(32).toString('base64url'), expiresAt = this.now() + this.ttlMs;
    const record = {roomId:binding.roomId, matchId:binding.matchId, playerId:binding.playerId,
      processLeaseId:binding.processLeaseId, slot:binding.slot, releaseId:binding.releaseId,
      expiresAt, used:false};
    this.records.set(this.digest(ticket), record);
    return {ticket, expiresAt};
  }
  redeem(ticket, expected, authorize) {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new TicketError('TICKET_INVALID');
    const record = this.records.get(this.digest(ticket));
    if (!record) throw new TicketError('TICKET_INVALID');
    if (record.expiresAt <= this.now()) throw new TicketError('TICKET_EXPIRED');
    if (record.used) throw new TicketError('TICKET_USED');
    for (const name of ['roomId','matchId','processLeaseId','releaseId'])
      if (record[name] !== expected[name]) throw new TicketError('TICKET_BINDING_MISMATCH');
    // Synchronous authorization and consumption form one atomic JS operation.
    // Never accept a Promise (truthy) as successful authorization.
    if (typeof authorize !== 'function' || authorize({...record}) !== true) throw new TicketError('AUTH_REQUIRED');
    record.used = true;
    return Object.freeze({roomId:record.roomId, matchId:record.matchId, playerId:record.playerId,
      slot:record.slot, releaseId:record.releaseId, processLeaseId:record.processLeaseId});
  }
  revokePlayer(playerId) {
    for (const [key, record] of this.records) if (record.playerId === playerId) this.records.delete(key);
  }
  revokeMatch(matchId) {
    for (const [key, record] of this.records) if (record.matchId === matchId) this.records.delete(key);
  }
  sweep() { for (const [key, record] of this.records) if (record.expiresAt <= this.now()) this.records.delete(key); }
}
