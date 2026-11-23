import {randomBytes} from 'node:crypto';

export class RoomError extends Error {
  constructor(code) { super(code); this.code=code; }
}
const fail=code=>{throw new RoomError(code);};
const id=()=>randomBytes(16).toString('hex');
const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);

// New simulation-mode room. No renderer, WebRTC, media-ready or socket objects.
// The authenticated HTTP/control adapter supplies playerId; request JSON cannot.
export class RoomSession {
  constructor({releaseId,contentHash,now=()=>performance.now(),newId=id,loadingMs=90_000,offlineMs=180_000}={}) {
    if(!/^[A-Za-z0-9._-]{1,64}$/.test(releaseId??'')||!/^[a-f0-9]{64}$/.test(contentHash??''))throw new TypeError('Invalid release');
    if(!Number.isFinite(loadingMs)||loadingMs<=0||!Number.isFinite(offlineMs)||offlineMs<=0)throw new TypeError('Invalid deadlines');
    this.now=now;this.newId=newId;this.loadingMs=loadingMs;this.offlineMs=offlineMs;
    this.roomId=newId();this.releaseId=releaseId;this.contentHash=contentHash;
    this.phase='Lobby';this.revision=1;this.members=new Map();this.ownerId=null;
    this.match=null;this.starts=new Map();this.allOfflineAt=null;this.failure=null;
  }
  changed(){if(this.revision>=0xffffffff)fail('REVISION_EXHAUSTED');this.revision++;}
  expect(revision){if(revision!==this.revision)fail('ROOM_CHANGED');}
  lobby(){if(this.phase!=='Lobby')fail('NOT_IN_LOBBY');}
  member(playerId){const m=this.members.get(playerId);if(!m)fail('NOT_A_MEMBER');return m;}
  clearReady(){for(const m of this.members.values())m.ready=false;}
  chooseOwner(){this.ownerId=[...this.members.values()].find(m=>m.lobbyConnected&&!m.abandoned)?.playerId??null;}
  join(playerId,display){
    if(!validId(playerId))fail('INVALID_IDENTITY');
    const existing=this.members.get(playerId);
    if(existing){if(existing.abandoned)fail('MATCH_ABANDONED');return this.snapshot();}
    this.lobby();if(this.members.size>=4)fail('ROOM_FULL');
    const slots=new Set([...this.members.values()].map(m=>m.slot));let slot=0;while(slots.has(slot))slot++;
    this.members.set(playerId,{playerId,slot,nickname:display?.nickname??'Player '+(slot+1),tag:display?.tag??'P0'+(slot+1),deity:-1,ready:false,lobbyConnected:false,gameConnected:false,connectionEpoch:0,abandoned:false});
    this.clearReady();this.changed();return this.snapshot();
  }
  lobbyConnection(playerId,connected){
    const m=this.member(playerId);connected=connected===true;if(m.lobbyConnected===connected)return;
    m.lobbyConnected=connected;
    if(this.phase==='Lobby'&&!connected)m.ready=false;
    if(!this.ownerId||(!connected&&this.ownerId===playerId))this.chooseOwner();
    this.changed();
  }
  profile(playerId,revision,{nickname,tag,deity},allowedDeities=new Set([-1])){
    this.lobby();this.expect(revision);const m=this.member(playerId);if(m.ready)fail('UNREADY_FIRST');
    if(typeof nickname!=='string')fail('INVALID_PROFILE');
    nickname=nickname.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu,'').trim();
    if([...nickname].length<1||[...nickname].length>16||Buffer.byteLength(nickname,'utf8')>64||
      !/^[A-Z0-9]{3}$/.test(tag??'')||!Number.isInteger(deity)||!allowedDeities.has(deity))fail('INVALID_PROFILE');
    Object.assign(m,{nickname,tag,deity});this.changed();return this.snapshot();
  }
  ready(playerId,revision,ready,releaseId,contentHash){
    this.lobby();this.expect(revision);const m=this.member(playerId);
    if(typeof ready!=='boolean'||!m.lobbyConnected)fail('NOT_CONNECTED');
    if(releaseId!==this.releaseId||contentHash!==this.contentHash)fail('VERSION_MISMATCH');
    if(m.ready!==ready){m.ready=ready;this.changed();}return this.snapshot();
  }
  start(playerId,revision,requestId){
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(requestId))fail('INVALID_REQUEST_ID');
    const key=playerId+':'+requestId;
    const old=this.starts.get(key);
    if(old){if(old.matchId!==this.match?.matchId)fail('START_EXPIRED');return structuredClone(old);}
    this.lobby();this.expect(revision);if(this.ownerId!==playerId)fail('NOT_OWNER');
    if(this.members.size<2||[...this.members.values()].some(m=>!m.lobbyConnected||!m.ready))fail('PLAYERS_NOT_READY');
    // Old retransmissions still carry an obsolete revision after eviction.
    if(this.starts.size>=128)this.starts.delete(this.starts.keys().next().value);
    const matchId=this.newId(),processLeaseId=this.newId();
    const roster=[...this.members.values()].map(({playerId,slot,nickname,tag,deity})=>Object.freeze({playerId,slot,nickname,tag,deity}));
    this.match={matchId,processLeaseId,ownerId:this.ownerId,roster:Object.freeze(roster),loadingDeadline:this.now()+this.loadingMs,resultId:null,summary:null};
    this.phase='Loading';this.allOfflineAt=null;this.failure=null;this.changed();
    const result={matchId,processLeaseId,roomId:this.roomId};this.starts.set(key,Object.freeze(result));return {...result};
  }
  lease(matchId,processLeaseId){if(!this.match||this.match.matchId!==matchId||this.match.processLeaseId!==processLeaseId)fail('STALE_PROCESS');}
  authorizeTicket(binding){
    const m=this.members.get(binding.playerId);
    return ['Loading','Running'].includes(this.phase)&&binding.roomId===this.roomId&&binding.matchId===this.match?.matchId&&
      binding.processLeaseId===this.match?.processLeaseId&&binding.releaseId===this.releaseId&&m?.slot===binding.slot&&!m.abandoned;
  }
  gameConnection(matchId,processLeaseId,playerId,epoch,connected){
    this.lease(matchId,processLeaseId);if(!['Loading','Running'].includes(this.phase))fail('MATCH_NOT_ACTIVE');
    const m=this.member(playerId);if(m.abandoned)fail('MATCH_ABANDONED');
    if(!Number.isInteger(epoch)||epoch<1||epoch>0xffffffff)fail('INVALID_EPOCH');
    if(connected&&epoch<=m.connectionEpoch)fail('STALE_CONNECTION');
    if(!connected&&(epoch<m.connectionEpoch||(epoch===m.connectionEpoch&&!m.gameConnected)))return false;
    m.connectionEpoch=epoch;m.gameConnected=connected;
    this.updateOfflineDeadline();this.changed();return true;
  }
  started(matchId,processLeaseId){
    this.lease(matchId,processLeaseId);if(this.phase==='Running')return;
    if(this.phase!=='Loading')fail('INVALID_PHASE');
    if(this.now()>=this.match.loadingDeadline)fail('LOAD_TIMEOUT');
    if([...this.members.values()].some(m=>!m.gameConnected||m.abandoned))fail('PLAYERS_NOT_CONNECTED');
    // Call only after the Unity loading/baseline barrier has completed.
    this.phase='Running';this.changed();this.updateOfflineDeadline();
  }
  updateOfflineDeadline(){
    if(this.phase!=='Running'){this.allOfflineAt=null;return;}
    if([...this.members.values()].some(m=>m.gameConnected&&!m.abandoned))this.allOfflineAt=null;
    else if(this.allOfflineAt===null)this.allOfflineAt=this.now();
  }
  abandon(playerId){
    const m=this.member(playerId);
    if(['Lobby','Results','Failed'].includes(this.phase)){this.members.delete(playerId);this.clearReady();if(this.ownerId===playerId)this.chooseOwner();this.changed();return {cancelMatch:this.members.size===0&&!!this.match,matchId:this.match?.matchId};}
    if(this.phase==='Loading'){m.abandoned=true;return this.cancelLoading('PLAYER_LEFT');}
    if(this.phase!=='Running')fail('INVALID_PHASE');
    m.abandoned=true;m.ready=false;m.gameConnected=false;if(this.ownerId===playerId)this.chooseOwner();this.updateOfflineDeadline();this.changed();
    return {cancelMatch:false,revokePlayerId:playerId};
  }
  cancelLoading(reason){
    if(this.phase!=='Loading')fail('INVALID_PHASE');
    const cancelled={...this.match};this.resetLobby(reason);
    return {cancelMatch:true,matchId:cancelled.matchId,processLeaseId:cancelled.processLeaseId,reason};
  }
  ended(matchId,processLeaseId,resultId){
    this.lease(matchId,processLeaseId);if(!validId(resultId))fail('INVALID_RESULT');
    if(this.phase==='Results'){if(this.match.resultId!==resultId)fail('RESULT_CONFLICT');return false;}
    if(this.phase!=='Running')fail('INVALID_PHASE');
    this.match.resultId=resultId;this.phase='Results';this.allOfflineAt=null;this.changed();return true;
  }
  crashed(matchId,processLeaseId){
    this.lease(matchId,processLeaseId);if(!['Loading','Running'].includes(this.phase))return false;
    this.phase='Failed';this.failure='PROCESS_EXITED';this.clearReady();
    for(const m of this.members.values())m.gameConnected=false;
    this.allOfflineAt=null;this.changed();return true;
  }
  resetLobby(reason=null){
    this.phase='Lobby';this.match=null;this.failure=reason;this.allOfflineAt=null;
    for(const [key,m] of this.members){if(m.abandoned)this.members.delete(key);else {m.ready=false;m.gameConnected=false;m.connectionEpoch=0;}}
    this.chooseOwner();this.changed();
  }
  returnToLobby(){if(!['Results','Failed'].includes(this.phase))fail('INVALID_PHASE');this.resetLobby();}
  tick(){
    if(this.phase==='Loading'&&this.now()>=this.match.loadingDeadline)return this.cancelLoading('LOAD_TIMEOUT');
    if(this.phase==='Running'&&this.allOfflineAt!==null&&this.now()-this.allOfflineAt>=this.offlineMs){
      const effect={cancelMatch:true,matchId:this.match.matchId,processLeaseId:this.match.processLeaseId,reason:'ALL_OFFLINE'};
      this.resetLobby(effect.reason);return effect;
    }
    return null;
  }
  snapshot(){
    // Never expose the private process lease in public room data.
    return {roomId:this.roomId,revision:this.revision,phase:this.phase,ownerId:this.ownerId,releaseId:this.releaseId,contentHash:this.contentHash,
      matchId:this.match?.matchId??null,result:this.match?.summary??null,failure:this.failure,members:[...this.members.values()].map(m=>({...m}))};
  }
}
