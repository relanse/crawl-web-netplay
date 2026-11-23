(()=>{
  if(window.__CRAWL_HOST__)return;
  const select=document.querySelector('#online-quality'),status=document.querySelector('#stream-status'),settings=document.querySelector('#stream-settings');
  let peer,timer,previous,busy=false,expectedFps=60,mode='auto',policy={level:0,bad:0,good:0,cooldownUntil:0};
  try{const saved=localStorage.getItem('crawl-stream-quality');if(['auto','clear','smooth'].includes(saved))mode=saved;}catch{}
  select.value=mode;
  function request(){window.crawlOnline?.command({type:'stream-quality',level:mode==='clear'?0:mode==='smooth'?2:policy.level});}
  function reset(){previous=null;policy={level:0,bad:0,good:0,cooldownUntil:Date.now()+8000};}
  async function sample(connection){
    if(peer!==connection||connection.connectionState!=='connected'||busy)return;
    busy=true;
    try{
      const stats=await connection.getStats();if(peer!==connection)return;
      const video=[...stats.values()].find(r=>r.type==='inbound-rtp'&&r.kind==='video');if(!video)return;
      const transport=stats.get(video.transportId),pair=stats.get(transport?.selectedCandidatePairId);
      if(previous&&video.id===previous.id&&video.timestamp>previous.timestamp){
        const seconds=(video.timestamp-previous.timestamp)/1000,frames=video.framesDecoded-previous.framesDecoded;
        if(!Number.isFinite(frames)){previous=video;return;}
        const emitted=video.jitterBufferEmittedCount-previous.jitterBufferEmittedCount;
        const lost=Math.max(0,(video.packetsLost||0)-(previous.packetsLost||0)),received=video.packetsReceived-previous.packetsReceived;
        const fps=frames/seconds,bufferMs=emitted>0?(video.jitterBufferDelay-previous.jitterBufferDelay)/emitted*1000:0;
        const metrics={now:Date.now(),fps,expectedFps,bufferMs,loss:lost/Math.max(1,received+lost),freezes:Math.max(0,(video.freezeCount||0)-(previous.freezeCount||0))};
        window.crawlStreamStats={...metrics,width:video.frameWidth,height:video.frameHeight,rttMs:pair?.currentRoundTripTime!=null?pair.currentRoundTripTime*1000:null,level:policy.level,mode};
        status.textContent=Math.round(fps)+' 帧 · '+video.frameHeight+'p'+(pair?.currentRoundTripTime!=null?' · 网络 '+Math.round(pair.currentRoundTripTime*1000)+' 毫秒':'');
        if(mode==='auto'&&window.crawlOnlineStatus?.phase==='playing'){
          const next=CrawlStreamPolicy.step(policy,metrics),changed=next.level!==policy.level;policy=next;if(changed)request();
        }
      }
      previous=video;
    }catch(error){console.debug('Stream statistics:',error.message);}finally{busy=false;}
  }
  select.onchange=()=>{mode=select.value;reset();try{localStorage.setItem('crawl-stream-quality',mode);}catch{}request();};
  window.crawlStream={
    attach(connection){
      clearInterval(timer);peer=connection;reset();expectedFps=60;status.textContent='正在测量画面…';request();
      timer=setInterval(()=>sample(connection),2000);
    },
    track(receiver){
      try{if('jitterBufferTarget' in receiver)receiver.jitterBufferTarget=20;else if('playoutDelayHint' in receiver)receiver.playoutDelayHint=.02;}catch{}
    },
    info(data){expectedFps=Number(data.maxFps)||60;},
    stop(){clearInterval(timer);peer=null;previous=null;window.crawlStreamStats=null;}
  };
  window.addEventListener('crawl-online-joined',()=>{settings.hidden=false;});
  window.addEventListener('crawl-online-ended',()=>{window.crawlStream.stop();settings.hidden=true;});
})();
