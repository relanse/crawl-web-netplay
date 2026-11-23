import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {Auth} from './auth.mjs';
import {Room} from './room.mjs';
import {launchRenderer} from './renderer.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.gz':'application/gzip','.wasm':'application/wasm','.txt':'text/plain; charset=utf-8','.png':'image/png','.ico':'image/x-icon'};
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){
  let result='';for await(const chunk of req){result+=chunk;if(result.length>2048)throw new Error('BODY_TOO_LARGE');}
  const value=JSON.parse(result);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('INVALID_BODY');return value;
}
export function createCrawlServer(options={}){
  const key=options.key??process.env.CRAWL_ACCESS_KEY;
  const auth=new Auth({key,...options.authOptions});
  const publicOrigin=options.publicOrigin??process.env.PUBLIC_ORIGIN??'';
  if(publicOrigin){
    const url=new URL(publicOrigin);
    if(url.origin!==publicOrigin||(!['localhost','127.0.0.1'].includes(url.hostname)&&url.protocol!=='https:'))throw new Error('PUBLIC_ORIGIN must be an HTTPS origin, without a trailing slash.');
  }
  const secure=publicOrigin.startsWith('https:');
  const dist=path.resolve(options.dist??process.env.GAME_DIRECTORY??path.join(HERE,'../site/dist'));
  let localOrigin='';
  const rendererFactory=options.rendererFactory??(config=>launchRenderer({...config,origin:localOrigin,dataDirectory:path.resolve(process.env.DATA_DIRECTORY||path.join(HERE,'data')),executablePath:process.env.CHROME_PATH}));
  const room=new Room({rendererFactory,tunnelMedia:process.env.CRAWL_TUNNEL_MEDIA==='1',idleMs:options.idleMs??Number(process.env.ROOM_IDLE_SECONDS||120)*1000,reconnectMs:options.reconnectMs??30000,
    iceServers:options.iceServers??[{urls:process.env.STUN_URL||'stun:stun.cloudflare.com:3478'}],turnUrl:process.env.TURN_URL||'',turnSecret:process.env.TURN_SECRET||'',hostTurnUrl:process.env.TURN_INTERNAL_URL||'',icePolicy:process.env.ICE_TRANSPORT_POLICY==='relay'?'relay':'all'});
  const allowedOrigin=req=>{
    if(!req.headers.origin)return true;
    return req.headers.origin===(publicOrigin||'http://'+req.headers.host);
  };
  const requestIp=req=>{
    const ip=req.socket.remoteAddress||'unknown';
    if(process.env.TRUST_PROXY==='1'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip)&&req.headers['x-forwarded-for'])return String(req.headers['x-forwarded-for']).split(',').at(-1).trim();
    return ip;
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/healthz')return json(res,200,{ok:true});
      if(url.pathname==='/api/online/config'&&req.method==='GET')return json(res,200,{enabled:true,maxPlayers:4});
      if(url.pathname.startsWith('/api/')){
        if(!allowedOrigin(req))return json(res,403,{error:'请求来源不允许。'});
        if(url.pathname==='/api/online/session'&&req.method==='POST'){
          if(!String(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'无效请求。'});
          const data=await body(req);const result=auth.authenticate(data.key,requestIp(req),auth.cookieToken(req.headers.cookie));
          if(result.status!==200)return json(res,result.status,{error:result.status===429?'尝试过于频繁，请稍后再试。':result.status===503?'服务器暂时繁忙。':'联机密钥不正确。'});
          res.setHeader('Set-Cookie',`crawl_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure?'; Secure':''}`);
          return json(res,200,{ok:true});
        }
        const session=auth.fromRequest(req);
        if(!session)return json(res,401,{error:'请输入有效的联机密钥。'});
        if(url.pathname==='/api/online/session'&&req.method==='DELETE'){
          room.revoke(session.id);auth.revoke(auth.cookieToken(req.headers.cookie));
          res.setHeader('Set-Cookie',`crawl_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure?'; Secure':''}`);return json(res,200,{ok:true});
        }
        if(url.pathname==='/api/online/status'&&req.method==='GET')return json(res,200,room.publicState());
        return json(res,404,{error:'接口不存在。'});
      }
      if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'不支持此请求。'});
      const requested=decodeURIComponent(url.pathname);const file=path.resolve(dist,'.'+(requested==='/'?'/index.html':requested));
      if(!file.startsWith(dist+path.sep))return json(res,403,{error:'无权访问。'});
      const info=await stat(file);if(!info.isFile())throw new Error('NOT_FOUND');
      res.setHeader('Content-Type',MIME[path.extname(file)]||'application/octet-stream');res.setHeader('Content-Length',info.size);
      res.setHeader('Cache-Control',requested.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache');
      if(req.method==='HEAD')return res.end();
      const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch(error){if(!res.headersSent)json(res,error.message==='BODY_TOO_LARGE'?413:error instanceof SyntaxError||error.message==='INVALID_BODY'?400:404,{error:'无法处理此请求。'});else res.destroy();}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=200;
  const clients=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});
  const hosts=new WebSocketServer({noServer:true,maxPayload:32768,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    socket.on('error',()=>{});
    let url;try{url=new URL(req.url,'http://localhost');}catch{socket.destroy();return;}
    if(url.pathname==='/host-socket'&&req.headers.origin===localOrigin){
      return hosts.handleUpgrade(req,socket,head,ws=>{
        ws.on('error',()=>{});
        const timeout=setTimeout(()=>ws.close(4003,'授权失败'),3000);timeout.unref();
        ws.once('message',raw=>{clearTimeout(timeout);let data;try{data=JSON.parse(raw.toString());}catch{return ws.close(4003,'授权失败');}
          if(!data||data.type!=='host-auth'||!room.attachHost(ws,data.token))return ws.close(4003,'授权失败');
          ws.send(JSON.stringify({type:'host-authorized'}));
        });
      });
    }
    const session=auth.fromRequest(req);
    if(url.pathname!=='/online-socket'||!session||!allowedOrigin(req)){
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;
    }
    clients.handleUpgrade(req,socket,head,ws=>{
      ws.on('error',()=>{});
      ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true;});
      const name=String(url.searchParams.get('name')||'').slice(0,16).replace(/[\u0000-\u001f]/g,'');
      room.join(session,ws,name).catch(()=>ws.close(1011,'服务器异常'));
    });
  });
  const heartbeat=setInterval(()=>{
    auth.sweep();for(const ws of clients.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}
    for(const peer of room.clients.values())if(peer.session.expires<=Date.now())peer.socket?.close(4001,'联机授权已过期');
  },30000);heartbeat.unref();
  return {server,auth,room,async listen(port=Number(process.env.PORT||8080),host=process.env.BIND_ADDRESS||'127.0.0.1'){
    if(!['127.0.0.1','::1','localhost'].includes(host)&&!publicOrigin)throw new Error('An HTTPS PUBLIC_ORIGIN is required before listening on a public interface.');
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
    localOrigin='http://127.0.0.1:'+server.address().port;return localOrigin;
  },async close(){clearInterval(heartbeat);await room.stop();for(const ws of hosts.clients)ws.terminate();for(const ws of clients.clients)ws.terminate();clients.close();hosts.close();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createCrawlServer();const origin=await app.listen();console.log('Crawl server ready at '+origin+'; online access requires a key.');
  const shutdown=async()=>{await app.close();process.exit(0);};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
