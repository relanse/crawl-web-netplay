import assert from 'node:assert/strict';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {JoinTickets} from './join-tickets.mjs';

// Isolated authority/input/world-presentation test. Production lobby, prediction,
// audio and complete gameplay coverage are separate acceptance work.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const productionClient=process.argv.includes('--client');
const web=path.join(root,'analysis/netplay',productionClient?'network-client':'web-transport-probe');
const executable=path.join(root,'analysis/netplay/windows-probe/CrawlAuthorityProbe.exe');
await fs.access(executable);await fs.access(path.join(web,productionClient?'client-build.json':'probe-build.json'));
const nativeBuild=JSON.parse(await fs.readFile(path.join(path.dirname(executable),'build-report.json')));
const webBuild=JSON.parse(await fs.readFile(path.join(web,productionClient?'client-build.json':'probe-build.json')));
assert.equal(nativeBuild.result,'Succeeded');if(productionClient)assert.equal(webBuild.kind,'client');else assert.equal(webBuild.result,'Succeeded');
assert.match(nativeBuild.contentHash??'',/^[a-f0-9]{64}$/,'Rebuild the native probe with a source content fingerprint');
assert.equal(webBuild.contentHash,nativeBuild.contentHash,'Native and WebGL builds contain different shared source/resources; rebuild both');
const output=path.join(root,'server/test-results/netplay/transport-'+new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(output,{recursive:true});
console.log('Mirror input probe directory: '+output);
const useTls=process.argv.includes('--tls');
const files=await fs.readdir(path.join(web,'Build'));
const find=suffix=>{const found=files.find(f=>f.endsWith(suffix)||f.endsWith(suffix+'.br'));if(!found)throw Error('Missing '+suffix);return 'Build/'+found;};
const build={loader:find('.loader.js'),data:find('.data'),framework:find('.framework.js'),wasm:find('.wasm')};
const pageHtml=`<!doctype html><meta charset="utf-8"><title>Crawl transport test only</title><canvas id="game" width="640" height="360"></canvas><script src="${build.loader}"></script><script>window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));createUnityInstance(document.querySelector('canvas'),{dataUrl:'${build.data}',frameworkUrl:'${build.framework}',codeUrl:'${build.wasm}',streamingAssetsUrl:'StreamingAssets',companyName:'CrawlTest',productName:'TransportProbe',productVersion:'1',showBanner:(m,t)=>{if(t==='error')window.errors.push(m)}}).then(i=>window.instance=i).catch(e=>window.errors.push(String(e)));</script>`;
const identity=()=>randomBytes(16).toString('hex');
const binding={roomId:identity(),matchId:identity(),processLeaseId:identity(),releaseId:'transport-probe-v1'};
const contentHash=nativeBuild.contentHash,players=[identity(),identity()];
const secret=randomBytes(32).toString('base64url'),tickets=new JoinTickets();
let redemptions=0,child,browser,childExit,commandId=0,stage='startup';
const issues=[],consoleLines=[],pages=[],nativeMovement=[];
function authorize(req){const value=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+secret);return value.length===expected.length&&timingSafeEqual(value,expected);}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url==='/redeem'){
      if(req.method!=='POST'||!authorize(req)){res.writeHead(403).end();return;}
      let bytes=0;const chunks=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>4096){res.writeHead(413).end();return;}chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString());
      for(const key of ['roomId','matchId','processLeaseId','releaseId'])if(body[key]!==binding[key]){res.writeHead(403).end();return;}
      let value;try{value=tickets.redeem(body.ticket,binding,r=>players.includes(r.playerId));}catch{res.writeHead(403).end();return;}
      redemptions++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({playerId:value.playerId,slot:value.slot}));return;
    }
    if(req.method!=='GET'){res.writeHead(405).end();return;}
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(pageHtml);return;}
    const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1);
    const filename=path.resolve(web,relative);
    if(!filename.startsWith(web+path.sep)){res.writeHead(403).end();return;}
    const data=await fs.readFile(filename);
    const decoded=filename.replace(/\.br$/,'');if(filename.endsWith('.br'))res.setHeader('Content-Encoding','br');
    res.setHeader('Content-Type',decoded.endsWith('.wasm')?'application/wasm':decoded.endsWith('.js')?'text/javascript':'application/octet-stream');
    res.end(data);
  }catch(error){res.writeHead(error.code==='ENOENT'?404:400).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const controlBase='http://127.0.0.1:'+server.address().port;
let base=controlBase,tlsServer;
const proxySockets=new Set();
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
if(useTls){
  // Disposable test certificate; trust is relaxed only in this isolated QA
  // browser. This does not install a CA or claim public certificate validity.
  const keyFile=path.join(output,'test-tls-key.pem'),certFile=path.join(output,'test-tls-cert.pem');
  const openssl=process.env.OPENSSL_PATH??(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
  execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{windowsHide:true,stdio:'ignore',timeout:15_000});
  tlsServer=https.createServer({key:await fs.readFile(keyFile),cert:await fs.readFile(certFile)},server.listeners('request')[0]);
  tlsServer.on('upgrade',(request,socket,head)=>{
    if(request.url!=='/game/'+binding.matchId||request.headers.origin!==base){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    socket.pause();const upstream=net.connect(port,'127.0.0.1');socket.setNoDelay(true);upstream.setNoDelay(true);proxySockets.add(socket);proxySockets.add(upstream);
    socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
    socket.on('close',()=>{proxySockets.delete(socket);upstream.destroy();});
    upstream.on('close',()=>{proxySockets.delete(upstream);socket.destroy();});
    upstream.on('connect',()=>{
      upstream.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+request.headers['sec-websocket-key']+'\r\nSec-WebSocket-Version: 13\r\n\r\n');
      if(head.length)upstream.write(head);
      socket.pipe(upstream);upstream.pipe(socket);
    });
  });
  await new Promise(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));
  base='https://127.0.0.1:'+tlsServer.address().port;
}
const endpoint=useTls?base.replace('https:','wss:')+'/game/'+binding.matchId:'ws://127.0.0.1:'+port;
await fs.writeFile(path.join(output,'run-context.json'),JSON.stringify({
  transport:useTls?'HTTPS + WSS through loopback TLS reverse proxy':'HTTP + direct loopback WS',
  certificate:useTls?'Ephemeral self-signed certificate; trust relaxed only in isolated test browser':'none',
  nativeBuild,webBuild
},null,2));
await fs.copyFile(fileURLToPath(import.meta.url),path.join(output,'test-harness.mjs'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function command(inputs=[],quit=false,options={}){const temporary=path.join(output,'command.tmp');await fs.writeFile(temporary,JSON.stringify({...options,id:++commandId,inputs,quit}));for(let attempt=0;;attempt++)try{await fs.rename(temporary,path.join(output,'command.json'));break;}catch(error){if(attempt>=10)throw error;await sleep(20);}}
async function waitFor(test,timeout,message){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await test())return;await sleep(150);}throw Error(message);}
async function nativeStatus(){
  const deadline=Date.now()+2500;
  for(let attempt=0;;attempt++)try{return JSON.parse(await fs.readFile(path.join(output,'status.json')));}
  catch(error){
    // Windows replacement/scanner locks can outlast one 250 ms report period.
    // Always read a fresh file; never turn an old cached state into a pass.
    if(Date.now()>=deadline||!['EBUSY','EPERM','EACCES','ENOENT'].includes(error.code))throw error;
    await sleep(Math.min(100,25+attempt*10));
  }
}
async function input(page,x=0,y=0,buttons=0){await page.evaluate(value=>window.instance.SendMessage('CrawlGameSession','SetProbeInput',JSON.stringify(value)),{x,y,buttons});}
async function configure(page,slot,{ticket,releaseId=binding.releaseId,expectedHash=contentHash,attemptEarlyInput=false}={}){
  const issued=ticket??tickets.issue({...binding,playerId:players[slot],slot}).ticket;
  await page.evaluate(config=>window.instance.SendMessage('CrawlGameSession','Configure',JSON.stringify(config)),{endpoint,releaseId,contentHash:expectedHash,matchId:binding.matchId,ticket:issued,attemptEarlyInput});
  return issued;
}
let failure;
try{
  child=spawn(executable,['-batchmode','-force-d3d11','-screen-width','1280','-screen-height','720','-logFile',path.join(output,'player.log')],{cwd:output,windowsHide:true,stdio:'ignore',env:{...process.env,CRAWL_SERVER_DATA:output,CRAWL_GAME_PORT:String(port),CRAWL_CONTROL_URL:controlBase+'/redeem',CRAWL_CONTROL_SECRET:secret,CRAWL_ROOM_ID:binding.roomId,CRAWL_MATCH_ID:binding.matchId,CRAWL_PROCESS_LEASE:binding.processLeaseId,CRAWL_RELEASE_ID:binding.releaseId,CRAWL_CONTENT_HASH:contentHash}});
  child.on('exit',(code,signal)=>childExit={code,signal});child.on('error',error=>childExit={error:String(error)});
  await waitFor(async()=>{if(childExit)throw Error('Native server exited');try{const state=JSON.parse(await fs.readFile(path.join(output,'status.json')));return state.scene==='SceneGame';}catch{return false;}},45_000,'Native game did not load');
  const chrome=process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser=await chromium.launch({headless:true,executablePath:chrome,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
  async function newPage(){stage='loading WebGL page '+pages.length;const context=await browser.newContext({viewport:{width:660,height:400},ignoreHTTPSErrors:useTls});const page=await context.newPage();pages.push(page);page.on('pageerror',error=>issues.push(String(error)));page.on('console',message=>{if(consoleLines.length<200)consoleLines.push({type:message.type(),text:message.text().slice(0,1500)});});await page.goto(base);await page.waitForFunction(()=>window.instance,null,{timeout:90_000});return page;}
  const first=await newPage(),second=await newPage();
  const ticket=await configure(first,0,{attemptEarlyInput:true});await configure(second,1);
  stage='waiting for authenticated binary frames';
  await Promise.all([first,second].map(page=>page.waitForFunction(()=>window.__crawlTransportProbe?.frames>=5,null,{timeout:20_000})));
  stage='installing actual map, actors and sprite geometry before control';
  await Promise.all([first,second].map(page=>page.waitForFunction(()=>{
    const s=window.__crawlTransportProbe;return s?.canControl&&s.worldFrames>=2&&s.worldSprites>2&&s.worldRooms>0&&s.worldEntities>2&&s.worldActorSprites0>0&&s.worldActorSprites1>0;
  },null,{timeout:30_000})));
  assert.equal(redemptions,2);
  await waitFor(async()=>{
    const state=await nativeStatus();
    return state.actors.slice(0,2).every(a=>a.state&&a.state!=='Cutscene'&&a.state!=='Spawn');
  },70_000,'Original intro did not finish');
  await sleep(300);
  const initial=await first.evaluate(()=>window.__crawlTransportProbe);
  assert.ok(!initial.worldError);assert.equal(initial.earlyInputRefused,true,'Gameplay input was not rejected before world installation');
  await first.locator('canvas').screenshot({path:path.join(output,'world-initial.png')});
  assert.ok(initial.worldActorSprites0>0&&initial.worldActorSprites1>0,'World snapshot omitted a player sprite');
  assert.equal(initial.slot,0);assert.equal(initial.epoch,1);
  stage='browser input controls only its authenticated native actor';
  const direction=initial.x0>0?-1:1;
  await input(first,direction);
  for(let i=0;i<20;i++){await sleep(120);nativeMovement.push(await nativeStatus());}
  await input(first);await sleep(500);
  const moved=await first.evaluate(()=>window.__crawlTransportProbe);
  assert.ok(Math.abs(moved.x0-initial.x0)>2,'Browser input did not move its native actor');
  assert.ok(Math.abs(moved.x1-initial.x1)<2,'Player zero moved the other actor');
  assert.ok(moved.appliedInput>0&&moved.receivedInput>=moved.appliedInput,'Input execution ACK missing or ahead of receipt');
  const observed=await second.evaluate(()=>window.__crawlTransportProbe);
  assert.ok(Math.abs(observed.x0-moved.x0)<2,'Other browser did not receive movement');
  assert.ok(Math.abs(moved.worldX0-moved.x0)<2&&Math.abs(observed.worldX0-moved.x0)<2,'Installed world replicas did not follow the native actor');
  stage='independent player and input timeout';
  await input(second,initial.x1>0?-1:1);await sleep(1200);await input(second);await sleep(400);
  const secondMoved=await second.evaluate(()=>window.__crawlTransportProbe);
  assert.ok(Math.abs(secondMoved.x1-initial.x1)>2,'Second browser could not control its own actor');
  await input(first,-direction);await sleep(350);
  await first.evaluate(()=>window.instance.SendMessage('CrawlGameSession','SetProbeInputEnabled','0'));
  await sleep(650);
  const timeoutState=await nativeStatus();
  assert.equal(timeoutState.actors[0].rawX,0,'Stalled input was held beyond 250 ms');
  await sleep(350);const stopped=await nativeStatus();
  assert.ok(Math.abs(stopped.actors[0].x-timeoutState.actors[0].x)<2,'Actor kept moving after timeout');
  await input(first);await first.evaluate(()=>window.instance.SendMessage('CrawlGameSession','SetProbeInputEnabled','1'));
  stage='browser attack runs original animation attack callback';
  const attacksBefore=(await nativeStatus()).attackCallbacks;
  for(let i=0;i<6;i++){await input(first,0,0,1);await sleep(180);await input(first);await sleep(220);}
  await sleep(400);
  assert.ok((await nativeStatus()).attackCallbacks>attacksBefore,'Browser action did not reach original attack animation');
  console.log('Both players moved independently; input timeout and original attack callback passed.');
  stage='pause keeps network clock alive and discards queued attacks';
  await waitFor(async()=>['Idle','Move'].includes((await nativeStatus()).actors[0].state),8000,'Attack did not settle before pause test');
  await command([],false,{setPaused:true,paused:true});
  await waitFor(async()=>(await nativeStatus()).paused,3000,'Authority did not pause');
  const pausedBefore=await nativeStatus(),pausedFrames=(await first.evaluate(()=>window.__crawlTransportProbe)).frames;
  for(let i=0;i<4;i++){await input(first,1,0,1);await sleep(120);await input(first);await sleep(150);}
  const pausedAfter=await nativeStatus();
  assert.ok(pausedAfter.netTick>pausedBefore.netTick+20,'Network clock stopped while game was paused');
  assert.equal(pausedAfter.simTick,pausedBefore.simTick,'Simulation clock advanced while paused');
  assert.equal(pausedAfter.attackCallbacks,pausedBefore.attackCallbacks,'Attack ran during pause');
  assert.ok((await first.evaluate(()=>window.__crawlTransportProbe)).frames>pausedFrames+2,'Network stopped during pause');
  await command([],false,{setPaused:true,paused:false});await sleep(800);
  const resumed=await nativeStatus();assert.equal(resumed.paused,false);
  assert.ok(resumed.simTick>pausedAfter.simTick,'Simulation did not resume');
  assert.equal(resumed.attackCallbacks,pausedAfter.attackCallbacks,'Paused attacks replayed after resume');
  stage='malformed and forged input is rejected without moving either actor';
  await first.evaluate(()=>window.instance.SendMessage('CrawlGameSession','SetProbeInputEnabled','0'));await sleep(400);
  const rejectionBefore=await nativeStatus();
  const otherEntity=(await second.evaluate(()=>window.__crawlTransportProbe)).entityId;
  const rejected=[];
  for(const [kind,code] of [['entity','OWNERSHIP_MISMATCH'],['epoch','STALE_CONNECTION'],['nan','INPUT_VALUE'],['buttons','INPUT_VALUE'],['expired','INPUT_EXPIRED'],['future','INPUT_TOO_FAR_AHEAD']]){
    const count=(await first.evaluate(()=>window.__crawlTransportProbe)).rejectedInputs;
    await first.evaluate(value=>window.instance.SendMessage('CrawlGameSession','SendProbeInvalid',JSON.stringify(value)),{kind,entityId:otherEntity});
    await first.waitForFunction(before=>window.__crawlTransportProbe.rejectedInputs>before,count,{timeout:4000});
    const actual=(await first.evaluate(()=>window.__crawlTransportProbe)).lastRejection;assert.equal(actual,code);rejected.push({kind,code:actual});
  }
  const rejectionAfter=await nativeStatus();
  for(let slot=0;slot<2;slot++)assert.ok(Math.abs(rejectionAfter.actors[slot].x-rejectionBefore.actors[slot].x)<2,'Rejected input moved actor '+slot);
  stage='20 fps authority preserves one-tick taps across multiple physics steps';
  await command([],false,{frameRate:20});await sleep(600);
  const lowFrameBefore=await nativeStatus(),lowFrameSamples=[];
  const tapRejections=(await first.evaluate(()=>window.__crawlTransportProbe)).rejectedInputs;
  for(let i=0;i<3;i++){
    await waitFor(async()=>['Idle','Move'].includes((await nativeStatus()).actors[0].state),8000,'Actor not ready for short tap');
    const beforeTap=await nativeStatus();
    const observation={beforeTap};lowFrameSamples.push(observation);
    await first.evaluate(()=>window.instance.SendMessage('CrawlGameSession','SendProbeTap',''));
    await fs.writeFile(path.join(output,'physics-taps.json'),JSON.stringify(lowFrameSamples,null,2));
    await waitFor(async()=>{
      const client=await first.evaluate(()=>window.__crawlTransportProbe);
      if(client.rejectedInputs>tapRejections)throw Error('Valid one-tick tap rejected: '+client.lastRejection);
      return (await nativeStatus()).deliveredEdges[0]>beforeTap.deliveredEdges[0];
    },4000,'One-tick tap was lost between physics steps');
    await waitFor(async()=>(await nativeStatus()).attackCallbacks>beforeTap.attackCallbacks,4000,'One-tick tap did not reach original attack logic');
    await sleep(300);const afterTap=await nativeStatus();
    assert.equal(afterTap.deliveredEdges[0],beforeTap.deliveredEdges[0]+1,'Tap edge repeated across physics steps');
    observation.afterTap=afterTap;
    await fs.writeFile(path.join(output,'physics-taps.json'),JSON.stringify(lowFrameSamples,null,2));
  }
  const lowFrameAfter=await nativeStatus();
  assert.ok(lowFrameAfter.simTick-lowFrameBefore.simTick>(lowFrameAfter.frame-lowFrameBefore.frame)*1.5,'Test did not exercise multiple physics steps per frame');
  assert.equal((await first.evaluate(()=>window.__crawlTransportProbe)).rejectedInputs,tapRejections,'Valid short tap was rejected');
  await command([],false,{frameRate:60});await sleep(400);
  await first.evaluate(()=>window.instance.SendMessage('CrawlGameSession','SetProbeInputEnabled','1'));
  console.log('Pause/resume, invalid input rejection and three one-tick taps at 20 fps passed.');
  await first.locator('canvas').screenshot({path:path.join(output,'world-after-actions.png')});
  await second.locator('canvas').screenshot({path:path.join(output,'world-second-player.png')});
  const replay=await newPage();await configure(replay,0,{ticket});
  await replay.waitForFunction(()=>window.__crawlTransportProbe?.error,null,{timeout:10_000});assert.equal(redemptions,2);await replay.close();
  const mismatch=await newPage();await configure(mismatch,0,{releaseId:'wrong-version'});
  await mismatch.waitForFunction(()=>window.__crawlTransportProbe?.error,null,{timeout:10_000});assert.equal(redemptions,2);await mismatch.close();
  const wrongContent=await newPage();
  await configure(wrongContent,0,{expectedHash:(contentHash[0]==='a'?'b':'a')+contentHash.slice(1)});
  await wrongContent.waitForFunction(()=>window.__crawlTransportProbe?.error==='VERSION_MISMATCH',null,{timeout:10_000});
  assert.equal(redemptions,2,'Browser redeemed a ticket with mismatched built content');await wrongContent.close();
  const replacement=await newPage();await configure(replacement,0);
  stage='replacement delivers terminal reason to old connection with input still in flight';
  await replacement.waitForFunction(()=>window.__crawlTransportProbe?.frames>=3&&window.__crawlTransportProbe?.canControl,null,{timeout:30_000});
  assert.equal((await replacement.evaluate(()=>window.__crawlTransportProbe)).epoch,2);
  await first.waitForFunction(()=>window.__crawlTransportProbe?.error==='SESSION_REPLACED',null,{timeout:10_000});
  assert.equal((await first.evaluate(()=>window.__crawlTransportProbe)).authenticated,false);
  stage='replacement owns input after old disconnect';
  const rejoined=await replacement.evaluate(()=>window.__crawlTransportProbe);
  await input(replacement,rejoined.x0>0?-1:1);await sleep(1200);await input(replacement);await sleep(400);
  assert.ok(Math.abs((await replacement.evaluate(()=>window.__crawlTransportProbe)).x0-rejoined.x0)>2,'Replacement lost input ownership');
  stage='original evolution menu survives scene and control changes';
  const previousScene=rejoined.sceneEpoch;
  await command([],false,{evolve:true});
  await waitFor(async()=>{
    const values=await Promise.all([replacement,second].map(p=>p.evaluate(()=>window.__crawlTransportProbe)));
    return values.every(s=>s.menu&&s.canControl&&s.sceneEpoch>previousScene&&s.worldTexts>0);
  },30_000,'Evolution scene did not install with menu input permission');
  await waitFor(async()=>(await nativeStatus()).menus.filter(s=>s.endsWith(':Menu')).length>=2,30_000,'Original evolution menus did not become ready');
  await replacement.locator('canvas').screenshot({path:path.join(output,'world-evolution-menu.png')});
  for(let i=0;i<2;i++){
    await input(replacement,0,0,2);await input(second,0,0,2);await sleep(200);
    await input(replacement);await input(second);await sleep(450);
  }
  await waitFor(async()=>{
    const s=await replacement.evaluate(()=>window.__crawlTransportProbe);
    return !s.menu&&s.canControl&&s.entityId>0&&s.sceneEpoch>previousScene+1;
  },40_000,'Evolution confirmation did not return control to the next game scene');
  const states=await Promise.all([second,replacement].map(page=>page.evaluate(()=>({state:window.__crawlTransportProbe,errors:window.errors}))));
  assert.equal(states.flatMap(s=>s.errors).length,0);assert.equal(issues.length,0);
  const finalNative=await nativeStatus();assert.equal(finalNative.exceptions,0);
  assert.ok(finalNative.headlessCommitFrames>0&&finalNative.spriteManagers>0,'Headless geometry boundary was not running');
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,scope:'Two real WebGL Unity runtimes send scheduled authenticated input to native authority; actual map and gameplay-free sprite replicas; production lobby, prediction, audio and full content acceptance remain separate',checks:['matching shared source/resource hashes from actual native and WebGL builds','actual room/entity/sprite state installed in both browsers before control','gameplay input refused before world installation','replacement waits for world installation and catch-up before control','one-use ticket redemption','two independent WebGL connections','each browser controls only its bound native actor','movement is broadcast to both browsers','received and applied input acknowledgments','250 ms input timeout releases movement while socket stays open','browser action executes original animation attack callback','network clock continues and simulation clock stops during original game pause','paused attacks do not replay on resume','forged entity and epoch, NaN, unknown buttons, expired and far future inputs refused','three one-tick attack taps survive multiple physics steps per frame at 20 fps without duplicate edges','replay refused','version mismatch refused before redemption','browser refuses a content hash different from its embedded build before ticket redemption','replacement increments epoch, delivers SESSION_REPLACED and controls actor','native runtime has no exceptions','headless geometry commits remain active without a graphics device'],initial,moved,secondMoved,timeoutState,pausedBefore,pausedAfter,resumed,rejected,lowFrameBefore,lowFrameAfter,lowFrameSamples,states,redemptions,finalNative},null,2));
}catch(error){failure=error;const states=await Promise.all(pages.filter(p=>!p.isClosed()).map(p=>p.evaluate(()=>({ready:!!window.instance,state:window.__crawlTransportProbe,errors:window.errors})).catch(()=>null)));await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({error:String(error),stage,states,issues,consoleLines,childExit,redemptions,nativeMovement},null,2));}
finally{await browser?.close();if(child&&!childExit){await command([],true).catch(()=>{});await waitFor(()=>childExit,5000,'exit').catch(()=>{});if(!childExit)child.kill();}for(const socket of proxySockets)socket.destroy();if(tlsServer)await new Promise(resolve=>tlsServer.close(resolve));await new Promise(resolve=>server.close(resolve));}
if(failure)throw failure;
console.log('Mirror transport feasibility passed: '+path.join(output,'result.json'));
