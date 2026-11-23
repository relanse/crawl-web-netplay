import {chromium} from 'playwright-core';
import {createCrawlServer} from './server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory=path.resolve('test-results/web-lobby');await fs.mkdir(directory,{recursive:true});
process.env.DATA_DIRECTORY=path.join(directory,'host-profile');
const key='web-lobby-test-key-12345678',app=createCrawlServer({key,publicOrigin:'',iceServers:[]});
const origin=await app.listen(0);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const pages=[],errors=[],checks=[];
try{
  for(let i=0;i<4;i++){
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();pages.push(page);
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);
    if(i===0){await page.screenshot({path:path.join(directory,'home-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(directory,'home-mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:1000});}
    await page.locator('#online-name').fill(['蓝色','地牢好友','夜行者','第四位朋友'][i]);
    await page.locator('#online-key').fill(key);await page.locator('#online-join').click();
    await page.waitForFunction(()=>window.crawlOnlineStatus?.game?.lobbyPhase==='selecting'&&window.crawlOnline?.peer?.connectionState==='connected',null,{timeout:120000});
    await page.waitForFunction(()=>!document.querySelector('#lobby-ready').disabled,null,{timeout:30000});
    const deity=await page.evaluate(()=>window.crawlOnlineStatus.deities.find(d=>d.unlocked&&!d.trial)?.id);assert.ok(Number.isInteger(deity));
    await page.locator('#lobby-tag').fill(['SUN','MON','OWL','FOX'][i]);
    if(i<2)await page.locator('#lobby-deity').selectOption(String(deity));
    await page.locator('#lobby-save').click();await page.waitForFunction(()=>!document.querySelector('#lobby-ready').disabled);
  }
  checks.push('four users auto-enter original selection with web nickname/tag/deity, no menu key sequences');
  assert.equal(app.room.ownerSlot,0);assert.equal(app.room.canStart(),false);
  await pages[1].evaluate(()=>window.crawlOnline.command({type:'lobby-start'}));
  await pages[1].waitForFunction(()=>document.querySelector('#online-state').textContent.includes('只有房主'));checks.push('non-owner start denied');
  await pages[0].locator('#lobby-ready').click();await pages[0].waitForFunction(()=>window.crawlOnlineStatus.players.find(p=>p.slot===0)?.ready);
  await pages[0].locator('#lobby-ready').click();await pages[0].waitForFunction(()=>!window.crawlOnlineStatus.players.find(p=>p.slot===0)?.ready);
  app.room.seats[1].socket.terminate();await pages[1].waitForFunction(()=>window.crawlOnline.peer?.connectionState!=='connected');
  await pages[1].waitForFunction(()=>window.crawlOnline.peer?.connectionState==='connected',null,{timeout:30000});
  assert.equal(app.room.seats[1].tag,'MON');assert.equal(app.room.seats[1].ready,false);checks.push('cancel ready and same-seat reconnect preserve selections');
  await pages[0].setViewportSize({width:390,height:844});await pages[0].screenshot({path:path.join(directory,'lobby-mobile.png'),fullPage:true});
  assert.ok(await pages[0].evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await pages[0].setViewportSize({width:1440,height:1000});
  for(const page of pages)await page.locator('#lobby-ready').click();
  await pages[0].waitForFunction(()=>window.crawlOnlineStatus?.canStart===true,null,{timeout:40000});
  assert.equal(app.room.gameStatus.controllers.filter(x=>x>=0&&x<4).length,4);
  assert.deepEqual(app.room.gameStatus.playerNames,['SUN','MON','OWL','FOX']);
  for(let i=0;i<2;i++)assert.equal(app.room.gameStatus.playerDeities[i],app.room.seats[i].deity);
  await pages[0].screenshot({path:path.join(directory,'lobby-ready.png'),fullPage:true});await app.room.renderer.page.screenshot({path:path.join(directory,'engine-ready.png')});
  checks.push('four web ready flags synchronize to original Ready state');
  await pages[0].locator('#lobby-start').click();await pages[0].waitForFunction(()=>window.crawlOnlineStatus?.phase==='playing',null,{timeout:30000});
  for(let i=0;i<25&&app.room.gameStatus.scene!=='SceneGame';i++){await pages[0].locator('video').focus();await pages[0].keyboard.press('x',{delay:100});await pages[0].waitForTimeout(600);}
  assert.equal(app.room.gameStatus.scene,'SceneGame');assert.equal(app.room.gameStatus.active.filter(Boolean).length,4);assert.equal(await pages[0].locator('#web-lobby').isVisible(),false);
  checks.push('owner starts original four-player SceneGame');
  await pages[0].waitForTimeout(18000);
  const positions=[];
  for(let i=0;i<4;i++){
    const page=pages[i];await page.bringToFront();await page.locator('video').focus();
    const before=[app.room.gameStatus.playerX[i],app.room.gameStatus.playerY[i]];
    await page.keyboard.down(i%2?'ArrowLeft':'ArrowRight');await page.waitForTimeout(1400);await page.keyboard.up(i%2?'ArrowLeft':'ArrowRight');
    await page.waitForTimeout(1100);const after=[app.room.gameStatus.playerX[i],app.room.gameStatus.playerY[i]];
    assert.ok(Math.hypot(after[0]-before[0],after[1]-before[1])>2,JSON.stringify({slot:i,before,after}));
    positions.push({slot:i,before,after});
  }
  const presses=app.room.gameStatus.inputDiagnostics.reads;
  for(const page of pages){await page.bringToFront();await page.locator('video').focus();await page.keyboard.press('x',{delay:150});}
  await pages[0].waitForTimeout(1200);assert.ok(app.room.gameStatus.inputDiagnostics.reads>presses);
  checks.push('four independent controllers move and attack after web start');await pages[0].screenshot({path:path.join(directory,'game-four.png'),fullPage:true});assert.equal(errors.length,0);
  const report={passed:true,checks,errors,players:app.room.publicState().players,game:app.room.gameStatus,positions};await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){
  await fs.writeFile(path.join(directory,'failure.json'),JSON.stringify({error:String(error),errors,room:app.room.publicState()},null,2));
  for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:path.join(directory,`failure-${i}.png`),fullPage:true}).catch(()=>{});
  if(app.room.renderer)await app.room.renderer.page.screenshot({path:path.join(directory,'engine-failure.png')}).catch(()=>{});throw error;
}finally{await browser.close();await app.close();}
