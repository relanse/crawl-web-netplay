import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {createOnlineServer} from './online-server.mjs';
import {observeWorld} from './test/world-observer.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const output=path.join(here,'test-results/netplay/online-'+new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(output,{recursive:true});console.log('Online acceptance: '+output);
const key=randomBytes(32).toString('base64url');
const playerCount=process.argv.includes('--four')?4:2,useTls=process.argv.includes('--tls');let tls,publicOrigin='',app;
if(useTls){
  const keyFile=path.join(output,'test-tls-key.pem'),certFile=path.join(output,'test-tls-cert.pem');
  execFileSync('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{windowsHide:true,stdio:'ignore'});
  tls=https.createServer({key:await fs.readFile(keyFile),cert:await fs.readFile(certFile)},(req,res)=>app.server.emit('request',req,res));
  tls.on('upgrade',(req,socket,head)=>app.server.emit('upgrade',req,socket,head));
  await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve));publicOrigin='https://127.0.0.1:'+tls.address().port;
}
app=await createOnlineServer({key,publicOrigin,directory:path.join(output,'matches')});
const origin=await app.listen(0);let browser,stage='login';const checks=[],errors=[],pages=[];
const consoleLines=[];
const traffic=[];
const worldObserver=observeWorld();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,message,timeout=60_000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(200);}throw Error(message);}
async function request(page,route,data){return page.evaluate(async({route,data})=>{const res=await fetch('/api/'+route,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:res.status,body:await res.json()};},{route,data});}
const frame=page=>page.frames().find(f=>f.url().endsWith('/game.html'));
async function game(page){const f=frame(page);if(!f)return null;try{return await f.evaluate(()=>window.__crawlTransportProbe??null);}catch{return null;}}
async function state(page){const value=await request(page,'state');assert.equal(value.status,200);return value.body;}
async function ready(page){await until(async()=>await page.locator('#ready').isEnabled(),'Ready button unavailable');await page.locator('#ready').click();await until(async()=>{const s=await state(page);return s.room.members.find(m=>m.playerId===s.playerId).ready;},'Ready not accepted');}
try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  for(let i=0;i<playerCount;i++){
    const context=await browser.newContext({viewport:{width:1280,height:900},ignoreHTTPSErrors:useTls});const page=await context.newPage();pages.push(page);
    await context.addInitScript(()=>{
      window.__qaAudioStarted=0;window.__qaAudioContexts=[];
      const prototype=window.AudioContext?.prototype;
      if(prototype){const create=prototype.createBufferSource;prototype.createBufferSource=function(...args){if(!window.__qaAudioContexts.includes(this))window.__qaAudioContexts.push(this);const source=create.apply(this,args),start=source.start;source.start=function(...values){window.__qaAudioStarted++;return start.apply(this,values);};return source;};}
    });
    page.on('pageerror',error=>errors.push({player:i,message:error.message}));
    page.on('console',message=>{if(['error','warning'].includes(message.type()))consoleLines.push({player:i,type:message.type(),message:message.text()});});
    traffic[i]={received:0,sent:0};page.on('websocket',socket=>{if(!socket.url().includes('/game/'))return;socket.on('framereceived',event=>{traffic[i].received+=Buffer.byteLength(event.payload);if(i===0)worldObserver.receive(event.payload);});socket.on('framesent',event=>{traffic[i].sent+=Buffer.byteLength(event.payload);});});
    await page.goto(origin);await page.locator('#key').fill(key);await page.locator('#login').click();await page.locator('#create').waitFor({state:'visible'});
    await until(async()=>await page.locator('#connection').textContent()==='大厅已连接','Lobby WS unavailable');
  }
  const [a,b]=pages;
  assert.equal((await request(a,'profile',{revision:1,nickname:'X',tag:'P01'})).status,409);
  stage='lobby';await a.locator('#create').click();await a.locator('#code').waitFor({state:'visible'});
  const code=await a.locator('#code').textContent();for(const page of pages.slice(1)){await page.locator('#room-code').fill(code);await page.locator('#join-form button').click();}
  await until(async()=>(await state(a)).room.members.length===playerCount,'Players did not join');
  await a.locator('#nickname').fill('房主');await a.locator('#tag').fill('RED');await a.locator('#profile-form button').click();
  await until(async()=>(await state(a)).room.members[0].tag==='RED','Profile not saved');
  for(const page of pages)await ready(page);const lobby=await state(a);
  const denied=await request(b,'start',{revision:lobby.room.revision,requestId:crypto.randomUUID()});assert.equal(denied.status,409);assert.equal(denied.body.code,'NOT_OWNER');
  await a.screenshot({path:path.join(output,'lobby.png'),fullPage:true});checks.push('Two authenticated identities, room create/join, profile, readiness, non-owner start refused');
  stage='load';await until(async()=>await a.locator('#start').isEnabled(),'Start button disabled');await a.locator('#start').click();
  await until(async()=>{const values=await Promise.all(pages.map(game));const failed=values.find(s=>s?.worldError||(s?.error&&s.error!=='DISCONNECTED'));if(failed)throw Error(failed.worldError||failed.error);return values.every(s=>s?.canControl&&s.worldFrames>=2);},'Game failed to reach playable world',100_000);
  await until(async()=>(await state(a)).room.phase==='Running','Lobby did not publish the native loading barrier');
  const live=await state(a),record=app.processes.matches.get(live.room.matchId);assert.equal(live.room.phase,'Running');assert.ok(record);assert.equal(record.status.exceptions,0);
  const initial=await Promise.all(pages.map(game));assert.notEqual(initial[0].playerId,initial[1].playerId);assert.notEqual(initial[0].slot,initial[1].slot);
  for(const value of initial){assert.ok(value.worldSprites>2&&value.worldRooms>0&&value.worldEntities>2);assert.ok(value.worldTexts>0&&value.worldCameras>=2,'Original HUD text and cameras missing');assert.ok(!value.worldError);}
  await until(()=>record.status.actors.slice(0,playerCount).every(actor=>actor.state&&actor.state!=='Cutscene'),'Opening cutscene did not finish',40_000);
  const metering={started:Date.now(),...traffic[0]};
  await fs.writeFile(path.join(output,'world-inspection.json'),JSON.stringify(worldObserver.latest,null,2));
  assert.ok(worldObserver.latest.palettes.length>0,'Authoritative player palettes were lost');
  for(const entity of worldObserver.latest.actors.filter(Boolean))assert.ok(worldObserver.latest.sprites.some(s=>s.entity===entity&&s.palette>0),'Controlled hero has no palette');
  assert.ok(worldObserver.latest.sprites.filter(s=>s.clipped).every(s=>s.texture>3),'Clipped HUD sprite lost its atlas');
  await frame(a).locator('canvas').screenshot({path:path.join(output,'world.png')});checks.push('Real production native process, load barrier, opening cutscene, two full replicas and control grants');
  stage='input';const before=await game(b);await frame(b).locator('canvas').click();
  await frame(b).evaluate(x=>{let start;window.addEventListener('keydown',()=>{start=performance.now();},{once:true});window.addEventListener('crawl-state',event=>{if(start&&window.__movementMs===undefined&&Math.abs(event.detail.displayedX-x)>.25)window.__movementMs=performance.now()-start;});},before.displayedX);
  await b.keyboard.down('ArrowRight');
  await until(async()=>Math.abs((await game(b)).worldX1-before.worldX1)>.25,'Keyboard movement did not reach authority',5000);const delay=await frame(b).evaluate(()=>window.__movementMs);
  await b.keyboard.up('ArrowRight');const movementSamples=[delay];
  for(let sample=0;sample<6;sample++){
    await sleep(300);const startX=(await game(b)).displayedX,key=sample%2?'ArrowRight':'ArrowLeft';
    await frame(b).evaluate(x=>{
      window.__qaMovement={start:null,ms:null};
      window.addEventListener('keydown',()=>window.__qaMovement.start=performance.now(),{once:true});
      const handler=event=>{const s=window.__qaMovement;if(s.start!==null&&Math.abs(event.detail.displayedX-x)>.25){s.ms=performance.now()-s.start;window.removeEventListener('crawl-state',handler);}};
      window.addEventListener('crawl-state',handler);
    },startX);
    await b.keyboard.down(key);await until(async()=>await frame(b).evaluate(()=>window.__qaMovement.ms!==null),'Repeated movement did not reach the rendered world',5000);
    movementSamples.push(await frame(b).evaluate(()=>window.__qaMovement.ms));await b.keyboard.up(key);
  }
  await b.keyboard.press('KeyJ');await sleep(450);
  const moved=await Promise.all(pages.map(game));assert.ok(Math.abs(moved[0].worldX1-moved[1].worldX1)<3);checks.push('Browser keyboard reaches native simulation and both rendered replicas');
  const audio=[];for(const page of pages){await frame(page).locator('canvas').click();await until(async()=>await frame(page).evaluate(()=>window.__qaAudioStarted>0&&window.__qaAudioContexts.some(context=>context.state==='running')),'Browser audio did not start',5000);audio.push(await frame(page).evaluate(()=>({starts:window.__qaAudioStarted,running:window.__qaAudioContexts.some(context=>context.state==='running')})));}
  checks.push('Authoritative audio creates playing browser Web Audio sources after canvas interaction');
  stage='refresh';const epoch=initial[1].epoch,identity=initial[1].playerId;await b.reload();
  await until(async()=>{const s=await game(b);return s?.canControl&&s.epoch>epoch;},'Refresh did not restore the same seat',75_000);
  assert.equal((await game(b)).playerId,identity);assert.equal((await game(b)).slot,initial[1].slot);assert.equal((await state(b)).room.matchId,live.room.matchId);
  checks.push('Browser refresh keeps identity, match and seat; newer connection epoch restores world before control');
  stage='network-drop';const reconnectEpoch=(await game(b)).epoch;
  await b.context().setOffline(true);await sleep(1400);await b.context().setOffline(false);
  await until(async()=>{const s=await game(b);return s?.canControl&&s.epoch>reconnectEpoch;},'Network interruption did not reconnect',75_000);
  checks.push('Network interruption automatically reconnects the original seat');
  stage='leave';const leave=await request(b,'leave',{});assert.equal(leave.status,200);assert.equal((await request(b,'ticket',{})).status,409);
  await until(async()=>!record.status.players.find(p=>p.playerId===identity).connected,'Abandoned player remains connected');
  await until(()=>record.status.actors[initial[1].slot].bot,'Abandoned seat did not transfer to the original AI');
  assert.ok((await game(a)).canControl);checks.push('Explicit leave revokes game socket and tickets without dropping the other player');
  checks.push('Original game AI takes over the explicitly abandoned seat');
  assert.deepEqual(errors,[]);assert.equal(record.status.exceptions,0);
  const seconds=(Date.now()-metering.started)/1000;
  const final=await game(a),rates={sampleSeconds:seconds,downBytesPerSecond:(traffic[0].received-metering.received)/seconds,upBytesPerSecond:(traffic[0].sent-metering.sent)/seconds};
  stage='process-crash';record.child.kill();
  await until(async()=>(await state(a)).room.phase==='Failed','Native crash did not reach the lobby');
  await a.locator('#return').click();
  await until(async()=>(await state(a)).room.phase==='Lobby','Owner could not return to lobby after native crash');
  assert.equal(app.processes.matches.size,0);
  assert.equal((await state(a)).room.matchId,null);
  assert.ok((await state(a)).room.members.every(member=>!member.ready&&!member.abandoned));
  checks.push('Native process failure is reported; owner returns remaining players to a clean lobby');
  stage='new-match';await b.locator('#room-code').fill(code);await b.locator('#join-form button').click();
  await until(async()=>(await state(a)).room.members.length===playerCount,'Previous player could not join the next round');
  for(const page of pages)await ready(page);await a.locator('#start').click();
  await until(async()=>{const values=await Promise.all(pages.map(game));return values.every(s=>s?.canControl)&&((await state(a)).room.matchId!==live.room.matchId);},'Fresh match did not start after returning to lobby',100_000);
  const restarted=await state(a),nextRecord=app.processes.matches.get(restarted.room.matchId);
  assert.ok(nextRecord);assert.equal(nextRecord.status.exceptions,0);
  checks.push('The same room starts a fresh native match, including the player who left the previous round');
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,playerCount,tls:useTls,checks,inputObservedMs:delay,movementSamplesMs:movementSamples,audio,traffic:rates,initial,final,exceptions:record.status.exceptions},null,2));
  console.log('Online acceptance passed: '+checks.length+' checks; observed movement '+delay+' ms');
}catch(error){
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:false,stage,error:error.stack,checks,errors,consoleLines,games:await Promise.all(pages.map(game)),processes:[...app.processes.matches.values()].map(r=>({matchId:r.matchId,status:r.status,exited:r.exited,exitCode:r.exitCode}))},null,2));
  for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:path.join(output,'failure-'+i+'.png'),fullPage:true}).catch(()=>{});
  console.error(stage+': '+error.stack);process.exitCode=1;
}finally{await browser?.close();await app.close();if(tls){tls.closeAllConnections();await new Promise(resolve=>tls.close(resolve));}}
