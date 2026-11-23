import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

export class Auth {
  constructor({key,now=()=>Date.now(),sessionMs=8*60*60*1000,maxFailures=8,windowMs=15*60*1000}) {
    if(typeof key!=='string'||key.length<16||/^(change|replace|example)/i.test(key))throw new Error('CRAWL_ACCESS_KEY must be a private random key of at least 16 characters.');
    this.digest=createHash('sha256').update(key).digest();
    this.now=now;this.sessionMs=sessionMs;this.maxFailures=maxFailures;this.windowMs=windowMs;
    this.failures=new Map();this.sessions=new Map();
  }
  keyMatches(key){
    if(typeof key!=='string'||key.length>256)return false;
    return timingSafeEqual(this.digest,createHash('sha256').update(key).digest());
  }
  authenticate(key,ip,existingToken=''){
    this.sweep();
    const failure=this.failures.get(ip);
    if(failure&&failure.count>=this.maxFailures)return {status:429};
    if(!this.keyMatches(key)){
      if(this.failures.size>=10000&&!failure)return {status:429};
      this.failures.set(ip,{count:(failure?.count||0)+1,until:failure?.until||this.now()+this.windowMs});
      return {status:401};
    }
    this.failures.delete(ip);
    const existing=this.get(existingToken);
    if(existing)return {status:200,token:existingToken,session:existing};
    if(this.sessions.size>=256)return {status:503};
    const token=randomBytes(32).toString('base64url');
    const session={id:randomBytes(16).toString('hex'),expires:this.now()+this.sessionMs};
    this.sessions.set(this.hash(token),session);
    return {status:200,token,session};
  }
  hash(token){return createHash('sha256').update(token).digest('hex');}
  cookieToken(header=''){
    const match=header.match(/(?:^|;\s*)crawl_session=([A-Za-z0-9_-]{43})(?:;|$)/);
    return match?.[1]||'';
  }
  get(token){
    if(!/^[A-Za-z0-9_-]{43}$/.test(token||''))return null;
    const session=this.sessions.get(this.hash(token));
    return session&&session.expires>this.now()?session:null;
  }
  fromRequest(req){return this.get(this.cookieToken(req.headers.cookie));}
  revoke(token){if(token)this.sessions.delete(this.hash(token));}
  sweep(){
    for(const [key,value] of this.failures)if(value.until<=this.now())this.failures.delete(key);
    for(const [key,value] of this.sessions)if(value.expires<=this.now())this.sessions.delete(key);
  }
}
