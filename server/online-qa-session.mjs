import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createCrawlServer} from './server.mjs';
const directory=path.resolve('test-results/live');await fs.mkdir(directory,{recursive:true});
process.env.DATA_DIRECTORY=path.join(directory,'host-profile');
const app=createCrawlServer({key:process.env.CRAWL_ACCESS_KEY,publicOrigin:'',iceServers:[],idleMs:120000});
const origin=await app.listen(0);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const players=[];const errors=[];let lastId=null;
const save=async id=>{
  const media=[];
  for(const {page} of players)media.push(await page.evaluate(async()=>{
    const pc=window.crawlOnline?.peer;if(!pc)return null;
    const stats=await pc.getStats();return {slot:window.crawlOnline.slot,connection:pc.connectionState,lastInput:window.crawlOnlineLastInput,video:[document.querySelector('video').videoWidth,document.querySelector('video').videoHeight],tracks:[...stats.values()].filter(s=>s.type==='inbound-rtp').map(s=>({kind:s.kind,bytesReceived:s.bytesReceived,framesDecoded:s.framesDecoded,framesPerSecond:s.framesPerSecond}))};
  }).catch(()=>null));
  await fs.writeFile(path.join(directory,'status.json'),JSON.stringify({id,origin,room:app.room.publicState(),media,errors},null,2));
};
try{
  for(let i=0;i<4;i++){
    const context=await browser.newContext({viewport:{width:1280,height:1100}});const page=await context.newPage();
    page.on('pageerror',error=>errors.push({player:i,error:error.message}));
    await page.goto(origin);await page.locator('#online-panel summary').click();
    await page.locator('#online-key').fill(process.env.CRAWL_ACCESS_KEY);await page.locator('#online-name').fill('测试玩家'+(i+1));
    await page.locator('#online-join').click();
    await page.waitForFunction(()=>window.crawlOnline?.peer?.connectionState==='connected',null,{timeout:150000});
    await page.waitForFunction(()=>document.querySelector('video').videoWidth>0,null,{timeout:30000});
    players.push({context,page});console.log('Connected player '+(i+1));
  }
  await save('ready');console.log('Four-player QA ready; control via test-results/live/command.json');
  while(true){
    await new Promise(resolve=>setTimeout(resolve,150));
    let command;try{command=JSON.parse(await fs.readFile(path.join(directory,'command.json'),'utf8'));}catch{continue;}
    if(command.id===lastId)continue;lastId=command.id;
    try{
      for(const action of command.actions||[]){
        const page=players[action.player??0].page;
        if(action.pointer){const box=await page.locator('video').boundingBox();await page.mouse.move(box.x+box.width*action.pointer[0],box.y+box.height*action.pointer[1]);}
        if(action.mouse){await page.mouse.down({button:action.mouse});await page.waitForTimeout(action.ms||160);await page.mouse.up({button:action.mouse});}
        if(action.hold){await page.locator('video').focus();await page.keyboard.down(action.hold);await page.waitForTimeout(action.ms||200);await page.keyboard.up(action.hold);}
        if(action.wait)await page.waitForTimeout(action.wait);
        if(action.click)await page.locator(action.click).click();
        if(action.reload){await page.reload();await page.locator('#online-panel summary').click();await page.locator('#online-key').fill(process.env.CRAWL_ACCESS_KEY);await page.locator('#online-join').click();await page.waitForFunction(()=>window.crawlOnline?.peer?.connectionState==='connected',null,{timeout:30000});}
        if(action.dropConnection){await page.evaluate(()=>window.crawlOnline.socket.close(4009,'测试断线'));await page.waitForTimeout(3500);await page.waitForFunction(()=>window.crawlOnline?.peer?.connectionState==='connected',null,{timeout:30000});}
        if(action.dropHost){app.room.host.close();await page.waitForTimeout(3500);await page.waitForFunction(()=>window.crawlOnline?.peer?.connectionState==='connected',null,{timeout:30000});}
        if(action.screenshot)await page.screenshot({path:path.join(directory,action.screenshot)});
        if(action.videoShot)await page.locator('video').screenshot({path:path.join(directory,action.videoShot)});
      }
      await save(command.id);console.log('Finished QA command '+command.id);
    }catch(error){errors.push({command:command.id,error:error.message});await save(command.id);}
    if(command.close)break;
  }
}finally{await browser.close();await app.close();}
