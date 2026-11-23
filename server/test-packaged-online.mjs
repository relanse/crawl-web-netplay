import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {observeWorld} from './test/world-observer.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),release=path.resolve(process.argv[2]);
const output=path.join(here,'test-results/netplay/package-'+new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(output,{recursive:true});console.log('Packaged acceptance: '+output);
const launch=(...flags)=>new Promise((resolve,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(release,'start-network.ps1'),'-NoBrowser',...flags],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('exit',code=>code?reject(Error(stderr||'Launcher failed: '+code)):resolve());
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,message,timeout=90_000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(300);}throw Error(message);}
const data=path.join(release,'server/online-data'),frame=p=>p.frames().find(f=>f.url().endsWith('/game.html'));
async function game(p){try{return await frame(p)?.evaluate(()=>window.__crawlTransportProbe??null);}catch{return null;}}
const linux=process.argv.includes('--linux-wsl');
const pages=[];let browser,stage='local launcher',origin,checks=[],failure;
try{
  let key;
  if(linux){
    origin='https://crawl.localhost';
    key=execFileSync('wsl.exe',['-d','Ubuntu','-u','root','--','cat','/etc/crawl-online/access-key'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  }else{
  await launch();const local=JSON.parse(await fs.readFile(path.join(data,'launcher.json'),'utf8'));
  assert.equal((await fetch(local.origin+'/health')).status,200);await launch('-Stop');
  checks.push('Bundled Node starts and stops through Windows PowerShell without installed Node or Python');
  stage='public launcher';await launch('-Public');const state=JSON.parse(await fs.readFile(path.join(data,'launcher.json'),'utf8'));origin=state.origin;
  assert.match(origin,/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
  key=(await fs.readFile(path.join(data,'access-key.txt'),'utf8')).trim();
  }
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const ping=await browser.newPage({ignoreHTTPSErrors:linux});
  await until(async()=>{try{const reply=await ping.goto(origin+'/health',{timeout:8000});return reply?.ok()&&(await reply.json()).ok;}catch{return false;}},'Public hostname did not become reachable',60000);
  await ping.close();checks.push(linux?'Linux HTTPS reverse proxy reaches the packaged server (local QA certificate)':'Public HTTPS uses a browser-trusted certificate and reaches the packaged server');
  const errors=[],world=observeWorld();
  for(let i=0;i<2;i++){
    const context=await browser.newContext({ignoreHTTPSErrors:linux,viewport:{width:1280,height:900}}),page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
    if(i===0)page.on('websocket',s=>{if(s.url().includes('/game/'))s.on('framereceived',e=>{if(!world.latest?.palettes.length)world.receive(e.payload);});});
    await page.goto(origin);await page.locator('#key').fill(key);await page.locator('#login').click();await page.locator('#create').waitFor({state:'visible'});
    await until(async()=>await page.locator('#connection').textContent()==='大厅已连接','Public lobby did not connect');
  }
  const [a,b]=pages;stage='public match';await a.locator('#create').click();await a.locator('#code').waitFor({state:'visible'});
  const code=await a.locator('#code').textContent();await b.locator('#room-code').fill(code);await b.locator('#join-form button').click();
  for(const p of pages)await until(async()=>await p.locator('.player:not(.empty)').count()===2,'Join has not reached both players');
  for(const p of pages){
    await until(async()=>await p.locator('#ready').isEnabled(),'Ready control unavailable');
    await p.locator('#ready').click();
    for(const other of pages)await until(async()=>await other.locator('.status.ready').count()===pages.indexOf(p)+1,'Readiness did not propagate');
  }
  await until(async()=>await a.locator('#start').isEnabled(),'Public players not ready');await a.screenshot({path:path.join(output,'lobby.png'),fullPage:true});await a.locator('#start').click();
  await until(async()=>{const states=await Promise.all(pages.map(game));const bad=states.find(s=>s?.worldError);if(bad)throw Error(bad.worldError);return states.every(s=>s?.canControl&&s.worldFrames>2);},'Public game failed to become playable',300_000);
  await sleep(7000);await frame(b).locator('canvas').click();const before=await game(b);
  await frame(b).evaluate(()=>{
    const initial=window.__crawlTransportProbe;
    const measure=window.qaMove={};
    window.addEventListener('keydown',()=>{const start=performance.now();const update=({detail})=>{
      if(measure.visualMs===undefined&&Math.abs(detail.displayedX-initial.displayedX)>.25)measure.visualMs=performance.now()-start;
      if(measure.authorityMs===undefined&&Math.abs(detail.worldX1-initial.worldX1)>.25)measure.authorityMs=performance.now()-start;
      if(measure.authorityMs!==undefined&&measure.visualMs!==undefined)window.removeEventListener('crawl-state',update);
    };window.addEventListener('crawl-state',update);},{once:true});
  });
  await b.keyboard.down('ArrowRight');
  await until(async()=>Math.abs((await game(b)).worldX1-before.worldX1)>.25,'Public keyboard did not reach the authority',10_000);await b.keyboard.up('ArrowRight');
  await fs.writeFile(path.join(output,'movement.json'),JSON.stringify(await frame(b).evaluate(()=>({...window.qaMove,roundTripMs:window.__crawlTransportProbe.roundTripMs}))));
  assert.ok(world.latest.palettes.length>0);assert.equal((await game(a)).worldError,'');
  await frame(a).locator('canvas').screenshot({path:path.join(output,'world.png')});
  checks.push('Two independent browsers join and control the packaged native game over WSS');
  stage='public refresh';const prior=await game(b);await b.reload();await until(async()=>{const s=await game(b);return s?.canControl&&s.epoch>prior.epoch;},'Public refresh failed',90_000);
  assert.equal((await game(b)).playerId,prior.playerId);assert.deepEqual(errors,[]);checks.push('Public browser refresh restores the same identity and seat');
  for(const p of pages)await p.evaluate(()=>fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));
}catch(error){await fs.writeFile(path.join(output,'diagnostic.json'),JSON.stringify(await Promise.all(pages.map(async p=>({ui:(await p.locator('body').innerText().catch(()=>'' )).slice(-800),game:await game(p)}))),null,2));failure=error;console.error(stage+': '+error.message);process.exitCode=1;}
finally{
  await browser?.close();if(!linux)await launch('-Stop').catch(error=>{failure??=error;process.exitCode=1;});
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:!failure,stage,origin,checks,error:failure?.stack},null,2));
}
if(!failure)console.log('Packaged acceptance passed: '+checks.length+' checks; launcher stopped cleanly.');
