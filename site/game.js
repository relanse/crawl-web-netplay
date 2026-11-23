/* The transport reconstructs byte-identical Unity files. It does not replace game logic. */
"use strict";
let canvas=document.querySelector("#unity-canvas");
const start=document.querySelector("#start");
const loading=document.querySelector("#loading");
const statusText=document.querySelector("#status");
const progress=document.querySelector("#progress");
const fullscreen=document.querySelector("#fullscreen");
const errorText=document.querySelector("#error");
const objectUrls=[];
let instance;
let unbindMouse;
function bindMouse(target){
  unbindMouse?.();
  const listeners=new AbortController();
  const on=(element,type,handler,capture=false)=>element.addEventListener(type,handler,{signal:listeners.signal,capture});
  let buttons=0,pointerFrame=0,pendingPointer;
  unbindMouse=()=>{listeners.abort();cancelAnimationFrame(pointerFrame);};
  const message=(method,value)=>{if(target===canvas&&!window.__CRAWL_HOST__)instance?.SendMessage('CrawlRemoteInput',method,value);};
  const point=event=>{const box=target.getBoundingClientRect();message('SetLocalPointer',JSON.stringify({px:Math.max(0,Math.min(1,(event.clientX-box.left)/box.width)),py:Math.max(0,Math.min(1,(event.clientY-box.top)/box.height)),buttons}));};
  on(target,'contextmenu',event=>event.preventDefault());
  on(target,'mousedown',event=>event.preventDefault());
  on(target,'auxclick',event=>event.preventDefault());
  on(target,'pointerenter',()=>message('SetPointerInside','1'));
  on(target,'pointerleave',()=>{cancelAnimationFrame(pointerFrame);pointerFrame=0;buttons=0;message('SetPointerInside','0');});
  on(target,'pointermove',event=>{pendingPointer=event;if(!pointerFrame)pointerFrame=requestAnimationFrame(()=>{pointerFrame=0;message('SetPointerInside','1');message('SetLocalMode','mouse');point(pendingPointer);});});
  on(target,'pointerdown',event=>{event.preventDefault();target.focus();buttons|=event.button===0?1:event.button===2?2:event.button===1?4:0;message('SetPointerInside','1');message('SetLocalMode','mouse');point(event);instance?.Module?.WebAudio?.audioContext?.resume();});
  on(window,'pointerup',event=>{if(target!==canvas)return;buttons&=~(event.button===0?1:event.button===2?2:event.button===1?4:0);point(event);},true);
  on(window,'pointercancel',()=>{buttons=0;message('SetPointerInside','0');},true);
  on(target,'keydown',event=>{if(/^(Arrow|Key[WASDXZ]|Space|Enter)/.test(event.code))message('SetLocalMode','keyboard');});
  const release=()=>{cancelAnimationFrame(pointerFrame);pointerFrame=0;buttons=0;message('SetPointerInside','0');};
  on(window,'blur',release);
  on(document,'visibilitychange',()=>{if(document.hidden)release();});
}
bindMouse(canvas);
function fail(error){
  console.error(error);
  statusText.textContent="游戏加载失败";
  errorText.hidden=false;
  errorText.textContent="请刷新页面后重试，并检查浏览器是否支持 WebGL 2。错误信息："+String(error.message||error);
  start.hidden=false;start.textContent="重新加载";start.disabled=false;start.onclick=()=>location.reload();
}
function loadScript(url){return new Promise((resolve,reject)=>{const s=document.createElement("script");s.src=url;s.onload=resolve;s.onerror=()=>reject(new Error("无法下载游戏启动文件"));document.head.appendChild(s);});}
async function unpack(entry,onPart){
  const parts=[];
  for(const chunk of entry.chunks){
    const response=await fetch(chunk.url);
    if(!response.ok)throw new Error("游戏资源下载失败（"+response.status+"）");
    const compressed=await response.arrayBuffer();
    const decoded=new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const bytes=await new Response(decoded).arrayBuffer();
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),v=>v.toString(16).padStart(2,"0")).join("");
    if(bytes.byteLength!==chunk.bytes||digest!==chunk.sha256)throw new Error("游戏资源校验失败，请刷新页面重新下载");
    parts.push(bytes);onPart(chunk.bytes);
  }
  const url=URL.createObjectURL(new Blob(parts,{type:entry.mime}));objectUrls.push(url);return url;
}
async function startGame(){
  start.hidden=true;
  statusText.textContent="正在加载地牢资源…";
  try{
    if(!window.WebAssembly||!window.DecompressionStream)throw new Error("请使用新版 Chrome、Edge 或 Firefox 浏览器");
    const probe=document.createElement("canvas").getContext("webgl2");
    if(!probe)throw new Error("浏览器未启用 WebGL 2，请开启硬件加速后重试");
    probe.getExtension("WEBGL_lose_context")?.loseContext();
    const response=await fetch("game-manifest.json");
    if(!response.ok)throw new Error("无法读取游戏资源清单");
    const manifest=await response.json();
    const total=manifest.data.bytes+manifest.code.bytes;let loaded=0;
    const onPart=bytes=>{loaded+=bytes;progress.value=85*loaded/total;statusText.textContent="正在加载地牢资源… "+Math.round(100*loaded/total)+"%";};
    const [dataUrl,codeUrl]=await Promise.all([unpack(manifest.data,onPart),unpack(manifest.code,onPart)]);
    statusText.textContent="正在唤醒地牢…";
    await loadScript("Build/build.loader.js");
    instance=await createUnityInstance(canvas,{
      dataUrl,codeUrl,frameworkUrl:"Build/build.framework.js",streamingAssetsUrl:"StreamingAssets",
      companyName:"Powerhoof",productName:"Crawl",productVersion:"1.0",autoSyncPersistentDataPath:true,
      showBanner:(message,type)=>{if(type==="error")fail(new Error(message));else console.warn(message);}
    },value=>{progress.value=85+value*15;});
    window.crawlInstance=instance;
    loading.hidden=true;fullscreen.disabled=false;canvas.focus();
    if(window.__CRAWL_HOST__)await loadScript('host.js');
  }catch(error){fail(error);}
}
function startLocal(){window.crawlLocalReadyPromise=startGame();return window.crawlLocalReadyPromise;}
start.onclick=startLocal;
window.stopCrawlLocal=async()=>{
  if(window.crawlLocalReadyPromise)await window.crawlLocalReadyPromise;
  if(instance){await instance.Quit();instance=null;window.crawlInstance=null;}
  for(const url of objectUrls)URL.revokeObjectURL(url);objectUrls.length=0;
  window.crawlLocalReadyPromise=null;
  const fresh=canvas.cloneNode(false);canvas.replaceWith(fresh);canvas=fresh;
  bindMouse(canvas);
  loading.hidden=false;start.hidden=false;start.onclick=startLocal;
  statusText.textContent='首次进入需要加载游戏资源，请稍候。';progress.value=0;
};
if(window.__CRAWL_HOST__){document.documentElement.classList.add('renderer');startLocal();}
fullscreen.onclick=()=>{
  document.querySelector('.game').requestFullscreen?.().then(()=>{
    (window.crawlOnline?.active?document.querySelector('#online-video'):canvas).focus();
  }).catch(error=>{console.warn('Fullscreen:',error.message);});
};
window.addEventListener("beforeunload",()=>{for(const url of objectUrls)URL.revokeObjectURL(url);});
