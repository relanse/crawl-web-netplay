import {chromium} from 'playwright-core';
import {createCrawlServer} from './server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const software=process.argv.includes('--software'),dir=path.resolve('test-results/stream',software?'software':'gpu');await fs.mkdir(dir,{recursive:true});
if(software)process.env.CRAWL_RENDERER='software';
process.env.DATA_DIRECTORY=path.join(dir,'profile');
const key='stream-profile-test-key-123',app=createCrawlServer({key,publicOrigin:'',iceServers:[]}),origin=await app.listen(0);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--enable-gpu','--mute-audio']});
const pages=[],errors=[],checks=[];
try{
  for(let i=0;i<2;i++){
    const page=await (await browser.newContext({viewport:{width:1440,height:1000}})).newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.locator('#online-key').fill(key);await page.locator('#online-join').click();
    await page.waitForFunction(()=>!document.querySelector('#lobby-ready').disabled,null,{timeout:120000});await page.locator('#lobby-ready').click();
  }
  await pages[0].waitForFunction(()=>window.crawlOnlineStatus.canStart,null,{timeout:30000});await pages[0].locator('#lobby-start').click();
  await pages[0].waitForFunction(()=>window.crawlOnlineStatus.phase==='playing',null,{timeout:30000});
  const page=pages[0],other=pages[1];
  await other.waitForFunction(()=>document.querySelector('video').videoHeight===720,null,{timeout:25000});
  await page.locator('#online-quality').selectOption('smooth');
  await page.waitForFunction(()=>document.querySelector('video').videoHeight===480,null,{timeout:15000});
  assert.equal(app.room.seats[1].streamLevel,0);checks.push('per-player smooth mode changes only own stream to 480p');
  await page.locator('#online-quality').selectOption('clear');
  await page.waitForFunction(()=>document.querySelector('video').videoHeight===720,null,{timeout:15000});checks.push('clear mode restores 720p');
  const config=await app.room.renderer.page.evaluate(()=>({maxFps:window.__CRAWL_HOST__.maxFps,senders:[...window.crawlHostPeers.values()].map(p=>p.pc.getSenders().find(s=>s.track?.kind==='video').getParameters())}));
  assert.equal(config.maxFps,software?30:60);assert.equal(config.senders[0].encodings[0].maxFramerate,software?30:60);
  checks.push(software?'software rendering safely capped at 30 fps':'GPU rendering targets 60 fps');
  if(!software){
    await page.locator('#online-quality').selectOption('auto');
    // Inject sustained loss into statistics only; verify controller changes the real video sender.
    await page.evaluate(()=>{
      const pc=window.crawlOnline.peer,real=pc.getStats.bind(pc);let calls=0;window.originalStats=real;
      pc.getStats=async()=>{const stats=new Map(await real());calls++;for(const [id,r] of stats){if(r.type==='inbound-rtp'&&r.kind==='video')stats.set(id,{...r,packetsLost:(r.packetsLost||0)+calls*2000});}return stats;};
    });
    await page.waitForFunction(()=>window.crawlStreamStats?.mode==='auto'&&window.crawlStreamStats.level>=1&&document.querySelector('video').videoHeight<=540,null,{timeout:30000});
    assert.equal(app.room.seats[1].streamLevel,0);checks.push('simulated loss feedback reduces actual own stream without changing the other player');
    await page.evaluate(()=>{window.crawlOnline.peer.getStats=window.originalStats;});
  }
  await page.locator('#online-quality').selectOption('smooth');await page.waitForFunction(()=>document.querySelector('video').videoHeight===480);
  const renderer=app.room.renderer;app.room.seats[0].socket.terminate();
  await page.waitForFunction(()=>window.crawlOnline.peer?.connectionState!=='connected');
  await page.waitForFunction(()=>window.crawlOnline.peer?.connectionState==='connected'&&document.querySelector('video').videoHeight===480,null,{timeout:30000});
  assert.equal(app.room.renderer,renderer);assert.equal(await page.locator('#online-quality').inputValue(),'smooth');checks.push('reconnect preserves quality preference and original match');
  await page.waitForFunction(()=>window.crawlStreamStats?.fps>0,null,{timeout:10000});
  await page.screenshot({path:path.join(dir,'quality-controls.png'),fullPage:true});
  assert.equal(errors.length,0);
  const report={passed:true,software,checks,config,stats:await page.evaluate(()=>window.crawlStreamStats),errors};await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,software,checks,errors}));
}finally{await browser.close();await app.close();}
