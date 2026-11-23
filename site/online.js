/* The access key is verified by the server. It is never stored in URLs or localStorage. */
(()=>{
  if(window.__CRAWL_HOST__)return;
  const panel=document.querySelector('#online-panel'),form=document.querySelector('#online-form');
  const key=document.querySelector('#online-key'),name=document.querySelector('#online-name');
  const state=document.querySelector('#online-state'),players=document.querySelector('#online-players');
  const video=document.querySelector('#online-video'),actions=document.querySelector('#online-actions');
  const join=document.querySelector('#online-join'),sound=document.querySelector('#online-sound');
  let socket,pc,active=false,sequence=0,slot=-1,held=new Set(),previousButtons=0,timer,retryTimer,retries=0,pending=[];
  let transportId='',signalQueue=Promise.resolve(),mediaTimer,mediaRetries=0,stableTimer,focused=true,joining=false;
  let tunnelMode=false,tunnelPlayback=null;
  const mediaReady=()=>tunnelMode?!!tunnelPlayback&&video.readyState>=2:pc?.connectionState==='connected';
  const send=data=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));};
  const setState=text=>{state.textContent=text;};
  const mapping={ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right',ArrowUp:'up',KeyW:'up',ArrowDown:'down',KeyS:'down',KeyX:'action',Space:'action',KeyZ:'back',Backspace:'back',Enter:'start',Escape:'start'};
  let mouse=false,mouseButtons=0,px=.5,py=.5;
  function point(event){
    const rect=video.getBoundingClientRect(),ratio=(video.videoWidth||1280)/(video.videoHeight||720);
    const width=Math.min(rect.width,rect.height*ratio),height=width/ratio;
    px=(event.clientX-rect.left-(rect.width-width)/2)/width;
    py=(event.clientY-rect.top-(rect.height-height)/2)/height;
    mouse=px>=0&&px<=1&&py>=0&&py<=1;px=Math.max(0,Math.min(1,px));py=Math.max(0,Math.min(1,py));
    if(!mouse)mouseButtons=0;
  }
  video.addEventListener('contextmenu',event=>event.preventDefault());
  video.addEventListener('mousedown',event=>event.preventDefault());
  video.addEventListener('auxclick',event=>event.preventDefault());
  video.addEventListener('pointermove',event=>{if(active){point(event);}});
  video.addEventListener('pointerdown',event=>{if(!active)return;event.preventDefault();video.focus();point(event);if(mouse)mouseButtons|=event.button===0?1:event.button===2?2:event.button===1?4:0;input(true);});
  window.addEventListener('pointerup',event=>{if(!active)return;mouseButtons&=~(event.button===0?1:event.button===2?2:event.button===1?4:0);input(true);},true);
  window.addEventListener('pointercancel',()=>{if(active){mouseButtons=0;mouse=false;input(true);}},true);
  video.addEventListener('pointerleave',()=>{if(active){mouse=false;mouseButtons=0;input(true);}});
  function snapshot(){
    // A background tab, form field or missing video must never drive a character.
    if(!focused||document.hidden||document.activeElement!==video||!mediaReady()||window.crawlOnlineStatus?.phase!=='playing')return {x:0,y:0,buttons:0,mouse:false,px,py};
    const controls=new Set([...held].map(code=>mapping[code]));
    let x=Number(controls.has('right'))-Number(controls.has('left')),y=Number(controls.has('up'))-Number(controls.has('down'));
    let buttons=mouseButtons|(controls.has('action')?1:0)|(controls.has('back')?2:0)|(controls.has('start')?4:0);
    const pad=Array.from(navigator.getGamepads?.()||[]).find(Boolean);
    if(pad){
      if(pad.axes.some(axis=>Math.abs(axis)>.2)||pad.buttons.some(button=>button.pressed))mouse=false;
      if(Math.abs(pad.axes[0]||0)>.2)x=pad.axes[0];if(Math.abs(pad.axes[1]||0)>.2)y=-pad.axes[1];
      x=pad.buttons[15]?.pressed?1:pad.buttons[14]?.pressed?-1:x;y=pad.buttons[12]?.pressed?1:pad.buttons[13]?.pressed?-1:y;
      buttons|=(pad.buttons[0]?.pressed?1:0)|(pad.buttons[1]?.pressed?2:0)|(pad.buttons[9]?.pressed?4:0);
    }
    return {x:Math.max(-1,Math.min(1,x)),y:Math.max(-1,Math.min(1,y)),buttons,mouse,px,py};
  }
  let lastSnapshot='',lastSent=0;
  function input(force=false){
    if(!active||socket?.readyState!==WebSocket.OPEN)return;
    // Keep only the newest movement sample while TCP is congested; button edges still send immediately.
    if(!force&&socket.bufferedAmount>8192)return;
    const value=snapshot(),encoded=JSON.stringify(value);
    if(force||encoded!==lastSnapshot||performance.now()-lastSent>200){
      send({type:'input',sequence:sequence++,pressed:value.buttons&~previousButtons,...value});
      window.crawlOnlineLastInput={sequence:sequence-1,pressed:value.buttons&~previousButtons,...value};
      previousButtons=value.buttons;lastSnapshot=encoded;lastSent=performance.now();
    }
  }
  function release(){held.clear();mouseButtons=0;mouse=false;const saved=focused;focused=false;input(true);focused=saved;previousButtons=0;}
  window.addEventListener('keydown',event=>{
    if(!active||!mapping[event.code]||document.activeElement!==video)return;
    event.preventDefault();if(event.repeat||held.has(event.code))return;mouse=false;held.add(event.code);input(true);
  });
  window.addEventListener('keyup',event=>{if(active&&held.has(event.code)){event.preventDefault();held.delete(event.code);input(true);}});
  window.addEventListener('blur',()=>{focused=false;release();});
  window.addEventListener('focus',()=>{focused=true;});
  video.addEventListener('blur',release);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});
  async function signal(data,connection,id){
    const current=()=>pc===connection&&transportId===id&&data.transportId===id;
    if(!current())return;
    if(data.sdp){
      await connection.setRemoteDescription(data.sdp);if(!current())return;
      const candidates=pending;pending=[];
      for(const candidate of candidates){await connection.addIceCandidate(candidate);if(!current())return;}
      await connection.setLocalDescription(await connection.createAnswer());
      if(current())send({type:'signal',transportId:id,sdp:connection.localDescription.toJSON()});
    }
    if(data.candidate){if(connection.remoteDescription)await connection.addIceCandidate(data.candidate);else pending.push(data.candidate);}
  }
  function closeMedia(){
    clearTimeout(mediaTimer);clearTimeout(stableTimer);pc?.close();pc=null;video.srcObject=null;
    tunnelPlayback?.close();tunnelPlayback=null;
    window.crawlStream?.stop();
  }
  function startTunnelMedia(connection){
    const codec='video/webm; codecs="vp8,opus"';
    if(!window.MediaSource?.isTypeSupported(codec)){
      finish('此浏览器无法播放联机画面，请使用新版 Chrome 或 Edge。');return;
    }
    tunnelPlayback?.close();clearTimeout(mediaTimer);
    const source=new MediaSource(),url=URL.createObjectURL(source),listeners=new AbortController();
    const queue=[];
    let buffer,queuedBytes=0;
    const recover=()=>{if(socket===connection&&active)connection.close(4005,'重新连接画面');};
    function pump(){
      if(!buffer||buffer.updating||source.readyState!=='open')return;
      try{
        const ranges=buffer.buffered;
        if(ranges.length){
          const end=ranges.end(ranges.length-1);
          if(end-video.currentTime>1.2)video.currentTime=end-.25;
          if(video.currentTime-ranges.start(0)>12){buffer.remove(ranges.start(0),video.currentTime-4);return;}
        }
        if(queue.length){const chunk=queue.shift();queuedBytes-=chunk.byteLength;buffer.appendBuffer(chunk);}
      }catch{recover();}
    }
    tunnelPlayback={
      push(chunk){queuedBytes+=chunk.byteLength;if(queuedBytes>1024*1024){recover();return;}queue.push(chunk);pump();},
      close(){listeners.abort();queue.length=0;video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
    };
    const options={signal:listeners.signal};
    source.addEventListener('sourceopen',()=>{
      try{buffer=source.addSourceBuffer(codec);buffer.addEventListener('updateend',pump,options);buffer.addEventListener('error',recover,options);pump();}
      catch{recover();}
    },{...options,once:true});
    video.addEventListener('loadeddata',()=>{clearTimeout(mediaTimer);setState('已连入房间 · 你是 '+(slot+1)+' 号玩家。');},{...options,once:true});
    video.addEventListener('error',recover,options);
    mediaTimer=setTimeout(recover,20000);
    video.src=url;video.play().catch(()=>{});
  }
  function finish(text){
    release();active=false;clearInterval(timer);clearTimeout(retryTimer);closeMedia();
    socket?.close();socket=null;video.hidden=true;actions.hidden=true;players.replaceChildren();join.disabled=false;
    document.querySelector('#loading').hidden=false;document.querySelector('#fullscreen').disabled=true;
    window.crawlOnlineStatus=null;window.dispatchEvent(new Event('crawl-online-ended'));
    setState(text);
  }
  function recoverMedia(connection){
    if(pc!==connection||!active)return;
    release();
    if(mediaRetries++>=3){finish('画面连接无法恢复。请重新输入密钥加入；若仍失败，请检查服务器的 TURN 配置。');return;}
    setState('画面连接中断，正在恢复；保留你的联机席位…');
    closeMedia();socket?.close(4005,'重新连接画面');
  }
  function connect(){
    sequence=0;previousButtons=0;lastSnapshot='';pending=[];clearTimeout(retryTimer);
    const url=new URL('/online-socket',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';url.searchParams.set('name',name.value.trim());
    const connectionSocket=new WebSocket(url);connectionSocket.binaryType='arraybuffer';socket=connectionSocket;
    socket.onmessage=async event=>{
      if(socket!==connectionSocket||!active)return;
      try{
        if(event.data instanceof ArrayBuffer){tunnelPlayback?.push(event.data);return;}
        const data=JSON.parse(event.data);
        if(data.type==='welcome'){
          retries=0;slot=data.slot;pending=[];transportId=data.transportId;signalQueue=Promise.resolve();
          release();closeMedia();tunnelMode=data.tunnelMedia===true;
          document.querySelector('#stream-settings').hidden=tunnelMode;
          if(tunnelMode){setState('正在连接公网游戏画面…');return;}
          pc=new RTCPeerConnection({iceServers:data.iceServers,iceTransportPolicy:data.icePolicy||'all'});
          const connection=pc;
          window.crawlStream?.attach(connection);
          const id=transportId;
          pc.onicecandidate=event=>{if(pc===connection&&event.candidate)send({type:'signal',transportId:id,candidate:event.candidate.toJSON()});};
          pc.ontrack=event=>{if(pc!==connection)return;window.crawlStream?.track(event.receiver);video.srcObject=event.streams[0];video.play().catch(()=>{});};
          pc.onconnectionstatechange=()=>{
            if(pc!==connection)return;
            clearTimeout(mediaTimer);clearTimeout(stableTimer);
            if(connection.connectionState==='connected'){
              setState('已连接 · 你是 '+(slot+1)+' 号玩家。'+(window.crawlOnlineStatus?.phase==='playing'?'点击画面继续对局。':'选好信仰后点击准备。'));
              stableTimer=setTimeout(()=>{mediaRetries=0;},10000);
            }else if(connection.connectionState==='failed')recoverMedia(connection);
            else if(connection.connectionState==='disconnected'){
              release();setState('画面暂时中断，正在恢复…');mediaTimer=setTimeout(()=>recoverMedia(connection),5000);
            }else if(connection.connectionState==='connecting')mediaTimer=setTimeout(()=>recoverMedia(connection),20000);
          };
          setState('联机席位 '+(slot+1)+'，正在连接游戏画面…');input(true);
        }else if(data.type==='tunnel-media-init'&&tunnelMode)startTunnelMedia(connectionSocket);
        else if(data.type==='signal'){
          const connection=pc,id=transportId;
          signalQueue=signalQueue.then(()=>signal(data,connection,id)).catch(error=>{if(pc===connection){console.error('Online signal:',error);recoverMedia(connection);}});
        }
        else if(data.type==='stream-info')window.crawlStream?.info(data);
        else if(data.type==='room'){
          players.replaceChildren(...data.players.map(player=>{const item=document.createElement('span');item.textContent='席位 '+(player.slot+1)+'：'+player.name+(player.connected?'':'（暂时离线）');return item;}));
          if(data.state==='starting')setState('服务器正在启动原版游戏，首次启动可能需要一会儿…');
          if(data.state==='failed')setState('服务器游戏进程已断开，请稍后重新加入。');
          window.crawlOnlineStatus=data;
          window.dispatchEvent(new CustomEvent('crawl-room',{detail:data}));
        }else if(data.type==='error'){setState(data.message);window.dispatchEvent(new Event('crawl-online-error'));}
      }catch(error){console.error('Online:',error);setState('联机连接异常，请退出后重新加入。');}
    };
    socket.onclose=event=>{
      if(socket!==connectionSocket)return;
      release();closeMedia();
      if(!active)return;
      window.dispatchEvent(new Event('crawl-online-error'));
      if([4000,4001,4002,4004,4008].includes(event.code)){finish(event.reason||'联机已结束。');return;}
      setState('连接已中断，正在尝试重新加入…');
      if(retries++<5)retryTimer=setTimeout(connect,2000);else finish('无法重新连接，请重新输入密钥加入。');
    };
    socket.onerror=()=>{if(socket===connectionSocket&&active)setState('无法连接联机服务，请确认服务器已启动且使用 HTTPS。');};
  }
  form.onsubmit=async event=>{
    if(active||joining){event.preventDefault();return;}
    event.preventDefault();joining=true;join.disabled=true;setState('正在校验联机密钥…');
    try{
      const response=await fetch('/api/online/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key.value})});
      const result=await response.json().catch(()=>({error:'联机需要配套的服务器，请先按部署说明启动服务端。'}));
      if(!response.ok)throw new Error(result.error||'联机密钥校验失败。');
      key.value='';await window.stopCrawlLocal();
      document.querySelector('#loading').hidden=true;video.hidden=false;actions.hidden=false;panel.open=true;active=true;retries=0;mediaRetries=0;focused=true;video.focus();
      document.querySelector('#fullscreen').disabled=false;
      window.dispatchEvent(new Event('crawl-online-joined'));
      connect();clearInterval(timer);timer=setInterval(()=>input(),16);
    }catch(error){setState(error.message);join.disabled=false;}finally{joining=false;}
  };
  sound.onclick=()=>{video.muted=!video.muted;sound.textContent=video.muted?'开启声音':'关闭声音';video.play().catch(()=>{});video.focus();};
  document.querySelector('#online-leave').onclick=async()=>{
    finish('已退出联机，可以继续本地游玩。');join.disabled=true;joining=true;
    await fetch('/api/online/session',{method:'DELETE'}).catch(()=>{});
    join.disabled=false;joining=false;
  };
  window.crawlOnline={get active(){return active;},get slot(){return slot;},get peer(){return pc;},get mediaReady(){return mediaReady();},get socket(){return socket;},command(data){if(active)send(data);}};
})();
