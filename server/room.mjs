import {randomBytes,createHmac} from 'node:crypto';

const send=(socket,data)=>{if(socket?.readyState===1)socket.send(JSON.stringify(data));};
export class Room {
  constructor({rendererFactory,tunnelMedia=false,idleMs=120000,reconnectMs=30000,iceServers=[],turnUrl='',turnSecret='',hostTurnUrl='',icePolicy='all'}){
    this.tunnelMedia=tunnelMedia;
    this.id=randomBytes(12).toString('hex');this.rendererFactory=rendererFactory;this.idleMs=idleMs;this.reconnectMs=reconnectMs;
    this.iceServers=iceServers;this.turnUrl=turnUrl;this.turnSecret=turnSecret;
    this.hostTurnUrl=hostTurnUrl;this.icePolicy=icePolicy;
    this.clients=new Map();this.seats=Array(4).fill(null);this.state='idle';this.renderer=null;this.pending=null;this.host=null;
    this.hostToken='';this.idleTimer=null;this.gameStatus=null;
    this.stopping=false;this.rendererRestarts=0;
    this.recoveryTimer=null;
    this.lobbyRevision=0;this.phase='selecting';this.deities=[];this.startTimer=null;
  }
  getIceServers(forHost=false){
    const servers=[...this.iceServers];
    if(this.turnUrl&&this.turnSecret){
      const username=String(Math.floor(Date.now()/1000)+86400);
      servers.push({urls:(forHost&&this.hostTurnUrl?this.hostTurnUrl:this.turnUrl).split(','),username,credential:createHmac('sha1',this.turnSecret).update(username).digest('base64')});
    }
    return servers;
  }
  get ownerSlot(){return this.seats.find(p=>p?.socket)?.slot??-1;}
  canStart(){const peers=this.seats.filter(Boolean);return this.state==='ready'&&this.phase==='selecting'&&peers.length>=2&&peers.every(p=>p.socket&&p.ready)&&this.gameStatus?.lobbyReady&&this.gameStatus.lobbyRevision===this.lobbyRevision;}
  publicState(){return {state:this.state,phase:this.phase,ownerSlot:this.ownerSlot,canStart:!!this.canStart(),revision:this.lobbyRevision,deities:this.deities,players:this.seats.filter(Boolean).map(p=>({slot:p.slot,name:p.name,tag:p.tag,deity:p.deity,ready:p.ready,connected:!!p.socket})),game:this.gameStatus};}
  syncLobby(){send(this.host,{type:'lobby-sync',revision:this.lobbyRevision,players:this.seats.filter(Boolean).map(p=>({slot:p.slot,tag:p.tag,deity:p.deity,ready:p.ready,connected:!!p.socket}))});}
  lobbyChanged(){this.lobbyRevision++;this.syncLobby();this.notify();}
  lobbyMessage(peer,data){
    const error=message=>send(peer.socket,{type:'error',message});
    if(this.phase!=='selecting')return error('对局已开始，选人设置将在下一局开放。');
    if(data.type==='lobby-profile'){
      if(peer.ready)return error('请先取消准备，再修改角色。');
      if(typeof data.tag!=='string'||! /^[A-Z0-9]{3}$/.test(data.tag))return error('角色代号需要 3 位英文字母或数字。');
      if(this.seats.some(p=>p&&p!==peer&&p.tag===data.tag))return error('这个角色代号已被使用，请换一个。');
      if(!Number.isInteger(data.deity)||(data.deity!==-1&&!this.deities.some(d=>d.id===data.deity&&d.unlocked)))return error('该信仰尚未解锁。');
      if(typeof data.name!=='string'||data.name.replace(/[\u0000-\u001f]/g,'').trim().length<1||data.name.length>16)return error('昵称需要 1–16 个字符。');
      peer.tag=data.tag;peer.deity=data.deity;peer.name=data.name.replace(/[\u0000-\u001f]/g,'').trim();
      this.lobbyChanged();
    }else if(data.type==='lobby-ready'){
      if(typeof data.ready!=='boolean')return;
      if(data.ready&&(this.state!=='ready'||this.gameStatus?.lobbyPhase!=='selecting'))return error('游戏仍在准备，请稍候。');
      peer.ready=data.ready;this.lobbyChanged();
    }else if(data.type==='lobby-start'){
      if(peer.slot!==this.ownerSlot)return error('只有房主可以开始对局。');
      if(!this.canStart())return error('至少需要 2 位在线玩家，且所有人完成准备。');
      this.phase='starting';for(const p of this.clients.values())this.releaseInput(p);
      send(this.host,{type:'lobby-start',revision:this.lobbyRevision});this.notify();
      clearTimeout(this.startTimer);this.startTimer=setTimeout(()=>{
        if(this.phase==='starting'&&this.gameStatus?.lobbyPhase==='selecting'){this.phase='selecting';this.notify();this.broadcast({type:'error',message:'开局未完成，请房主重试。'});}
      },10000);this.startTimer.unref();
    }
  }
  broadcast(data){for(const peer of this.clients.values())send(peer.socket,data);}
  notify(){this.broadcast({type:'room',...this.publicState()});}
  async join(session,socket,name){
    if(this.stopping){send(socket,{type:'error',message:'房间正在重启，请稍后重新加入。'});socket.close(1013,'房间正在重启');return null;}
    let peer=this.seats.find(p=>p?.session.id===session.id);
    if(peer){clearTimeout(peer.releaseTimer);if(peer.socket&&peer.socket!==socket)peer.socket.close(4000,'会话已在另一页面打开');}
    else{
      if(this.phase!=='selecting'){send(socket,{type:'error',message:'对局已开始，请等待下一局；掉线玩家可用原浏览器重新连接。'});socket.close(4004,'对局已开始');return null;}
      const slot=this.seats.findIndex(p=>p===null);
      if(slot<0){send(socket,{type:'error',message:'房间已满，最多支持 4 位玩家。'});socket.close(4004,'房间已满');return null;}
      peer={id:randomBytes(16).toString('hex'),slot,session,name,tag:'P0'+(slot+1),deity:-1,ready:false,sequence:-1,windowStart:Date.now(),count:0};
      for(let n=0;this.seats.some(p=>p?.tag===peer.tag);n++)peer.tag=n.toString(36).toUpperCase().padStart(3,'0');
      this.seats[slot]=peer;this.clients.set(peer.id,peer);
    }
    clearTimeout(this.idleTimer);
    this.releaseInput(peer);
    peer.socket=socket;peer.sequence=-1;peer.name=peer.name||name||'玩家 '+(peer.slot+1);
    this.startTransport(peer);
    socket.on('message',raw=>this.clientMessage(peer,socket,raw));
    socket.on('close',()=>this.leave(peer,socket));
    if(this.phase==='selecting')peer.ready=false;
    this.lobbyChanged();
    try{await this.ensureRenderer();}catch(error){
      this.broadcast({type:'error',message:'服务器未能启动游戏，请联系服务器管理员。'});
      console.error('Game renderer failed:',error.message);
      await this.stop();
    }
    return peer;
  }
  releaseInput(peer){send(this.host,{type:'input',slot:peer.slot,buttons:0,pressed:0,x:0,y:0,mouse:false,connected:false});}
  startTransport(peer){
    peer.transportId=randomBytes(12).toString('hex');
    send(peer.socket,{type:'welcome',peerId:peer.id,slot:peer.slot,roomId:this.id,transportId:peer.transportId,iceServers:this.getIceServers(),icePolicy:this.icePolicy,tunnelMedia:this.tunnelMedia});
    if(this.state==='ready')send(this.host,{type:'peer-join',peerId:peer.id,slot:peer.slot,transportId:peer.transportId,level:peer.streamLevel||0,tunnelMedia:this.tunnelMedia});
  }
  async ensureRenderer(){
    if(this.renderer)return;
    if(this.pending)return this.pending;
    this.state='starting';this.hostToken=randomBytes(32).toString('base64url');this.notify();
    this.startAbort=new AbortController();
    this.pending=this.rendererFactory({token:this.hostToken,iceServers:this.getIceServers(true),icePolicy:this.icePolicy,room:this,signal:this.startAbort.signal})
      .then(renderer=>{this.renderer=renderer;})
      .finally(()=>{this.pending=null;});
    return this.pending;
  }
  attachHost(socket,token){
    if(!this.hostToken||typeof token!=='string'||token!==this.hostToken||this.host)return false;
    this.host=socket;
    socket.on('message',(raw,binary)=>{
      if(this.host!==socket)return;
      if(binary){
        if(!this.tunnelMedia||raw.length<=56)return;
        const peer=this.clients.get(raw.toString('ascii',0,32));
        if(!peer||peer.transportId!==raw.toString('ascii',32,56)||peer.session.expires<=Date.now()||peer.socket?.readyState!==1)return;
        if(peer.socket.bufferedAmount>512*1024){peer.socket.terminate();return;}
        peer.socket.send(raw.subarray(56),{binary:true});
      }else this.hostMessage(raw);
    });
    socket.on('close',()=>{if(this.host===socket){this.host=null;if(!this.stopping){this.state='failed';this.notify();}}});
    return true;
  }
  rendererLost(renderer){
    if(this.renderer!==renderer||this.stopping)return;
    this.renderer=null;this.state='failed';this.host?.terminate();this.host=null;this.notify();
    this.phase='selecting';this.gameStatus=null;for(const peer of this.clients.values())peer.ready=false;this.lobbyChanged();
    if([...this.clients.values()].some(peer=>peer.socket)&&this.rendererRestarts++<3){
      this.recoveryTimer=setTimeout(()=>{
        if(!this.stopping&&[...this.clients.values()].some(peer=>peer.socket))this.ensureRenderer().catch(()=>this.stop());
      },2000);this.recoveryTimer.unref();
    }
  }
  clientMessage(peer,socket,raw){
    if(peer.socket!==socket||peer.session.expires<=Date.now())return socket.close(4001,'联机授权已过期');
    if(Date.now()-peer.windowStart>1000){peer.windowStart=Date.now();peer.count=0;}
    if(++peer.count>150)return socket.close(4008,'操作过于频繁');
    let data;try{data=JSON.parse(raw.toString());}catch{return socket.close(4002,'无效数据');}
    if(!data||typeof data!=='object'||Array.isArray(data))return socket.close(4002,'无效数据');
    if(data.type==='input'){
      if(this.phase!=='playing')return;
      if(!Number.isSafeInteger(data.sequence)||data.sequence<=peer.sequence)return;
      if(!Number.isInteger(data.buttons)||data.buttons<0||data.buttons>7||!Number.isFinite(data.x)||Math.abs(data.x)>1||!Number.isFinite(data.y)||Math.abs(data.y)>1)return;
      if(data.mouse!==undefined&&typeof data.mouse!=='boolean')return;
      if(data.mouse&&(!Number.isFinite(data.px)||data.px<0||data.px>1||!Number.isFinite(data.py)||data.py<0||data.py>1))return;
      peer.sequence=data.sequence;
      send(this.host,{type:'input',slot:peer.slot,buttons:data.buttons,pressed:Number.isInteger(data.pressed)?data.pressed&7:0,x:data.x,y:data.y,mouse:!!data.mouse,px:data.mouse?data.px:0,py:data.mouse?data.py:0,connected:true});
    }else if(data.type==='stream-quality'){
      if(!Number.isInteger(data.level)||data.level<0||data.level>2)return;
      peer.streamLevel=data.level;
      send(this.host,{type:'stream-quality',peerId:peer.id,level:data.level});
    }else if(['lobby-profile','lobby-ready','lobby-start'].includes(data.type))this.lobbyMessage(peer,data);
    else if(data.type==='signal'){
      if(data.transportId!==peer.transportId)return;
      if(data.sdp&&(data.sdp.type!=='answer'||typeof data.sdp.sdp!=='string'||data.sdp.sdp.length>14000))return;
      if(data.candidate&&JSON.stringify(data.candidate).length>2048)return;
      send(this.host,{type:'signal',peerId:peer.id,transportId:peer.transportId,sdp:data.sdp,candidate:data.candidate});
    }
  }
  hostMessage(raw){
    let data;try{data=JSON.parse(raw.toString());}catch{return;}
    if(!data||typeof data!=='object'||Array.isArray(data))return;
    if(data.type==='ready'){
      this.state='ready';
      for(const peer of this.clients.values())if(peer.socket){
        // Recreate viewer transports after the private host signaling socket reconnects.
        this.startTransport(peer);
      }
      this.notify();
      this.syncLobby();
    }else if(data.type==='signal'){
      const peer=this.clients.get(data.peerId);if(peer&&data.transportId===peer.transportId)send(peer.socket,{type:'signal',transportId:peer.transportId,sdp:data.sdp,candidate:data.candidate});
    }else if(data.type==='tunnel-media-init'&&this.tunnelMedia){
      const peer=this.clients.get(data.peerId);
      if(peer?.transportId===data.transportId)send(peer.socket,{type:data.type});
    }else if(data.type==='stream-info'){
      const peer=this.clients.get(data.peerId);
      if(peer)send(peer.socket,{type:'stream-info',level:data.level,maxFps:data.maxFps,width:data.width,height:data.height});
    }else if(data.type==='game-status'){
      this.gameStatus={scene:String(data.status?.scene||'').slice(0,80),active:(data.status?.active||[]).slice(0,4),controllers:(data.status?.controllers||[]).slice(0,4),frame:Number(data.status?.frame)||0,menus:(data.status?.menus||[]).slice(0,64).map(s=>String(s).slice(0,128)),inputDiagnostics:{packets:Number(data.status?.remotePackets)||0,presses:Number(data.status?.remotePresses)||0,reads:Number(data.status?.readPresses)||0,instances:Number(data.status?.inputInstances)||0}};
      Object.assign(this.gameStatus,{playerX:(data.status?.playerX||[]).slice(0,4),playerY:(data.status?.playerY||[]).slice(0,4),pointer:(data.status?.pointer||[]).slice(0,4),caption:String(data.status?.caption||'').slice(0,300),voice:String(data.status?.voice||'').slice(0,80),voiceTime:Number(data.status?.voiceTime)||0});
      Object.assign(this.gameStatus,{lobbyPhase:String(data.status?.lobbyPhase||'loading'),lobbyReady:data.status?.lobbyReady===true,lobbyRevision:Number(data.status?.lobbyRevision??-1)});
      Object.assign(this.gameStatus,{playerNames:(data.status?.playerNames||[]).slice(0,4),playerDeities:(data.status?.playerDeities||[]).slice(0,4)});
      if(Array.isArray(data.status?.deities))this.deities=data.status.deities.slice(0,80).map(d=>({id:d.id,name:String(d.name||'').slice(0,60),description:String(d.description||'').slice(0,500),unlocked:d.unlocked===true,trial:d.trial===true}));
      if(this.gameStatus.lobbyPhase==='playing'){this.phase='playing';clearTimeout(this.startTimer);}
      else if(this.phase==='playing'&&this.gameStatus.lobbyPhase==='selecting'){this.phase='selecting';for(const p of this.clients.values())p.ready=false;this.lobbyChanged();}
      this.notify();
    }else if(data.type==='host-error'){
      this.broadcast({type:'error',message:'游戏画面连接异常，请尝试重新加入。'});
    }
  }
  leave(peer,socket){
    if(peer.socket!==socket)return;
    peer.socket=null;
    if(this.phase==='selecting')peer.ready=false;
    this.releaseInput(peer);
    send(this.host,{type:'peer-leave',peerId:peer.id});
    peer.releaseTimer=setTimeout(()=>{if(!peer.socket)this.removePeer(peer);},this.reconnectMs);
    peer.releaseTimer.unref();this.lobbyChanged();
    this.scheduleIdle();
  }
  scheduleIdle(){
    if(![...this.clients.values()].some(p=>p.socket)){
      clearTimeout(this.idleTimer);
      this.idleTimer=setTimeout(()=>this.stop().catch(error=>console.error('Room close failed:',error.message)),this.idleMs);this.idleTimer.unref();
    }
  }
  removePeer(peer){
    clearTimeout(peer.releaseTimer);
    if(this.seats[peer.slot]!==peer)return;
    this.seats[peer.slot]=null;this.clients.delete(peer.id);this.lobbyChanged();
  }
  revoke(sessionId){
    for(const peer of this.clients.values())if(peer.session.id===sessionId){
      const socket=peer.socket;peer.socket=null;this.releaseInput(peer);
      send(this.host,{type:'peer-leave',peerId:peer.id});
      this.removePeer(peer);socket?.close(4001,'已退出联机');
    }
    this.scheduleIdle();
  }
  async stop(){
    if(this.stopping)return;
    this.stopping=true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.startTimer);
    for(const peer of this.clients.values()){clearTimeout(peer.releaseTimer);const socket=peer.socket;peer.socket=null;socket?.close(1001,'房间已关闭');}
    this.clients.clear();this.seats.fill(null);
    this.host?.close();this.host=null;this.hostToken='';
    if(this.pending){this.startAbort?.abort();await this.pending.catch(()=>{});}
    const renderer=this.renderer;this.renderer=null;
    if(renderer)await renderer.close();
    this.state='idle';this.gameStatus=null;this.rendererRestarts=0;this.stopping=false;this.phase='selecting';this.deities=[];this.lobbyRevision=0;
  }
}
