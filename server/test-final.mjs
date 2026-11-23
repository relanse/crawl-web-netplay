import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createCrawlServer} from './server.mjs';
const directory=path.resolve('test-results/final');await fs.mkdir(directory,{recursive:true});
process.env.DATA_DIRECTORY=path.join(directory,'host-profile');
const app=createCrawlServer({key:process.env.CRAWL_ACCESS_KEY,publicOrigin:'',iceServers:[]});
const origin=await app.listen(0);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const pages=[],errors=[];
try{
  for(let i=0;i<2;i++){
    const context=await browser.newContext({viewport:{width:1280,height:1100}}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.locator('#online-panel summary').click();
    await page.locator('#online-key').fill(process.env.CRAWL_ACCESS_KEY);await page.locator('#online-join').click();
    await page.waitForFunction(()=>window.crawlOnline?.peer?.connectionState==='connected',null,{timeout:120000});
    pages.push(page);
  }
  for(let i=0;i<25;i++){
    const selected=app.room.gameStatus?.active?.[0]?pages[1]:pages[0];
    await selected.locator('video').focus();await selected.keyboard.down('x');await selected.waitForTimeout(180);await selected.keyboard.up('x');await selected.waitForTimeout(600);
    const status=app.room.gameStatus;
    if(status?.active?.filter(Boolean).length>=2&&status.controllers.includes(0)&&status.controllers.includes(1))break;
  }
  const status=app.room.gameStatus;
  assert.ok(status.active.filter(Boolean).length>=2);assert.ok(status.controllers.includes(0)&&status.controllers.includes(1));
  assert.ok(status.inputDiagnostics.presses>0&&status.inputDiagnostics.reads>0);assert.equal(errors.length,0);
  const pointer=[];
  for(let i=0;i<2;i++){
    const page=pages[i],box=await page.locator('video').boundingBox();
    await page.mouse.move(box.x+box.width*(.3+i*.4),box.y+box.height*.5);
    await page.mouse.down({button:i===0?'left':'right'});await page.waitForTimeout(150);
    await page.mouse.up({button:i===0?'left':'right'});await page.waitForTimeout(150);
    const input=await page.evaluate(()=>window.crawlOnlineLastInput);
    assert.equal(input.buttons,0);assert.equal(input.mouse,true);pointer.push(input);
  }
  await pages[0].screenshot({path:path.join(directory,'latest-build.png')});
  await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,status,pointer,errors},null,2));
  console.log('Final WebGL build: authenticated video and two independently assigned original controllers passed.');
}finally{await browser.close();await app.close();}
