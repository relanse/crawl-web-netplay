import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {createCrawlServer} from '../server.mjs';
const key='private-test-key-0123456789';
function message(ws,predicate=()=>true){return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{ws.off('message',listener);reject(new Error('message timeout'));},4000);
  function listener(raw){const data=JSON.parse(raw.toString());if(predicate(data)){clearTimeout(timeout);ws.off('message',listener);resolve(data);}}
  ws.on('message',listener);
});}
async function session(origin){const response=await fetch(origin+'/api/online/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({key})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
function connect(origin,cookie){const ws=new WebSocket(origin.replace('http:','ws:')+'/online-socket',{headers:{Origin:origin,Cookie:cookie}});ws.on('error',()=>{});return ws;}
async function setup(t,extra={}){let renders=0;const app=createCrawlServer({key,rendererFactory:async()=>{renders++;return {close:async()=>{}};},iceServers:[],...extra});const origin=await app.listen(0);t.after(()=>app.close());return {app,origin,get renders(){return renders;}};}
test('visiting, bad keys and unauthenticated sockets never start a renderer',async t=>{
  const fixture=await setup(t),{origin}=fixture;
  assert.equal((await fetch(origin+'/api/online/status')).status,401);
  assert.equal((await fetch(origin+'/api/online/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'incorrect'})})).status,401);
  const ws=connect(origin,'');
  const status=await new Promise(resolve=>ws.once('unexpected-response',(_req,response)=>{resolve(response.statusCode);response.destroy();}));
  assert.equal(status,403);assert.equal(fixture.renders,0);
});
test('the server assigns seats and prevents input spoofing across players',async t=>{
  const {app,origin}=await setup(t);
  const first=connect(origin,await session(origin));const a=await message(first,d=>d.type==='welcome');
  const second=connect(origin,await session(origin));const b=await message(second,d=>d.type==='welcome');
  assert.equal(a.slot,0);assert.equal(b.slot,1);
  const host=new WebSocket(origin.replace('http:','ws:')+'/host-socket',{headers:{Origin:origin}});host.on('error',()=>{});
  await new Promise(resolve=>host.once('open',resolve));
  let next=message(host,d=>d.type==='host-authorized');host.send(JSON.stringify({type:'host-auth',token:app.room.hostToken}));await next;
  app.room.phase='playing';
  next=message(host,d=>d.type==='input');
  first.send(JSON.stringify({type:'input',slot:3,sequence:0,buttons:1,pressed:1,x:1,y:0}));
  const input=await next;assert.equal(input.slot,0);assert.equal(input.buttons,1);
  next=message(host,d=>d.type==='input');
  first.send(JSON.stringify({type:'input',slot:3,sequence:1,buttons:0,x:0,y:0,mouse:true,px:2,py:.5}));
  first.send(JSON.stringify({type:'input',slot:3,sequence:1,buttons:2,x:0,y:0,mouse:true,px:.25,py:.75}));
  const pointer=await next;assert.equal(pointer.slot,0);assert.equal(pointer.mouse,true);assert.equal(pointer.px,.25);assert.equal(pointer.py,.75);assert.equal(pointer.buttons,2);
  next=message(host,d=>d.type==='input');
  second.send(JSON.stringify({type:'input',slot:0,sequence:0,buttons:1,x:0,y:0,mouse:true,px:.8,py:.2}));
  const other=await next;assert.equal(other.slot,1);assert.equal(other.px,.8);assert.equal(other.py,.2);
  next=message(host,d=>d.type==='stream-quality');
  first.send(JSON.stringify({type:'stream-quality',peerId:b.peerId,level:99}));
  first.send(JSON.stringify({type:'stream-quality',peerId:b.peerId,level:2}));
  const quality=await next;assert.equal(quality.peerId,a.peerId);assert.equal(quality.level,2);
  assert.equal(app.room.seats[0].streamLevel,2);assert.equal(app.room.seats[1].streamLevel,undefined);
  const status=await fetch(origin+'/api/online/status',{headers:{Cookie:await session(origin)}}).then(r=>r.text());
  assert.ok(!status.includes(app.room.hostToken));
  next=message(host,d=>d.type==='input'&&!d.connected);first.close();const released=await next;assert.equal(released.slot,0);assert.equal(released.buttons,0);
});
test('a fifth player is refused and malformed input cannot crash the server',async t=>{
  const {origin}=await setup(t);const clients=[];
  for(let i=0;i<4;i++){const ws=connect(origin,await session(origin));await message(ws,d=>d.type==='welcome');clients.push(ws);}
  const fifth=connect(origin,await session(origin));assert.match((await message(fifth,d=>d.type==='error')).message,/房间已满/);
  const closed=new Promise(resolve=>clients[0].once('close',code=>resolve(code)));clients[0].send('null');assert.equal(await closed,4002);
  assert.equal((await fetch(origin+'/healthz')).status,200);
});
test('cross-origin requests fail and logging out revokes an existing connection',async t=>{
  const {origin}=await setup(t);const cookie=await session(origin);
  assert.equal((await fetch(origin+'/api/online/status',{headers:{Cookie:cookie,Origin:'https://untrusted.example'}})).status,403);
  const ws=connect(origin,cookie);await message(ws,d=>d.type==='welcome');const closed=new Promise(resolve=>ws.once('close',resolve));
  assert.equal((await fetch(origin+'/api/online/session',{method:'DELETE',headers:{Cookie:cookie,Origin:origin}})).status,200);
  assert.equal(await closed,4001);assert.equal((await fetch(origin+'/api/online/status',{headers:{Cookie:cookie}})).status,401);
});
test('logging in again with a valid cookie retains the same reserved seat',async t=>{
  const {app,origin}=await setup(t);const cookie=await session(origin);
  const first=connect(origin,cookie);const welcome=await message(first,d=>d.type==='welcome');
  const disconnected=new Promise(resolve=>first.once('close',resolve));first.close();await disconnected;
  const response=await fetch(origin+'/api/online/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:JSON.stringify({key})});
  assert.equal(response.status,200);const nextCookie=response.headers.get('set-cookie').split(';')[0];assert.equal(nextCookie,cookie);
  const second=connect(origin,nextCookie);assert.equal((await message(second,d=>d.type==='welcome')).slot,welcome.slot);
  assert.equal(app.room.clients.size,1);
});

test('explicit logout immediately frees even a disconnected reservation',async t=>{
  const {app,origin}=await setup(t);const cookies=[];
  for(let i=0;i<4;i++){
    const cookie=await session(origin);cookies.push(cookie);
    const ws=connect(origin,cookie);await message(ws,d=>d.type==='welcome');
    if(i===0){const closed=new Promise(resolve=>ws.once('close',resolve));ws.close();await closed;}
  }
  assert.equal(app.room.clients.size,4);
  await fetch(origin+'/api/online/session',{method:'DELETE',headers:{Cookie:cookies[0],Origin:origin}});
  assert.equal(app.room.clients.size,3);
  const next=connect(origin,await session(origin));assert.equal((await message(next,d=>d.type==='welcome')).slot,0);
});

test('replaced transports reject stale signaling in both directions and release old input',async t=>{
  const {app,origin}=await setup(t),cookie=await session(origin);
  const first=connect(origin,cookie);const old=await message(first,d=>d.type==='welcome');
  const host=new WebSocket(origin.replace('http:','ws:')+'/host-socket',{headers:{Origin:origin}});
  await new Promise(resolve=>host.once('open',resolve));
  let next=message(host,d=>d.type==='host-authorized');host.send(JSON.stringify({type:'host-auth',token:app.room.hostToken}));await next;
  next=message(host,d=>d.type==='input'&&!d.connected);
  const second=connect(origin,cookie);const current=await message(second,d=>d.type==='welcome');
  assert.equal((await next).slot,0);assert.equal(current.slot,old.slot);assert.notEqual(current.transportId,old.transportId);
  next=message(host,d=>d.type==='signal');
  second.send(JSON.stringify({type:'signal',transportId:old.transportId,sdp:{type:'answer',sdp:'stale'}}));
  second.send(JSON.stringify({type:'signal',transportId:current.transportId,sdp:{type:'answer',sdp:'current'}}));
  assert.equal((await next).sdp.sdp,'current');
  next=message(second,d=>d.type==='signal');
  host.send(JSON.stringify({type:'signal',peerId:current.peerId,transportId:old.transportId,sdp:{type:'offer',sdp:'stale'}}));
  host.send(JSON.stringify({type:'signal',peerId:current.peerId,transportId:current.transportId,sdp:{type:'offer',sdp:'current'}}));
  assert.equal((await next).sdp.sdp,'current');
});

test('a refused fifth connection cannot cancel an empty room idle shutdown',async t=>{
  const {app,origin}=await setup(t,{idleMs:100,reconnectMs:10000});
  for(let i=0;i<4;i++){
    const ws=connect(origin,await session(origin));await message(ws,d=>d.type==='welcome');
    const closed=new Promise(resolve=>ws.once('close',resolve));ws.close();await closed;
  }
  const fifth=connect(origin,await session(origin));assert.match((await message(fifth,d=>d.type==='error')).message,/房间已满/);
  await new Promise(resolve=>setTimeout(resolve,180));
  assert.equal(app.room.state,'idle');assert.equal(app.room.clients.size,0);assert.equal(app.room.renderer,null);
});

test('web lobby validates own profile, unlocked choices, readiness and owner start',async t=>{
  const {app,origin}=await setup(t);
  const first=connect(origin,await session(origin));await message(first,d=>d.type==='welcome');
  const second=connect(origin,await session(origin));await message(second,d=>d.type==='welcome');
  app.room.state='ready';app.room.deities=[{id:0,name:'test',unlocked:true},{id:1,name:'locked',unlocked:false}];
  app.room.gameStatus={lobbyPhase:'selecting',lobbyReady:false,lobbyRevision:app.room.lobbyRevision};
  let next=message(first,d=>d.type==='error');first.send(JSON.stringify({type:'lobby-profile',slot:1,name:'我',tag:'ONE',deity:1}));assert.match((await next).message,/未解锁/);
  next=message(first,d=>d.type==='room'&&d.players[0].tag==='ONE');first.send(JSON.stringify({type:'lobby-profile',slot:1,name:'我',tag:'ONE',deity:0}));await next;
  assert.equal(app.room.seats[1].tag,'P02');
  next=message(second,d=>d.type==='error');second.send(JSON.stringify({type:'lobby-profile',name:'朋友',tag:'ONE',deity:0}));assert.match((await next).message,/已被使用/);
  next=message(second,d=>d.type==='error');second.send(JSON.stringify({type:'lobby-start'}));assert.match((await next).message,/只有房主/);
  for(const ws of [first,second]){next=message(ws,d=>d.type==='room');ws.send(JSON.stringify({type:'lobby-ready',ready:true}));await next;}
  assert.equal(app.room.canStart(),false);
  next=message(first,d=>d.type==='error');first.send(JSON.stringify({type:'lobby-profile',name:'我',tag:'TWO',deity:0}));assert.match((await next).message,/取消准备/);
  app.room.gameStatus.lobbyReady=true;app.room.gameStatus.lobbyRevision=app.room.lobbyRevision-1;assert.equal(app.room.canStart(),false);
  app.room.gameStatus.lobbyRevision=app.room.lobbyRevision;assert.equal(app.room.canStart(),true);
  next=message(first,d=>d.type==='room'&&d.phase==='starting');first.send(JSON.stringify({type:'lobby-start'}));await next;
  assert.equal(app.room.canStart(),false);
  const newcomer=connect(origin,await session(origin));assert.match((await message(newcomer,d=>d.type==='error')).message,/对局已开始/);
});

test('lobby disconnect clears ready and transfers owner, reconnect retains role choices',async t=>{
  const {app,origin}=await setup(t),cookie=await session(origin);
  const first=connect(origin,cookie);await message(first,d=>d.type==='welcome');
  const second=connect(origin,await session(origin));await message(second,d=>d.type==='welcome');
  app.room.seats[0].ready=true;app.room.seats[0].tag='ABC';
  const update=message(second,d=>d.type==='room'&&d.ownerSlot===1);first.close();await update;
  assert.equal(app.room.seats[0].ready,false);assert.equal(app.room.canStart(),false);
  const returning=connect(origin,cookie);const welcome=await message(returning,d=>d.type==='welcome');
  assert.equal(welcome.slot,0);assert.equal(app.room.seats[0].tag,'ABC');assert.equal(app.room.seats[0].ready,false);
});
