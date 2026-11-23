import {chromium} from 'playwright-core';
import {createCrawlServer} from './server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
const label=process.argv[2]||'sample',dir=path.resolve('test-results/performance',label);
await fs.mkdir(dir,{recursive:true});process.env.DATA_DIRECTORY=path.join(dir,'profile');
const app=createCrawlServer({key:'performance-test-key-123456',publicOrigin:'',iceServers:[]}),origin=await app.listen(0);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--enable-gpu','--mute-audio','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
const pages=[],errors=[];
async function received(page){return page.evaluate(async()=>{const stats=await window.crawlOnline.peer.getStats();return [...stats.values()].filter(r=>r.type==='inbound-rtp'||(r.type==='candidate-pair'&&r.state==='succeeded')).map(r=>({...r}));});}
async function sent(){return app.room.renderer.page.evaluate(async()=>({now:Date.now(),frame:window.crawlRuntimeStatus?.frame,peers:await Promise.all([...window.crawlHostPeers.values()].map(async p=>({parameters:p.pc.getSenders().find(s=>s.track?.kind==='video')?.getParameters(),stats:[...(await p.pc.getStats()).values()].filter(r=>r.type==='outbound-rtp').map(r=>({...r}))})))}));}
try{
  for(let i=0;i<4;i++){
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.locator('#online-key').fill('performance-test-key-123456');await page.locator('#online-join').click();
    await page.waitForFunction(()=>!document.querySelector('#lobby-ready').disabled,null,{timeout:120000});
    await page.locator('#lobby-ready').click();
  }
  await pages[0].waitForFunction(()=>window.crawlOnlineStatus.canStart,null,{timeout:30000});await pages[0].locator('#lobby-start').click();
  await pages[0].waitForFunction(()=>window.crawlOnlineStatus.phase==='playing',null,{timeout:30000});
  for(let i=0;i<25&&app.room.gameStatus.scene!=='SceneGame';i++){await pages[0].locator('video').focus();await pages[0].keyboard.press('x',{delay:90});await pages[0].waitForTimeout(600);}
  await pages[0].waitForTimeout(18000);
  const gpu=await app.room.renderer.page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);});
  await app.room.renderer.page.evaluate(()=>{
    window.perfInputs=[];const game=window.crawlInstance,send=game.SendMessage.bind(game);
    game.SendMessage=(object,method,value)=>{if(method==='SetState'){const data=JSON.parse(value);if(data.slot===0&&data.mouse)window.perfInputs.push({at:Date.now(),px:data.px});}return send(object,method,value);};
  });
  const start=await Promise.all(pages.map(received)),hostStart=await sent(),frameStart={at:Date.now(),frame:app.room.gameStatus.frame};
  await pages[0].bringToFront();await pages[0].locator('video').focus();
  const inputs=await pages[0].evaluate(async()=>{
    const video=document.querySelector('video'),rect=video.getBoundingClientRect(),events=[];
    const width=Math.min(rect.width,rect.height*(video.videoWidth/video.videoHeight));
    for(let i=0;i<80;i++){
      const px=.35+i*.001,event=new PointerEvent('pointermove',{clientX:rect.left+rect.width*px,clientY:rect.top+rect.height*.5,bubbles:true});
      events.push({at:Date.now(),px:(event.clientX-rect.left-(rect.width-width)/2)/width});video.dispatchEvent(event);
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    return events;
  });
  await pages[0].waitForTimeout(5000);
  const end=await Promise.all(pages.map(received)),hostEnd=await sent(),frameEnd={at:Date.now(),frame:app.room.gameStatus.frame};
  const arrived=await app.room.renderer.page.evaluate(()=>window.perfInputs),delays=[];
  for(const event of inputs){const match=arrived.find(a=>Math.abs(a.px-event.px)<.00001);if(match)delays.push(match.at-event.at);}
  delays.sort((a,b)=>a-b);
  const summary=end.map((stats,i)=>{const b=start[i].find(s=>s.type==='inbound-rtp'&&s.kind==='video'),e=stats.find(s=>s.type==='inbound-rtp'&&s.kind==='video'),seconds=(e.timestamp-b.timestamp)/1000,frames=e.framesDecoded-b.framesDecoded,emitted=e.jitterBufferEmittedCount-b.jitterBufferEmittedCount;return {fps:frames/seconds,width:e.frameWidth,height:e.frameHeight,kbps:(e.bytesReceived-b.bytesReceived)*8/seconds/1000,jitterBufferMs:emitted?(e.jitterBufferDelay-b.jitterBufferDelay)/emitted*1000:null,decodeMs:frames?(e.totalDecodeTime-b.totalDecodeTime)/frames*1000:null,freezeCount:e.freezeCount-b.freezeCount,dropped:e.framesDropped-b.framesDropped,packetsLost:e.packetsLost-b.packetsLost};});
  const result={label,gpu,hostFps:(frameEnd.frame-frameStart.frame)/((frameEnd.at-frameStart.at)/1000),input:{samples:delays.length,meanMs:delays.reduce((s,x)=>s+x,0)/delays.length,p50Ms:delays[Math.floor(delays.length*.5)],p95Ms:delays[Math.floor(delays.length*.95)]},inputs,arrived,viewers:summary,hostStart,hostEnd,start,end,errors};
  await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({label,gpu,hostFps:result.hostFps,input:result.input,viewers:summary,errors}));
}finally{await browser.close();await app.close();}
