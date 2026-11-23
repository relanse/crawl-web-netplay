import http from 'node:http';
import net from 'node:net';
import {createReadStream,existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {GuestAuth} from './guest-auth.mjs';
import {RoomSession} from './room-session.mjs';
import {JoinTickets} from './join-tickets.mjs';
import {GameProcesses} from './game-processes.mjs';
import {guestLifetimeMs,OnlineProgress} from './online-progress.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.wasm':'application/wasm','.data':'application/octet-stream','.png':'image/png','.ico':'image/x-icon'};
const cookies=header=>Object.fromEntries(String(header??'').split(';').map(x=>x.trim().split('=')));
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req){let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw Error('BODY_TOO_LARGE');chunks.push(chunk);}const value=JSON.parse(Buffer.concat(chunks));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_BODY');return value;}
function equal(a,b){const x=Buffer.from(a??''),y=Buffer.from(b??'');return x.length===y.length&&timingSafeEqual(x,y);}

export async function createOnlineServer(options={}){
  const executable=path.resolve(options.executable??process.env.CRAWL_AUTHORITY_EXE??path.join(HERE,'../analysis/netplay/authority-runtime/CrawlServer.exe'));
  const web=path.resolve(options.web??process.env.CRAWL_CLIENT_DIRECTORY??path.join(HERE,'../analysis/netplay/network-client'));
  const nativeBuild=JSON.parse(await fs.readFile(path.join(path.dirname(executable),'build-report.json'),'utf8'));
  const clientBuild=JSON.parse(await fs.readFile(path.join(web,'client-build.json'),'utf8'));
  if(nativeBuild.kind!=='authority'||clientBuild.kind!=='client'||nativeBuild.contentHash!==clientBuild.contentHash||nativeBuild.result!=='Succeeded')throw Error('BUILD_PAIR_MISMATCH');
  const releaseId=clientBuild.releaseId,contentHash=clientBuild.contentHash;
  const key=options.key??process.env.CRAWL_ACCESS_KEY,tickets=new JoinTickets();
  const publicOrigin=options.publicOrigin??process.env.PUBLIC_ORIGIN??'';
  if(publicOrigin&&new URL(publicOrigin).origin!==publicOrigin)throw Error('INVALID_PUBLIC_ORIGIN');
  if(publicOrigin&&!publicOrigin.startsWith('https:')&&!['localhost','127.0.0.1'].includes(new URL(publicOrigin).hostname))throw Error('HTTPS_REQUIRED');
  const matchDirectory=path.resolve(options.directory??process.env.CRAWL_MATCH_DIRECTORY??path.join(HERE,'online-data/matches'));
  const drainFile=path.join(matchDirectory,'.deploy-drain');
  const switchFile=path.join(matchDirectory,'.deploy-switch');
  const progress=new OnlineProgress(path.join(matchDirectory,'.progress'));
  const auth=new GuestAuth({key,store:progress,guestMs:guestLifetimeMs});
  const rooms=new Map(),membership=new Map(),clients=new Map(),proxySockets=new Set();
  let localOrigin='',processes,timer,closing=false,progressVersion=0;
  const allowed=req=>!req.headers.origin||req.headers.origin===(publicOrigin||'http://'+req.headers.host);
  const identity=req=>auth.session(cookies(req.headers.cookie).crawl_net_session);
  const findRoom=playerId=>rooms.get(membership.get(playerId));
  const snapshot=room=>room?{...room.session.snapshot(),code:room.code}:null;
  const state=playerId=>({playerId,room:snapshot(findRoom(playerId)),rooms:[...rooms.values()].map(r=>({code:r.code,phase:r.session.phase,count:r.session.members.size})),releaseId,contentHash,progressVersion});
  function send(ws,value){if(ws.readyState!==1)return;if(ws.bufferedAmount>256*1024){ws.close(1013,'Slow lobby connection');return;}ws.send(JSON.stringify(value));}
  function broadcast(){for(const [id,sockets]of clients)for(const ws of sockets)send(ws,{type:'state',...state(id)});}
  function removeEmpty(room){if(room.session.members.size===0){rooms.delete(room.code);}}
  async function leave(playerId){
    const room=findRoom(playerId);if(!room)return;
    const effect=room.session.abandon(playerId);tickets.revokePlayer(playerId);auth.unpin(playerId);membership.delete(playerId);
    for(const socket of proxySockets)if(socket.crawlPlayerId===playerId)socket.destroy();
    if(effect.cancelMatch)await processes.stop(effect.matchId);
    else if(effect.revokePlayerId){const record=processes.matches.get(room.session.match?.matchId);if(record)await processes.command(record,{revokePlayerIds:[playerId]});}
    removeEmpty(room);broadcast();
  }
  const privateServer=http.createServer(async(req,res)=>{
    try{
      const match=/^\/control\/([a-f0-9]{32})\/redeem$/.exec(req.url??'');const record=match&&processes.matches.get(match[1]);
      if(req.method!=='POST'||!record||!equal(req.headers.authorization,'Bearer '+record.secret)){json(res,403,{code:'AUTH_REQUIRED'});return;}
      const request=await body(req),room=[...rooms.values()].find(r=>r.session.roomId===record.roomId);
      if(!room)throw Error('ROOM_GONE');
      for(const [name,value]of Object.entries({roomId:record.roomId,matchId:record.matchId,processLeaseId:record.processLeaseId,releaseId}))if(request[name]!==value)throw Error('STALE_PROCESS');
      const ticket=tickets.redeem(request.ticket,{roomId:record.roomId,matchId:record.matchId,processLeaseId:record.processLeaseId,releaseId},b=>room.session.authorizeTicket(b));
      json(res,200,{playerId:ticket.playerId,slot:ticket.slot});
    }catch(error){json(res,403,{code:error.code??error.message});}
  });
  function status(record,value){
    const room=[...rooms.values()].find(r=>r.session.roomId===record.roomId);if(!room||room.session.match?.matchId!==record.matchId)return;
    const session=room.session;if(!['Loading','Running'].includes(session.phase))return;let changed=false;
    for(const player of value.players??[]){
      const member=session.members.get(player.playerId);if(!member||member.abandoned)continue;
      if(player.epoch>member.connectionEpoch||(player.epoch===member.connectionEpoch&&member.gameConnected!==player.connected)){
        changed=session.gameConnection(record.matchId,record.processLeaseId,player.playerId,player.epoch,player.connected)||changed;
      }
    }
    if(value.phase==='Running'&&session.phase==='Loading'&&[...session.members.values()].every(m=>m.gameConnected)){session.started(record.matchId,record.processLeaseId);changed=true;}
    if(value.result?.completed&&session.phase==='Running'&&!session.match.summary){
      try{
        session.match.summary=progress.recordMatch(record.matchId,session.match.roster,value.result);
        progressVersion++;
        if(session.failure==='RESULT_SAVE_FAILED')session.failure=null;
        session.changed();changed=true;
      }catch(error){
        if(session.failure!=='RESULT_SAVE_FAILED'){
          console.error('Could not save authoritative match result:',error.message);
          session.failure='RESULT_SAVE_FAILED';session.changed();broadcast();
        }
        return;
      }
    }
    if(value.phase==='Results'&&session.phase==='Running'){
      session.ended(record.matchId,record.processLeaseId,record.matchId);
      tickets.revokeMatch(record.matchId);
      processes.stop(record.matchId).catch(error=>console.error('Failed to stop finished match:',error));
      changed=true;
    }
    if(changed)broadcast();
  }
  function exited(record){
    tickets.revokeMatch(record.matchId);if(record.stopping||closing)return;
    const room=[...rooms.values()].find(r=>r.session.roomId===record.roomId);
    if(room?.session.match?.matchId===record.matchId){room.session.crashed(record.matchId,record.processLeaseId);broadcast();}
  }
  const lobby=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
  lobby.on('connection',(ws,req,playerId)=>{
    let group=clients.get(playerId);if(!group){group=new Set();clients.set(playerId,group);}group.add(ws);ws.alive=true;
    const room=findRoom(playerId);if(room)room.session.lobbyConnection(playerId,true);broadcast();
    ws.on('pong',()=>{ws.alive=true;});ws.on('error',()=>{});
    ws.on('message',()=>{send(ws,{type:'state',...state(playerId)});});
    ws.on('close',()=>{group.delete(ws);if(group.size===0){clients.delete(playerId);const current=findRoom(playerId);if(current)current.session.lobbyConnection(playerId,false);}broadcast();});
  });
  async function staticFile(res,directory,relative,immutable=false){
    const filename=path.resolve(directory,relative);if(!filename.startsWith(directory+path.sep))throw Error('NOT_FOUND');
    const stat=await fs.stat(filename);if(!stat.isFile())throw Error('NOT_FOUND');
    const compression=filename.endsWith('.br')?'br':filename.endsWith('.gz')?'gzip':null;
    const extension=path.extname(compression?filename.slice(0,compression==='br'?-3:-3):filename);
    res.writeHead(200,{'Content-Type':MIME[extension]??'application/octet-stream','Content-Length':stat.size,'Cache-Control':immutable?'public, max-age=31536000, immutable':'no-cache',...(compression?{'Content-Encoding':compression}:{})});
    const stream=createReadStream(filename);stream.on('error',()=>res.destroy());stream.pipe(res);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','SAMEORIGIN');
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    try{
      const url=new URL(req.url,'http://localhost');
      if(!allowed(req)){json(res,403,{code:'ORIGIN_REFUSED'});return;}
      if(req.method==='GET'&&url.pathname==='/health'){
        json(res,200,{ok:true,releaseId,contentHash,mode:'authority',deployDraining:existsSync(drainFile),activeMatches:processes?.matches.size??0});
        return;
      }
      if(existsSync(switchFile)){json(res,503,{code:'SERVER_UPDATING'});return;}
      if(req.method==='POST'&&url.pathname==='/api/login'){
        const request=await body(req),existing=cookies(req.headers.cookie);
        const login=auth.login({key:request.key,ip:req.socket.remoteAddress,sessionToken:existing.crawl_net_session,guestToken:existing.crawl_net_guest});
        if(login.status!==200){json(res,login.status,{code:login.code??'LOGIN_REFUSED'});return;}
        const secure=publicOrigin.startsWith('https:')?'; Secure':'';
        res.setHeader('Set-Cookie',[`crawl_net_session=${login.sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`,`crawl_net_guest=${login.guestToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${guestLifetimeMs/1000}${secure}`]);
        json(res,200,state(login.playerId));return;
      }
      if(url.pathname.startsWith('/api/')){
        const who=identity(req);if(!who){json(res,401,{code:'AUTH_REQUIRED'});return;}
        const playerId=who.playerId;
        if(req.method==='GET'&&url.pathname==='/api/state'){json(res,200,state(playerId));return;}
        if(req.method==='GET'&&url.pathname==='/api/progress'){json(res,200,progress.overview(playerId));return;}
        if(req.method==='GET'&&url.pathname==='/api/client'){json(res,200,{...clientBuild,base:'/client/'+contentHash+'/'});return;}
        if(req.method!=='POST')throw Error('NOT_FOUND');
        const request=await body(req);let room=findRoom(playerId);
        switch(url.pathname){
          case '/api/create':{
            if(room)throw Error('ALREADY_IN_ROOM');if(rooms.size>=8)throw Error('SERVER_BUSY');
            let code;do{code=randomBytes(4).toString('hex').slice(0,6).toUpperCase();}while(rooms.has(code));
            room={code,session:new RoomSession({releaseId,contentHash,loadingMs:publicOrigin?300_000:90_000})};rooms.set(code,room);
            room.session.join(playerId,progress.display(playerId));membership.set(playerId,code);auth.pin(playerId);room.session.lobbyConnection(playerId,clients.has(playerId));break;
          }
          case '/api/join':{
            if(room)throw Error('ALREADY_IN_ROOM');room=rooms.get(String(request.code??'').trim().toUpperCase());if(!room)throw Error('ROOM_NOT_FOUND');
            room.session.join(playerId,progress.display(playerId));membership.set(playerId,room.code);auth.pin(playerId);room.session.lobbyConnection(playerId,clients.has(playerId));break;
          }
          case '/api/profile':
            if(!room)throw Error('NOT_A_MEMBER');
            room.session.profile(playerId,request.revision,{nickname:request.nickname,tag:request.tag,deity:-1});
            progress.saveDisplay(playerId,room.session.member(playerId));
            progressVersion++;
            break;
          case '/api/ready':if(!room)throw Error('NOT_A_MEMBER');room.session.ready(playerId,request.revision,request.ready,releaseId,contentHash);break;
          case '/api/start':{
            if(existsSync(drainFile)){json(res,503,{code:'SERVER_UPDATING'});return;}
            if(!room)throw Error('NOT_A_MEMBER');room.session.start(playerId,request.revision,request.requestId);broadcast();
            try{await processes.start(room.session);}catch(error){if(room.session.phase==='Loading')room.session.cancelLoading(error.message);broadcast();throw error;}break;
          }
          case '/api/ticket':{
            if(!room)throw Error('NOT_A_MEMBER');const member=room.session.member(playerId),match=room.session.match;
            if(!match||!['Loading','Running'].includes(room.session.phase)||member.abandoned)throw Error('MATCH_NOT_ACTIVE');
            const record=processes.matches.get(match.matchId);if(!record?.status)throw Error('SERVER_LOADING');
            const issued=tickets.issue({roomId:room.session.roomId,matchId:match.matchId,processLeaseId:match.processLeaseId,releaseId,playerId,slot:member.slot});
            json(res,200,{...issued,matchId:match.matchId,releaseId,contentHash,endpoint:(publicOrigin||localOrigin).replace(/^http/,'ws')+'/game/'+match.matchId});return;
          }
          case '/api/leave':await leave(playerId);break;
          case '/api/kick':{
            if(!room||room.session.ownerId!==playerId||room.session.phase!=='Lobby')throw Error('OWNER_REQUIRED');
            if(request.playerId===playerId)throw Error('USE_LEAVE');if(!room.session.members.has(request.playerId))throw Error('NOT_A_MEMBER');await leave(request.playerId);break;
          }
          case '/api/return':{
            if(!room||room.session.ownerId!==playerId)throw Error('OWNER_REQUIRED');
            const matchId=room.session.match?.matchId;room.session.returnToLobby();if(matchId)await processes.stop(matchId);break;
          }
          case '/api/logout':await leave(playerId);auth.logout(cookies(req.headers.cookie).crawl_net_session);for(const ws of clients.get(playerId)??[])ws.close(1000,'Logged out');res.setHeader('Set-Cookie','crawl_net_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');json(res,200,{ok:true});return;
          default:throw Error('NOT_FOUND');
        }
        broadcast();json(res,200,state(playerId));return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw Error('NOT_FOUND');
      const prefix='/client/'+contentHash+'/';
      if(url.pathname.startsWith(prefix)){await staticFile(res,web,decodeURIComponent(url.pathname.slice(prefix.length)),true);return;}
      const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/game.html':'game.html','/game.js':'game.js'};
      if(!files[url.pathname])throw Error('NOT_FOUND');await staticFile(res,path.join(HERE,'online'),files[url.pathname]);
    }catch(error){if(!res.headersSent)json(res,error.code==='ENOENT'||error.message==='NOT_FOUND'?404:409,{code:error.code??error.message});else res.destroy();}
  });
  server.on('upgrade',(req,socket,head)=>{
    if(existsSync(switchFile)){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
    const who=identity(req);if(!who||!req.headers.origin||!allowed(req)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    if(req.url==='/lobby'){
      if(lobby.clients.size>=128||(clients.get(who.playerId)?.size??0)>=4){socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');return;}
      lobby.handleUpgrade(req,socket,head,ws=>lobby.emit('connection',ws,req,who.playerId));return;
    }
    const match=/^\/game\/([a-f0-9]{32})$/.exec(req.url??''),room=findRoom(who.playerId),record=match&&processes.matches.get(match[1]);
    if(!record||room?.session.match?.matchId!==record.matchId||room.session.member(who.playerId).abandoned){socket.destroy();return;}
    if(proxySockets.size>=64||[...proxySockets].filter(s=>s.crawlPlayerId===who.playerId).length>=8){socket.destroy();return;}
    socket.pause();const upstream=net.connect(record.port,'127.0.0.1');socket.crawlPlayerId=who.playerId;upstream.crawlPlayerId=who.playerId;socket.setNoDelay(true);upstream.setNoDelay(true);proxySockets.add(socket);proxySockets.add(upstream);
    socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
    socket.on('close',()=>{proxySockets.delete(socket);upstream.destroy();});upstream.on('close',()=>{proxySockets.delete(upstream);socket.destroy();});
    upstream.on('connect',()=>{upstream.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:'+record.port+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+req.headers['sec-websocket-key']+'\r\nSec-WebSocket-Version: 13\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
  });
  return {server,rooms,auth,tickets,get processes(){return processes;},
    async listen(port=Number(process.env.PORT??8792),host=options.host??'127.0.0.1'){
      await new Promise(resolve=>privateServer.listen(0,'127.0.0.1',resolve));
      processes=new GameProcesses({executable,capacity:process.platform==='linux'?1:2,directory:matchDirectory,
        profileDirectory:path.join(progress.directory,'saves'),controlBase:'http://127.0.0.1:'+privateServer.address().port,releaseId,contentHash,onStatus:status,onExit:exited});
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});localOrigin='http://127.0.0.1:'+server.address().port;
      let sweeps=0;timer=setInterval(()=>{
        for(const room of rooms.values()){
          const effect=room.session.tick();
          if(effect){tickets.revokeMatch(effect.matchId);processes.stop(effect.matchId).catch(()=>{});removeEmpty(room);broadcast();}
        }
        if(++sweeps%15===0){auth.sweep();tickets.sweep();for(const ws of lobby.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}}
      },1000);timer.unref();return publicOrigin||localOrigin;
    },
    async close(){closing=true;clearInterval(timer);for(const ws of lobby.clients)ws.terminate();for(const socket of proxySockets)socket.destroy();await processes?.close();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>privateServer.close(resolve))]);progress.close();}
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createOnlineServer();console.log('Crawl online ready: '+await app.listen());
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)));
}
