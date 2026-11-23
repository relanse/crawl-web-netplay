// Real headless clients, private test room and separate save/profile directories.
import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createCrawlServer} from './server.mjs';
const directory=path.resolve('test-results/logic');await fs.mkdir(directory,{recursive:true});
process.env.DATA_DIRECTORY=path.join(directory,'host-profile');
const key='isolated-logic-test-key-123456';
const app=createCrawlServer({key,publicOrigin:'',iceServers:[]});
const origin=await app.listen(0);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const pages=[],errors=[],checks=[];
const connected=page=>page.waitForFunction(()=>window.crawlOnline?.peer?.connectionState==='connected'&&document.querySelector('video').videoWidth>0,null,{timeout:120000});
const neutral=page=>page.waitForFunction(()=>{const x=window.crawlOnlineLastInput;return x&&x.buttons===0&&x.x===0&&x.y===0&&!x.mouse;});
try{
  for(let i=0;i<4;i++){
    const context=await browser.newContext({viewport:{width:1280,height:1100}}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.locator('#online-panel summary').click();
    await page.locator('#online-key').fill(key);await page.locator('#online-join').click();
    await connected(page);pages.push(page);
  }
  assert.equal(app.room.clients.size,4);checks.push('four authenticated clients receive live video');
  const page=pages[0];await page.bringToFront();await page.locator('video').focus();
  // Press/release actual keys through the original menus, then test transport changes.
  await page.keyboard.down('x');await page.waitForTimeout(180);await page.keyboard.up('x');
  await page.locator('video').focus();
  const sequence=await page.evaluate(()=>window.crawlOnlineLastInput.sequence);
  await page.evaluate(()=>{for(let i=0;i<400;i++)document.querySelector('video').dispatchEvent(new KeyboardEvent('keydown',{code:'KeyX',repeat:true,bubbles:true,cancelable:true}));});
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(before=>window.crawlOnlineLastInput.sequence-before<8,sequence));
  assert.equal(await page.evaluate(()=>window.crawlOnline.socket.readyState),1);checks.push('400 key repeats do not flood or disconnect');
  await page.evaluate(()=>{
    window.testPad={axes:[1,0],buttons:[{pressed:true}]};
    navigator.getGamepads=()=>window.testPad?[window.testPad]:[];
  });
  await page.waitForFunction(()=>window.crawlOnlineLastInput.x===1&&window.crawlOnlineLastInput.buttons===1);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await neutral(page);await page.waitForTimeout(400);await neutral(page);
  checks.push('held gamepad remains neutral after blur');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.locator('#online-name').focus();await neutral(page);
  await page.locator('#online-name').fill('typing');await neutral(page);checks.push('editing a form never controls gameplay');
  await page.evaluate(()=>{window.testPad=null;});await page.locator('video').focus();
  await page.keyboard.down('ArrowRight');await page.waitForFunction(()=>window.crawlOnlineLastInput.x===1);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await neutral(page);
  await page.keyboard.up('ArrowRight');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  checks.push('keyboard release on blur');
  const renderer=app.room.renderer;const originalSlots=await Promise.all(pages.map(p=>p.evaluate(()=>window.crawlOnline.slot)));
  // Simulate media failure while signaling is healthy. Recovery must keep the simulation.
  await page.evaluate(()=>{
    window.oldPeer=window.crawlOnline.peer;
    Object.defineProperty(window.oldPeer,'connectionState',{configurable:true,get:()=> 'failed'});
    window.oldPeer.dispatchEvent(new Event('connectionstatechange'));
  });
  await connected(page);
  assert.equal(app.room.renderer,renderer);assert.deepEqual(await Promise.all(pages.map(p=>p.evaluate(()=>window.crawlOnline.slot))),originalSlots);
  assert.ok(await page.evaluate(()=>window.crawlOnline.peer!==window.oldPeer));checks.push('failed media reconnects into same seat without restarting the game');
  // Real server-side socket termination.
  const slot=originalSlots[0];app.room.seats[slot].socket.terminate();
  await page.waitForFunction(()=>window.crawlOnline.peer?.connectionState!=='connected');await connected(page);
  assert.equal(await page.evaluate(()=>window.crawlOnline.slot),slot);assert.equal(app.room.renderer,renderer);
  checks.push('broken signaling recovers same seat');
  // Real host socket interruption; all four clients must receive fresh negotiations.
  await renderer.page.evaluate(()=>window.crawlHostSocket.close());
  await renderer.page.waitForFunction(()=>window.crawlHostReady===false);
  await renderer.page.waitForFunction(()=>window.crawlHostReady===true);
  for(const client of pages)await connected(client);
  assert.equal(app.room.renderer,renderer);checks.push('host signaling recovers all four streams without resetting the game');
  await page.bringToFront();await page.locator('video').focus();
  const box=await page.locator('video').boundingBox();
  await page.mouse.move(box.x+box.width*.4,box.y+box.height*.5);await page.mouse.down();
  await page.waitForFunction(()=>window.crawlOnlineLastInput.buttons===1);
  await page.mouse.up();await page.waitForFunction(()=>window.crawlOnlineLastInput.buttons===0);
  checks.push('mouse click and release still work after reconnection');
  await page.locator('#online-leave').click();
  await page.waitForFunction(()=>!window.crawlOnline.active&&!document.querySelector('#online-join').disabled);
  assert.equal(app.room.clients.size,3);assert.equal(app.room.seats[slot],null);
  assert.equal(await page.locator('#loading').isVisible(),true);assert.equal(await page.locator('video').isVisible(),false);
  checks.push('explicit leave frees seat immediately and restores local start screen');
  await page.locator('#online-key').fill(key);await page.locator('#online-join').click();await connected(page);
  assert.equal(await page.evaluate(()=>window.crawlOnline.slot),slot);assert.equal(app.room.clients.size,4);
  checks.push('rejoin reuses free seat');
  assert.equal(errors.length,0);
  await page.screenshot({path:path.join(directory,'four-clients.png')});
  const report={passed:true,checks,errors,slots:originalSlots,game:app.room.gameStatus};
  await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await app.close();}
