import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const output=path.resolve('test-results');await fs.mkdir(output,{recursive:true});
const origin=process.env.PUBLIC_ORIGIN||'http://127.0.0.1:8787';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,
  args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const report={errors:[],steps:[]};
try{
  async function player(name){
    const context=await browser.newContext({viewport:{width:1280,height:1000}});const page=await context.newPage();
    page.on('pageerror',error=>report.errors.push({player:name,error:error.message}));
    await page.goto(origin);await page.locator('#online-panel summary').click();
    await page.locator('#online-key').fill(process.env.CRAWL_ACCESS_KEY);await page.locator('#online-name').fill(name);
    await page.locator('#online-join').click();
    await page.waitForFunction(()=>window.crawlOnline?.peer?.connectionState==='connected',null,{timeout:150000});
    await page.waitForFunction(()=>document.querySelector('video').videoWidth>0,null,{timeout:30000});
    return {context,page};
  }
  const a=await player('测试甲');report.steps.push('player 1 authenticated and received WebRTC video');console.log(report.steps.at(-1));
  const b=await player('测试乙');report.steps.push('player 2 authenticated and received WebRTC video');console.log(report.steps.at(-1));
  assert.equal(await a.page.evaluate(()=>window.crawlOnline.slot),0);assert.equal(await b.page.evaluate(()=>window.crawlOnline.slot),1);
  const before=await a.page.evaluate(async()=>await fetch('/api/online/status').then(r=>r.json()));
  report.before=before;
  for(const [name,entry] of [['player-one',a],['player-two',b]]){
    await entry.page.screenshot({path:path.join(output,name+'.png')});
    const stats=await entry.page.evaluate(async()=>{const stats=await window.crawlOnline.peer.getStats();return [...stats.values()].filter(s=>s.type==='inbound-rtp').map(s=>({kind:s.kind,bytesReceived:s.bytesReceived,framesDecoded:s.framesDecoded}));});
    assert.ok(stats.some(s=>s.kind==='video'&&s.bytesReceived>0));report[name]=stats;
  }
  await a.page.locator('video').focus();await a.page.keyboard.down('Enter');await a.page.waitForTimeout(250);await a.page.keyboard.up('Enter');
  await a.page.waitForTimeout(1800);
  report.after=await a.page.evaluate(async()=>await fetch('/api/online/status').then(r=>r.json()));
  await a.page.screenshot({path:path.join(output,'after-first-input.png')});
  await fs.writeFile(path.join(output,'online-browser-report.json'),JSON.stringify(report,null,2));
  console.log('Two-player WebRTC test passed. Game state: '+report.after.game?.scene);
}catch(error){report.failure=error.stack;await fs.writeFile(path.join(output,'online-browser-report.json'),JSON.stringify(report,null,2));throw error;}
finally{await browser.close();}
