import {chromium} from 'playwright-core';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

export async function launchRenderer(config){
  const software=process.env.CRAWL_RENDERER==='software';
  try{return await launchRendererOnce(config,software);}
  catch(error){
    if(software||config.signal?.aborted)throw error;
    console.warn('Default renderer failed; retrying with software WebGL:',error.message);
    return launchRendererOnce(config,true);
  }
}
async function launchRendererOnce({origin,token,iceServers,icePolicy,dataDirectory,executablePath,signal,room},software){
  await mkdir(dataDirectory,{recursive:true});
  const context=await chromium.launchPersistentContext(path.join(dataDirectory,'chrome'),{
    headless:true,viewport:{width:1280,height:720},deviceScaleFactor:1,
    ...(executablePath?{executablePath}:{}),
    args:[...(software?['--use-angle=swiftshader']:['--enable-gpu']),'--enable-unsafe-swiftshader','--mute-audio',
      '--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling',
      '--disable-renderer-backgrounding','--disable-features=WebRtcHideLocalIpsWithMdns']
  });
  const page=context.pages()[0]||await context.newPage();
  const abort=()=>context.close().catch(()=>{});
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){await context.close();throw new Error('Renderer startup cancelled');}
  try{
    const rendererName=await page.evaluate(()=>{
      const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2');
      if(!gl)return '';
      const ext=gl.getExtension('WEBGL_debug_renderer_info'),name=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
      gl.getExtension('WEBGL_lose_context')?.loseContext();return name;
    });
    if(!rendererName)throw new Error('WebGL 2 is unavailable; try CRAWL_RENDERER=software.');
    const maxFps=room?.tunnelMedia||/swiftshader|llvmpipe|software/i.test(rendererName)?30:60;
    const errors=new Set();
    page.on('console',message=>{if(message.type()==='error'&&!errors.has(message.text())){
      errors.add(message.text());if(errors.size<100)console.error('Renderer:',message.text().slice(0,1800));
    }});
    page.on('pageerror',error=>console.error('Renderer script:',error.message));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      return url.origin===origin||['blob:','data:'].includes(url.protocol)?route.continue():route.abort();
    });
    await page.addInitScript(({token,origin,iceServers,icePolicy,maxFps})=>{
      window.__CRAWL_HOST__={token,origin,iceServers,icePolicy,maxFps};
      const NativeAudioContext=window.AudioContext||window.webkitAudioContext;
      const connect=AudioNode.prototype.connect;
      const disconnect=AudioNode.prototype.disconnect;
      AudioNode.prototype.connect=function(destination,...args){
        if(destination===this.context.destination&&this.context.crawlCaptureDestination)
          connect.call(this,this.context.crawlCaptureDestination,...args);
        return connect.call(this,destination,...args);
      };
      AudioNode.prototype.disconnect=function(...args){
        if(args[0]===this.context.destination&&this.context.crawlCaptureDestination){
          try{disconnect.call(this,this.context.crawlCaptureDestination);}catch{}
        }
        return disconnect.apply(this,args);
      };
      window.AudioContext=new Proxy(NativeAudioContext,{construct(Target,args){
        const context=new Target(...args);
        context.crawlCaptureDestination=context.createMediaStreamDestination();
        window.crawlCaptureAudio=context.crawlCaptureDestination.stream;
        return context;
      }});
      window.webkitAudioContext=window.AudioContext;
    },{token,origin,iceServers,icePolicy,maxFps});
    await page.goto(origin+'/?renderer=1',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.crawlHostReady===true,null,{timeout:120000});
    signal?.removeEventListener('abort',abort);
    const renderer={page,context,async close(){
      try{await page.evaluate(()=>window.crawlInstance?.SendMessage('SystemSave','SaveAllUsers'));await page.waitForTimeout(750);}catch{}
      await context.close();
    }};
    context.on('close',()=>room?.rendererLost(renderer));
    return renderer;
  }catch(error){signal?.removeEventListener('abort',abort);await context.close();throw error;}
}
