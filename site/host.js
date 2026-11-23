/* Runs only in the server-owned browser. The renderer token is injected in memory. */
(async()=>{
  const config=window.__CRAWL_HOST__;
  if(!config||!window.crawlInstance)return;
  const game=window.crawlInstance;
  game.SendMessage('CrawlRemoteInput','Enable','');
  const stream=document.querySelector('canvas').captureStream(config.maxFps||60);
  for(const track of window.crawlCaptureAudio?.getAudioTracks()||[])stream.addTrack(track);
  let socket,retryTimer,retries=0;
  const peers=new Map();
  const send=data=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data));};
  const profiles=[{scale:1,bitrate:4500000,fps:60},{scale:4/3,bitrate:2500000,fps:60},{scale:1.5,bitrate:1400000,fps:30}];
  function removePeer(id){
    const peer=peers.get(id);peers.delete(id);
    peer?.pc?.close();
    if(peer?.recorder?.state==='recording')peer.recorder.stop();
  }
  function addTunnelPeer(id,transportId){
    removePeer(id);
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8,opus',videoBitsPerSecond:1400000,audioBitsPerSecond:64000,videoKeyFrameIntervalDuration:1000});
    const peer={recorder};peers.set(id,peer);
    const prefix=new TextEncoder().encode(id+transportId);
    recorder.ondataavailable=event=>{
      if(peers.get(id)!==peer||socket?.readyState!==WebSocket.OPEN)return;
      for(let offset=0;offset<event.data.size;offset+=24000){
        socket.send(new Blob([prefix,event.data.slice(offset,offset+24000)]));
      }
    };
    send({type:'tunnel-media-init',peerId:id,transportId});
    recorder.start(90);
  }
  async function quality(id,peer){
    if(peers.get(id)!==peer)return;
    const sender=peer.pc.getSenders().find(s=>s.track?.kind==='video');if(!sender)return;
    const parameters=sender.getParameters();if(!parameters.encodings?.length)return;
    const profile=profiles[peer.level]||profiles[0],fps=Math.min(profile.fps,config.maxFps||60);
    Object.assign(parameters.encodings[0],{maxBitrate:profile.bitrate,maxFramerate:fps,scaleResolutionDownBy:profile.scale});
    parameters.degradationPreference='maintain-framerate';
    await sender.setParameters(parameters);
    if(peers.get(id)===peer)send({type:'stream-info',peerId:id,level:peer.level,maxFps:fps,width:Math.round(1280/profile.scale),height:Math.round(720/profile.scale)});
  }
  window.crawlHostReport=json=>{try{send({type:'game-status',status:JSON.parse(json)});}catch{}};
  async function addPeer(id,transportId,level=0){
    removePeer(id);
    const peer={pc:new RTCPeerConnection({iceServers:config.iceServers,iceTransportPolicy:config.icePolicy||'all'}),pending:[],transportId,level,queue:Promise.resolve()};
    peers.set(id,peer);
    try{
    peer.pc.onicecandidate=event=>{if(peers.get(id)===peer&&event.candidate)send({type:'signal',peerId:id,transportId,candidate:event.candidate.toJSON()});};
    for(const track of stream.getTracks()){
      const sender=peer.pc.addTrack(track,stream);
      if(track.kind==='video')track.contentHint='motion';
    }
    if(peers.get(id)!==peer)return;
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    if(peers.get(id)===peer)send({type:'signal',peerId:id,transportId,sdp:peer.pc.localDescription.toJSON()});
    }catch(error){if(peers.get(id)===peer)throw error;}
  }
  function connect(){
    const connection=new WebSocket(config.origin.replace('http:','ws:')+'/host-socket');
    socket=connection;window.crawlHostSocket=connection;
    connection.onopen=()=>send({type:'host-auth',token:config.token});
    connection.onclose=event=>{
      if(socket!==connection)return;
      window.crawlHostReady=false;
      for(const id of peers.keys())removePeer(id);
      for(let slot=0;slot<4;slot++)game.SendMessage('CrawlRemoteInput','SetState',JSON.stringify({slot,connected:false}));
      if(event.code!==4003&&retries++<5)retryTimer=setTimeout(connect,1000);
    };
    connection.onmessage=async event=>{
    if(socket!==connection)return;
    try{
      const data=JSON.parse(event.data);
      if(data.type==='host-authorized'){retries=0;send({type:'ready'});window.crawlHostReady=true;}
      else if(data.type==='peer-join'){
        if(data.tunnelMedia)addTunnelPeer(data.peerId,data.transportId);
        else await addPeer(data.peerId,data.transportId,data.level||0);
      }
      else if(data.type==='stream-quality'){
        const peer=peers.get(data.peerId);if(!peer?.pc)return;
        peer.level=data.level;
        peer.queue=peer.queue.then(()=>quality(data.peerId,peer)).catch(error=>console.warn('Stream quality:',error.message));
      }
      else if(data.type==='peer-leave')removePeer(data.peerId);
      else if(data.type==='input')game.SendMessage('CrawlRemoteInput','SetState',JSON.stringify(data));
      else if(data.type==='lobby-sync')game.SendMessage('CrawlRemoteInput','SetLobby',JSON.stringify(data));
      else if(data.type==='lobby-start')game.SendMessage('CrawlRemoteInput','StartMatch',String(data.revision));
      else if(data.type==='signal'){
        const peer=peers.get(data.peerId);if(!peer?.pc||peer.transportId!==data.transportId)return;
        peer.queue=peer.queue.then(async()=>{
          if(peers.get(data.peerId)!==peer)return;
          if(data.sdp){await peer.pc.setRemoteDescription(data.sdp);for(const candidate of peer.pending)await peer.pc.addIceCandidate(candidate);peer.pending=[];await quality(data.peerId,peer);}
          if(data.candidate){if(peer.pc.remoteDescription)await peer.pc.addIceCandidate(data.candidate);else peer.pending.push(data.candidate);}
        }).catch(error=>{if(peers.get(data.peerId)===peer){console.error('Online renderer signal:',error.message);send({type:'host-error'});}});
      }
    }catch(error){console.error('Online renderer:',error.message);send({type:'host-error'});}
    };
  }
  connect();
  window.addEventListener('beforeunload',()=>clearTimeout(retryTimer));
  window.crawlHostPeers=peers;
})();
