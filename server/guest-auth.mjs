import {randomBytes,createHash} from 'node:crypto';
import {Auth} from './auth.mjs';

// Guest identity outlives a login session. Public playerId is never a credential.
// The HTTP adapter must put both returned tokens in separate HttpOnly cookies.
export class GuestAuth {
  constructor({key,now=()=>Date.now(),sessionMs,guestMs=24*60*60*1000,capacity=256,store}={}){
    if(!Number.isSafeInteger(guestMs)||guestMs<=0||!Number.isSafeInteger(capacity)||capacity<1)throw new TypeError('Invalid guest limits');
    this.now=now;this.guestMs=guestMs;this.capacity=capacity;this.store=store;
    this.auth=new Auth({key,now,...(sessionMs===undefined?{}:{sessionMs})});
    this.guests=new Map();this.byPlayer=new Map();this.pinned=new Set();
  }
  digest(token){return createHash('sha256').update(token).digest('hex');}
  guest(token){
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    const digest=this.digest(token);
    const guest=this.guests.get(digest)??this.store?.findGuest(digest);
    return guest&&guest.expires>this.now()?guest:null;
  }
  login({key,ip,sessionToken='',guestToken=''}){
    this.sweep();
    const login=this.auth.authenticate(key,ip,sessionToken);
    if(login.status!==200)return {status:login.status};
    let guest=this.guest(guestToken);
    if(login.session.playerId){
      // A still-valid session is also proof of its existing identity. However,
      // don't silently switch identities when two valid credentials disagree.
      if(guest&&guest.playerId!==login.session.playerId)return {status:409,code:'IDENTITY_CONFLICT'};
      const existing=this.byPlayer.get(login.session.playerId);
      if(!existing){this.auth.revoke(login.token);return {status:401,code:'IDENTITY_REVOKED'};}
      if(!guest){
        // Restore a lost/expired guest cookie using the authorized session;
        // rotate instead of storing a plaintext token on the server.
        guestToken=randomBytes(32).toString('base64url');
        guest={...existing,digest:this.digest(guestToken)};
      }
    }
    if(!guest){
      guestToken=randomBytes(32).toString('base64url');
      guest={playerId:randomBytes(16).toString('hex'),digest:this.digest(guestToken)};
    }
    const previous=this.byPlayer.get(guest.playerId);
    if(!previous&&this.byPlayer.size>=this.capacity){this.auth.revoke(login.token);return {status:503,code:'IDENTITY_CAPACITY'};}
    guest.expires=this.now()+this.guestMs;
    this.store?.saveGuest(guest);
    if(previous&&previous.digest!==guest.digest)this.guests.delete(previous.digest);
    this.guests.set(guest.digest,guest);this.byPlayer.set(guest.playerId,guest);
    login.session.playerId=guest.playerId;
    return {status:200,sessionToken:login.token,guestToken,playerId:guest.playerId,sessionExpires:login.session.expires,guestExpires:guest.expires};
  }
  session(token){
    const session=this.auth.get(token);
    if(!session?.playerId||!this.byPlayer.has(session.playerId))return null;
    // Authorized activity renews identity independently of the login expiry.
    this.byPlayer.get(session.playerId).expires=this.now()+this.guestMs;
    return {playerId:session.playerId,expires:session.expires};
  }
  logout(sessionToken){const session=this.session(sessionToken);this.auth.revoke(sessionToken);return session?.playerId??null;}
  forget(sessionToken,guestToken){
    const session=this.session(sessionToken);const guest=this.guest(guestToken);
    const playerId=session?.playerId??guest?.playerId;
    if(!playerId)return null;
    if(session&&guest&&session.playerId!==guest.playerId)throw new Error('IDENTITY_CONFLICT');
    this.store?.deleteGuest(playerId);
    const record=this.byPlayer.get(playerId);if(record)this.guests.delete(record.digest);
    this.byPlayer.delete(playerId);this.pinned.delete(playerId);
    for(const [digest,value] of this.auth.sessions)if(value.playerId===playerId)this.auth.sessions.delete(digest);
    return playerId; // Caller also revokes tickets and any active game connection.
  }
  pin(playerId){if(!this.byPlayer.has(playerId))throw new Error('UNKNOWN_IDENTITY');this.pinned.add(playerId);}
  unpin(playerId){this.pinned.delete(playerId);}
  sweep(){
    this.auth.sweep();
    const live=new Set([...this.auth.sessions.values()].map(s=>s.playerId));
    for(const [playerId,guest] of this.byPlayer)if((this.store||guest.expires<=this.now())&&!this.pinned.has(playerId)&&!live.has(playerId)){
      this.byPlayer.delete(playerId);this.guests.delete(guest.digest);
    }
  }
}
