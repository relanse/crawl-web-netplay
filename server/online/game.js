const canvas=document.getElementById('game'),keys=new Set();let instance,canControl=false,lastInput='',connected=false;
let pointer=null,mouseButtons=0,mouseActive=false,menu=false;
const tell=(type,value={})=>parent.postMessage({type,...value},location.origin);
const recognized=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyJ','KeyK','KeyZ','KeyX','Space','ShiftLeft','ShiftRight']);
function input(){
  let x=(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0),y=(keys.has('KeyW')||keys.has('ArrowUp')?1:0)-(keys.has('KeyS')||keys.has('ArrowDown')?1:0);
  let buttons=(keys.has('KeyJ')||keys.has('KeyZ')||keys.has('Space')?1:0)|(keys.has('KeyK')||keys.has('KeyX')||keys.has('ShiftLeft')||keys.has('ShiftRight')||(menu&&keys.has('Escape'))?2:0);
  const pad=document.hasFocus()?[...(navigator.getGamepads?.()??[])].find(Boolean):null;if(pad){if(Math.abs(pad.axes[0])>.18)x=pad.axes[0];if(Math.abs(pad.axes[1])>.18)y=-pad.axes[1];if(pad.buttons[0]?.pressed)buttons|=1;if(pad.buttons[1]?.pressed)buttons|=2;}
  const mouse=!!pointer&&mouseActive&&x===0&&y===0;
  const json=JSON.stringify(canControl?{x,y,buttons:buttons|mouseButtons,mouse,px:pointer?.x??0,py:pointer?.y??0}:{x:0,y:0,buttons:0});if(instance&&json!==lastInput){instance.SendMessage('CrawlGameSession','SetInput',json);lastInput=json;}
}
function point(event){
  const rect=canvas.getBoundingClientRect(),scale=Math.min(rect.width/canvas.width,rect.height/canvas.height);
  if(!scale)return null;
  const width=canvas.width*scale,height=canvas.height*scale;
  const x=(event.clientX-rect.left-(rect.width-width)/2)/width;
  const y=(event.clientY-rect.top-(rect.height-height)/2)/height;
  return x>=0&&x<=1&&y>=0&&y<=1?{x,y}:null;
}
canvas.addEventListener('pointermove',event=>{
  if(event.pointerType!=='mouse'||!document.hasFocus())return;
  pointer=point(event);mouseActive=!!pointer;if(!pointer)mouseButtons=0;
});
canvas.addEventListener('pointerdown',event=>{
  canvas.focus();
  if(event.pointerType!=='mouse')return;
  event.preventDefault();pointer=point(event);mouseActive=!!pointer;
  mouseButtons=pointer?event.buttons&3:0;input();
});
canvas.addEventListener('contextmenu',event=>event.preventDefault());
window.addEventListener('pointerup',event=>{if(event.pointerType==='mouse'){mouseButtons&=event.buttons;input();}});
function clearPointer(){mouseButtons=0;mouseActive=false;pointer=null;input();}
canvas.addEventListener('pointerleave',clearPointer);
window.addEventListener('pointercancel',clearPointer);
window.addEventListener('keydown',event=>{if(recognized.has(event.code)||(canControl&&menu&&event.code==='Escape')){event.preventDefault();mouseActive=false;keys.add(event.code);input();}});
window.addEventListener('keyup',event=>{if(keys.delete(event.code)){event.preventDefault();input();}});
function release(){keys.clear();mouseButtons=0;mouseActive=false;pointer=null;lastInput='';if(instance)instance.SendMessage('CrawlGameSession','SetInput','{"x":0,"y":0,"buttons":0}');}
window.addEventListener('blur',release);window.addEventListener('offline',release);document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});
window.addEventListener('crawl-state',event=>{const state=event.detail;if(canControl&&!state.canControl)release();if(!canControl&&state.canControl)canvas.focus();menu=!!state.menu;if(!menu)keys.delete('Escape');canControl=!!state.canControl;tell('game-state',{state});});
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==parent||!instance)return;
  if(event.data?.type==='set-volume'){
    instance.SendMessage('CrawlGameSession','SetVolume',String(event.data.value));
  }else if(event.data?.type==='set-frame-rate'){
    instance.SendMessage('CrawlGameSession','SetRenderFrameRate',String(event.data.value));
  }else if(event.data?.type==='configure'&&!connected){
    connected=true;instance.SendMessage('CrawlGameSession','Configure',JSON.stringify(event.data.config));
  }
});
function poll(){if(!document.hidden)input();requestAnimationFrame(poll);}requestAnimationFrame(poll);
try{
  const response=await fetch('/api/client');if(!response.ok)throw Error('请先登录大厅。');const build=await response.json();
  await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=build.base+build.files.loader;script.onload=resolve;script.onerror=()=>reject(Error('游戏加载器下载失败。'));document.head.append(script);});
  instance=await createUnityInstance(canvas,{
    dataUrl:build.base+build.files.data,
    frameworkUrl:build.base+build.files.framework,
    codeUrl:build.base+build.files.wasm,
    streamingAssetsUrl:build.base+'StreamingAssets',
    matchWebGLToCanvasSize:false,
    companyName:'Crawl',
    productName:'Crawl Online',
    productVersion:build.releaseId,
    showBanner:(message,type)=>{if(type==='error')tell('game-error',{message});}
  },progress=>tell('unity-progress',{progress}));
  tell('unity-ready');
}catch(error){tell('game-error',{message:error.message});}
