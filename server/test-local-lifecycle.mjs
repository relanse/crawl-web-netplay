import {chromium} from 'playwright-core';
import {createCrawlServer} from './server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const app=createCrawlServer({key:'local-lifecycle-test-key-123',publicOrigin:'',iceServers:[]});
const origin=await app.listen(0);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--mute-audio']});
const errors=[],runs=[];
try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.testUrls=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{const url=create(blob);window.testUrls.add(url);return url;};
    URL.revokeObjectURL=url=>{window.testUrls.delete(url);return revoke(url);};
  });
  await page.goto(origin);
  for(let i=0;i<2;i++){
    await page.locator('#start').click();
    await page.waitForFunction(()=>window.crawlInstance&&window.crawlRuntimeStatus,null,{timeout:120000});
    await page.evaluate(()=>{
      window.pointerCalls=0;const instance=window.crawlInstance,send=instance.SendMessage.bind(instance);
      instance.SendMessage=(target,method,value)=>{if(method==='SetLocalPointer')window.pointerCalls++;return send(target,method,value);};
    });
    await page.locator('canvas').dispatchEvent('pointerup',{button:0,clientX:400,clientY:350});
    assert.equal(await page.evaluate(()=>window.pointerCalls),1);
    const urlsBefore=await page.evaluate(()=>window.testUrls.size);assert.ok(urlsBefore>=2);
    await page.evaluate(()=>window.stopCrawlLocal());
    assert.equal(await page.evaluate(()=>window.crawlInstance),null);
    assert.equal(await page.evaluate(()=>window.testUrls.size),0);
    assert.equal(await page.locator('#start').isVisible(),true);
    runs.push({pointerHandlers:1,resourceUrlsBefore:urlsBefore,resourceUrlsAfter:0});
  }
  assert.equal(errors.length,0);
  await fs.mkdir('test-results/logic',{recursive:true});
  const report={passed:true,runs,errors};await fs.writeFile('test-results/logic/local-lifecycle.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await app.close();}
