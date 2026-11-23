const $=id=>document.getElementById(id);
const errors={AUTH_REQUIRED:'请重新登录。',LOGIN_REFUSED:'访问密钥不正确。',ROOM_NOT_FOUND:'没有找到这个房间。',ROOM_FULL:'房间已满。',ROOM_CHANGED:'房间状态已更新，请再试一次。',UNREADY_FIRST:'请先取消准备再修改资料。',SERVER_BUSY:'服务器正在运行其他游戏，请稍后再试。',MATCH_ABANDONED:'你已离开本局，下一局开始后可以重新加入。',PLAYERS_NOT_READY:'请等待所有玩家准备。',OWNER_REQUIRED:'此操作需要房主执行。',PROCESS_EXITED:'游戏进程已退出，请返回大厅重新开局。',LOAD_TIMEOUT:'有玩家未能及时载入，已返回大厅。',ALL_OFFLINE:'所有玩家离线，本局已结束。',VERSION_MISMATCH:'游戏版本不同，请更新页面后重试。',SESSION_REPLACED:'这个席位已在另一个窗口连接。'};
let current=null,lobbySocket=null,socketTimer,gameMatch=null,iframe=null,generation=0,reconnectTimer,noticeTimer;
let overviewKey=null;
const inviteCode=new URL(location.href).searchParams.get('room');
const volume=$('volume'), volumeKey='crawl-game-volume';
const frameRate=$('frame-rate'), frameRateKey='crawl-game-frame-rate';
try{
  const saved=localStorage.getItem(volumeKey);
  if(saved!==null&&Number.isFinite(Number(saved)))volume.value=saved;
  const savedFrameRate=localStorage.getItem(frameRateKey);
  if(Array.from(frameRate.options).some(option=>option.value===savedFrameRate))frameRate.value=savedFrameRate;
}catch{}
function updateVolume(){
  $('volume-value').value=volume.value+'%';
  iframe?.contentWindow?.postMessage({type:'set-volume',value:volume.value},location.origin);
}
function updateFrameRate(){
  iframe?.contentWindow?.postMessage({type:'set-frame-rate',value:frameRate.value},location.origin);
}
volume.addEventListener('input',updateVolume);
volume.addEventListener('change',()=>{try{localStorage.setItem(volumeKey,volume.value);}catch{}});
frameRate.addEventListener('change',()=>{
  try{localStorage.setItem(frameRateKey,frameRate.value);}catch{}
  updateFrameRate();
});
updateVolume();
Object.assign(errors,{
  WORLD_CAPTURE_FAILED:'服务器停止了场景同步，请房主返回大厅重新开局。',
  RESYNC_TIMEOUT:'场景同步超时，正在尝试恢复对局。',
  RESYNC_OVERFLOW:'场景数据超过同步上限，请房主重新开局。',
  RESULT_SAVE_FAILED:'战绩暂未保存，服务器正在重试。'
});
function notice(value){$('notice').textContent=errors[value]??value??'';clearTimeout(noticeTimer);if(value)noticeTimer=setTimeout(()=>{$('notice').textContent='';},7000);}
async function api(route,data){let response;try{response=await fetch('/api/'+route,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});}catch{throw Error('网络连接中断，请稍后重试。');}const result=await response.json();if(!response.ok)throw Error(result.code??'请求失败');return result;}
function destroyGame(){generation++;clearTimeout(reconnectTimer);iframe?.remove();iframe=null;gameMatch=null;$('game').hidden=true;}
function showLogin(){current=null;overviewKey=null;destroyGame();$('login-panel').hidden=false;$('home').hidden=true;$('room').hidden=true;$('match-results').hidden=true;$('logout').hidden=true;}
const matchTime=new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
function tableRow(self,values){
  const row=document.createElement('tr');
  if(self)row.dataset.self='';
  for(const value of values){
    const cell=document.createElement('td');cell.textContent=value;row.append(cell);
  }
  return row;
}
function outcome(player,bossDefeated){
  if(player.abandoned)return '中途退出';
  if(player.bossKill)return '击败首领';
  return bossDefeated?'首领已被击败':'首领获胜';
}
async function refreshProgress(){
  const playerId=current.playerId,key=playerId+':'+current.progressVersion;
  if(overviewKey===key)return;
  overviewKey=key;
  $('progress-state').hidden=false;
  $('progress-state').textContent='正在载入战绩…';
  $('progress-totals').hidden=$('progress-tables').hidden=true;
  try{
    const {self,leaderboard,recent}=await api('progress');
    if(overviewKey!==key)return;
    const totals=self??{bestLevel:'—',xp:0,bossKills:0,completed:0};
    $('progress-totals').replaceChildren();
    for(const [title,value] of [['最高英雄等级',totals.bestLevel],['累计经验',totals.xp],['击败首领',totals.bossKills],['完成对局',totals.completed]]){
      const stat=document.createElement('div'),label=document.createElement('dt'),number=document.createElement('dd');
      label.textContent=title;number.textContent=value;stat.append(label,number);$('progress-totals').append(stat);
    }
    $('standings').replaceChildren(...leaderboard.map((p,i)=>tableRow(p.playerId===playerId,
      [i+1,p.nickname+(p.playerId===playerId?' · 你':''),p.bossKills,p.bestLevel,p.heroKills,p.completed])));
    $('history').replaceChildren(...recent.map(p=>tableRow(false,
      [matchTime.format(p.completedAt),outcome(p,p.bossDefeated),p.abandoned?'—':p.level,p.abandoned?'—':p.xp])));
    $('standings-table').hidden=leaderboard.length===0;
    $('standings-empty').hidden=leaderboard.length>0;
    $('history-table').hidden=recent.length===0;
    $('history-empty').hidden=recent.length>0;
    $('progress-state').hidden=true;
    $('progress-totals').hidden=$('progress-tables').hidden=false;
  }catch(error){
    if(overviewKey!==key)return;
    overviewKey=null;
    $('progress-state').textContent=errors[error.message]??'暂时无法载入战绩。';
  }
}
function renderResults(room){
  const visible=room?.phase==='Results';
  $('match-results').hidden=!visible;
  if(!visible)return;
  const result=room.result;
  $('match-results-table').hidden=!result;
  $('match-result-rows').replaceChildren();
  if(!result){$('match-outcome').textContent='本局未完成首领结算。';return;}
  const winner=result.players.find(p=>p.bossKill);
  const title=winner?winner.nickname+' 击败了首领':result.bossDefeated?'首领已被击败':'首领获胜';
  const seconds=result.durationSeconds;
  $('match-outcome').textContent=title+' · '+Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';
  $('match-result-rows').replaceChildren(...result.players.map(p=>tableRow(p.playerId===current.playerId,
    [p.nickname,outcome(p,result.bossDefeated),...[p.level,p.xp,p.heroKills,p.monsterKills].map(value=>p.abandoned?'—':value)])));
}
function apply(data){
  if(current?.room&&data.room?.roomId===current.room.roomId&&data.room.revision<current.room.revision)data.room=current.room;
  if(data.room?.failure==='RESULT_SAVE_FAILED'&&current?.room?.failure!==data.room.failure)notice(data.room.failure);
  current=data;$('login-panel').hidden=true;$('logout').hidden=false;render();
}
function render(){
  const room=current.room;$('home').hidden=!!room;$('room').hidden=!room;
  renderResults(room);
  document.body.classList.toggle('playing',!!room&&['Loading','Running'].includes(room.phase));
  $('room-list').replaceChildren();for(const r of current.rooms??[]){if(r.phase!=='Lobby')continue;const button=document.createElement('button');button.textContent=`${r.code} · ${r.count}/4 人`;button.onclick=()=>act('join',{code:r.code});$('room-list').append(button);}
  if(!room){destroyGame();refreshProgress();return;}
  const me=room.members.find(m=>m.playerId===current.playerId),owner=room.ownerId===current.playerId;
  $('code').textContent=room.code;$('phase').textContent={Lobby:'等待玩家',Loading:'正在载入',Running:'游戏进行中',Results:'本局结束',Failed:'游戏已中断'}[room.phase]??room.phase;
  $('players').replaceChildren();
  const colors=['#cc866e','#83afc8','#b4be79','#af95c3'];
  for(let slot=0;slot<4;slot++){
    const member=room.members.find(m=>m.slot===slot),card=document.createElement('article');card.className='player'+(member?'':' empty');card.style.setProperty('--player-color',colors[slot]);
    if(member){
      for(const [cls,text]of [['badge',member.tag],['name',member.nickname+(member.playerId===current.playerId?' · 你':'')+(member.playerId===room.ownerId?' · 房主':'')],['status'+(member.ready?' ready':''),member.abandoned?'已离开本局':room.phase==='Lobby'?(member.lobbyConnected?(member.ready?'已准备':'尚未准备'):'暂时离线'):(member.gameConnected?'游戏已连接':'等待连接')]]){const e=document.createElement('div');e.className=cls;e.textContent=text;card.append(e);}
      if(owner&&member.playerId!==current.playerId&&room.phase==='Lobby'){const kick=document.createElement('button');kick.className='quiet kick';kick.textContent='移出房间';kick.onclick=()=>act('kick',{playerId:member.playerId});card.append(kick);}
    }else card.textContent='等待玩家加入';$('players').append(card);
  }
  const inLobby=room.phase==='Lobby';$('profile-form').hidden=!inLobby;$('ready').hidden=!inLobby;$('start').hidden=!inLobby||!owner;
  $('return').hidden=!owner||!['Results','Failed'].includes(room.phase);$('ready').textContent=me?.ready?'取消准备':'准备';
  $('ready').disabled=!me?.lobbyConnected;$('start').disabled=room.members.length<2||room.members.some(m=>!m.ready||!m.lobbyConnected);
  for(const input of $('profile-form').elements)input.disabled=!!me?.ready;
  if(document.activeElement!==$('nickname'))$('nickname').value=me?.nickname??'';if(document.activeElement!==$('tag'))$('tag').value=me?.tag??'';
  $('hint').textContent=room.failure?(errors[room.failure]??room.failure):inLobby?'所有玩家准备后即可开始。图鉴与解锁沿用房主存档。':'刷新页面后可以回到同一席位。';
  $('leave').textContent=inLobby?'离开房间':'离开本局';
  if(['Loading','Running'].includes(room.phase)&&!me?.abandoned){if(gameMatch!==room.matchId)mountGame(room.matchId);}
  else destroyGame();
}
async function act(route,data={}){try{apply(await api(route,{revision:current?.room?.revision,...data}));}catch(error){notice(error.message);if(error.message==='AUTH_REQUIRED')showLogin();else if(error.message==='ROOM_CHANGED')apply(await api('state'));}}
function connectLobby(){
  clearTimeout(socketTimer);if(lobbySocket&&[0,1].includes(lobbySocket.readyState))return;
  const socket=lobbySocket=new WebSocket(location.origin.replace(/^http/,'ws')+'/lobby');
  socket.onopen=()=>{$('connection').textContent='大厅已连接';$('create').disabled=false;};
  socket.onmessage=event=>{const data=JSON.parse(event.data);if(data.type==='state')apply(data);};
  socket.onclose=()=>{$('connection').textContent='大厅重连中';$('create').disabled=true;if(current)socketTimer=setTimeout(connectLobby,1200);};
  socket.onerror=()=>{};
}
function mountGame(matchId){
  generation++;clearTimeout(reconnectTimer);iframe?.remove();gameMatch=matchId;$('game').hidden=false;$('curtain').hidden=false;$('curtain').textContent='正在载入游戏…';
  iframe=document.createElement('iframe');iframe.title='Crawl 游戏';iframe.allow='fullscreen; gamepad; autoplay';iframe.src='/game.html';$('game-frame').append(iframe);
}
function reconnect(){
  if(!current?.room||!['Loading','Running'].includes(current.room.phase))return;
  $('curtain').hidden=false;$('curtain').textContent='连接中断，正在恢复同一席位…';clearTimeout(reconnectTimer);
  reconnectTimer=setTimeout(async()=>{try{const data=await api('state');apply(data);if(current?.room?.matchId)mountGame(current.room.matchId);}catch(error){if(error.message==='AUTH_REQUIRED'){showLogin();notice(error.message);}else reconnect();}},1200);
}
window.addEventListener('offline',()=>{if(gameMatch){$('curtain').hidden=false;$('curtain').textContent='网络已断开，恢复后会自动重连。';}});
window.addEventListener('online',()=>{connectLobby();if(gameMatch)mountGame(gameMatch);});
window.addEventListener('message',async event=>{
  if(event.origin!==location.origin||event.source!==iframe?.contentWindow)return;
  const data=event.data,token=generation;
  if(data.type==='unity-progress'){$('curtain').textContent=`正在载入游戏 ${Math.round(data.progress*100)}%`;return;}
  if(data.type==='unity-ready'){
    updateVolume();
    updateFrameRate();
    $('curtain').textContent='正在连接游戏并同步场景…';
    while(token===generation){
      try{const ticket=await api('ticket',{});if(token===generation)iframe.contentWindow.postMessage({type:'configure',config:ticket},location.origin);return;}
      catch(error){if(error.message==='SERVER_LOADING'){await new Promise(resolve=>setTimeout(resolve,700));continue;}notice(error.message);if(error.message==='AUTH_REQUIRED')showLogin();else reconnect();return;}
    }
  }
  if(data.type==='game-state'){
    const s=data.state, failure=s.worldError||s.error;
    $('menu-keys').hidden=!s.canControl||!s.menu||!s.paused||!!failure;
    const gap=s.snapshotGapMs>0?` · 同步最长间隔 ${s.snapshotGapMs} ms`:'';
    const rates=s.renderFps>0?` · ${s.renderFps} FPS · 同步 ${s.syncFps}/秒${gap}`:'';
    const phase=s.paused?'游戏已暂停':'已连接';
    const status=failure?'对局连接中断':s.canControl?`${phase} · ${Math.round(s.roundTripMs??0)} ms${rates}`:'正在同步场景';
    if($('game-status').textContent!==status)$('game-status').textContent=status;
    if(failure){
      $('curtain').hidden=false;$('curtain').textContent=errors[failure]??'游戏连接已断开。';
      if(!s.worldError&&['DISCONNECTED','RESYNC_TIMEOUT'].includes(s.error))reconnect();
      else notice(failure);
    }else if(s.worldFrames>0)$('curtain').hidden=true;
  }
  if(data.type==='game-error'){$('curtain').hidden=false;$('curtain').textContent='游戏载入失败，请重新连接。';notice(data.message);}
});
$('login-form').onsubmit=async event=>{event.preventDefault();try{apply(await api('login',{key:$('key').value}));$('key').value='';connectLobby();if(inviteCode&&!current.room)await act('join',{code:inviteCode});}catch(error){notice(error.message);}};
$('create').onclick=()=>act('create');$('join-form').onsubmit=event=>{event.preventDefault();act('join',{code:$('room-code').value});};
$('profile-form').onsubmit=event=>{event.preventDefault();act('profile',{nickname:$('nickname').value,tag:$('tag').value.toUpperCase()});};
$('ready').onclick=async()=>{
  const room=current.room, me=room.members.find(member=>member.playerId===current.playerId), ready=!me.ready;
  $('ready').disabled=true;
  try{
    try{apply(await api('ready',{ready,revision:room.revision}));}
    catch(error){
      if(error.message!=='ROOM_CHANGED')throw error;
      apply(await api('state'));
      if(current.room?.roomId===room.roomId&&current.room.phase==='Lobby'&&current.room.members.find(member=>member.playerId===me.playerId)?.ready!==ready)
        apply(await api('ready',{ready,revision:current.room.revision}));
    }
  }catch(error){notice(error.message);}finally{if(current)render();}
};
$('start').onclick=()=>act('start',{requestId:crypto.randomUUID()});$('return').onclick=()=>act('return');
$('invite').onclick=async()=>{try{await navigator.clipboard.writeText(location.origin+'/?room='+current.room.code);notice('邀请链接已复制。朋友首次进入时仍需访问密钥。');}catch{notice('房间码：'+current.room.code);}};
$('leave').onclick=()=>{if(current.room.phase!=='Lobby'&&!confirm('离开后不能重新加入本局。确定离开？'))return;act('leave');};
$('logout').onclick=async()=>{try{await api('logout',{});current=null;lobbySocket?.close();showLogin();}catch(error){notice(error.message);}};
$('reconnect').onclick=()=>{if(gameMatch)mountGame(gameMatch);};
$('fullscreen').onclick=async()=>{
  try{
    if(document.fullscreenElement===$('game'))await document.exitFullscreen();
    else await $('game').requestFullscreen();
    iframe?.contentWindow?.focus();
  }catch(error){notice(error.message);}
};
document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement===$('game')?'退出全屏':'全屏';});
try{apply(await api('state'));connectLobby();if(inviteCode&&!current.room)await act('join',{code:inviteCode});}catch{showLogin();}
const launchKey=location.hash.slice(1);if(launchKey){history.replaceState(null,'',location.pathname+location.search);$('key').value=decodeURIComponent(launchKey);$('login-form').requestSubmit();}
