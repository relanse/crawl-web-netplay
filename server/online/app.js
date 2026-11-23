const $=id=>document.getElementById(id);
const errors={AUTH_REQUIRED:'请重新登录。',LOGIN_REFUSED:'访问密钥不正确。',ROOM_NOT_FOUND:'没有找到这个房间。',ROOM_FULL:'房间已满。',ROOM_CHANGED:'房间状态已更新，请再试一次。',UNREADY_FIRST:'请先取消准备再修改资料。',SERVER_BUSY:'服务器正在运行其他游戏，请稍后再试。',MATCH_ABANDONED:'你已离开本局，下一局开始后可以重新加入。',PLAYERS_NOT_READY:'请等待所有玩家准备。',OWNER_REQUIRED:'此操作需要房主执行。',PROCESS_EXITED:'游戏进程已退出，请返回大厅重新开局。',LOAD_TIMEOUT:'有玩家未能及时载入，已返回大厅。',ALL_OFFLINE:'所有玩家离线，本局已结束。',VERSION_MISMATCH:'游戏版本不同，请更新页面后重试。',SESSION_REPLACED:'这个席位已在另一个窗口连接。'};
let current=null,lobbySocket=null,socketTimer,gameMatch=null,iframe=null,generation=0,reconnectTimer,noticeTimer;
let overviewKey=null,progressRequest=0;
let progressData=null,standingsSort='overall',standingsQuery='';
const inviteCode=new URL(location.href).searchParams.get('room');
const volume=$('volume'), volumeKey='crawl-game-volume';
const frameRate=$('frame-rate'), frameRateKey='crawl-game-frame-rate';
const numFmt=new Intl.NumberFormat('zh-CN');
const matchTime=new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});

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
  SERVER_UPDATING:'服务器正在准备更新，现有对局可继续，新对局稍后开放。',
  RESULT_SAVE_FAILED:'战绩暂未保存，服务器正在重试。'
});

function notice(value){
  $('notice').textContent=errors[value]??value??'';
  clearTimeout(noticeTimer);
  if(value)noticeTimer=setTimeout(()=>{$('notice').textContent='';},7000);
}

async function api(route,data){
  let response;
  try{
    response=await fetch('/api/'+route,{
      method:data===undefined?'GET':'POST',
      headers:data===undefined?{}:{'Content-Type':'application/json'},
      body:data===undefined?undefined:JSON.stringify(data)
    });
  }catch{
    throw Error('网络连接中断，请稍后重试。');
  }
  const result=await response.json();
  if(!response.ok)throw Error(result.code??'请求失败');
  return result;
}

function destroyGame(){
  generation++;
  clearTimeout(reconnectTimer);
  iframe?.remove();
  iframe=null;
  gameMatch=null;
  $('game').hidden=true;
}

function showLogin(){
  current=null;
  overviewKey=null;
  progressData=null;
  destroyGame();
  $('login-panel').hidden=false;
  $('home').hidden=true;
  $('room').hidden=true;
  $('match-results').hidden=true;
  $('logout').hidden=true;
}

function formatDuration(seconds){
  if(!Number.isFinite(seconds)||seconds<0)return '';
  const mins=Math.floor(seconds/60), secs=seconds%60;
  return mins>0?`${mins} 分 ${secs} 秒`:`${secs} 秒`;
}

function formatBossKillRate(bossKills,completed){
  if(!completed)return '0%';
  return Math.round((bossKills/completed)*100)+'%';
}

function outcomeInfo(player,bossDefeated){
  if(player.abandoned)return {label:'中途退出',cls:'outcome-abandoned'};
  if(player.bossKill)return {label:'击败首领',cls:'outcome-win'};
  return bossDefeated
    ?{label:'首领已被击败',cls:'outcome-neutral'}
    :{label:'首领获胜',cls:'outcome-boss'};
}

function outcomePill(player,bossDefeated){
  const info=outcomeInfo(player,bossDefeated);
  const span=document.createElement('span');
  span.className='outcome-pill '+info.cls;
  span.textContent=info.label;
  return span;
}

function playerIdentityCell(nickname,tag,isSelf){
  const wrap=document.createElement('span');
  wrap.className='player-cell';
  if(tag){
    const chip=document.createElement('span');
    chip.className='tag-chip';
    chip.textContent=tag;
    wrap.append(chip);
  }
  const name=document.createElement('span');
  name.textContent=nickname||'未命名玩家';
  wrap.append(name);
  if(isSelf){
    const badge=document.createElement('span');
    badge.className='self-chip';
    badge.textContent='你';
    wrap.append(badge);
  }
  return wrap;
}

function rankBadge(rank){
  const span=document.createElement('span');
  span.className='rank-badge'+(rank<=3?' rank-'+rank:'');
  span.textContent=rank===1?'#1':rank===2?'#2':rank===3?'#3':String(rank);
  return span;
}

const sortMeta={
  overall:{
    subtitle:'全服综合前 20 名，按首领击败数、最高等级和英雄击杀排序。',
    metric:p=>`首领 ${p.bossKills} · Lv.${p.bestLevel} · 首领击败率 ${formatBossKillRate(p.bossKills,p.completed)}`
  },
  bossKills:{
    subtitle:'全服首领击败数前 20 名，同分按首领击败率与最高等级排序。',
    metric:p=>`首领 ${p.bossKills} 次 · 首领击败率 ${formatBossKillRate(p.bossKills,p.completed)}`
  },
  bestLevel:{
    subtitle:'全服历史最高英雄等级前 20 名。',
    metric:p=>`最高 Lv.${p.bestLevel} · 经验 ${numFmt.format(p.xp)}`
  },
  heroKills:{
    subtitle:'全服累计英雄击杀前 20 名。',
    metric:p=>`击杀英雄 ${p.heroKills} · 场次 ${p.completed}`
  },
  xp:{
    subtitle:'全服累计经验前 20 名。',
    metric:p=>`累计经验 ${numFmt.format(p.xp)} · Lv.${p.bestLevel}`
  }
};

function renderStandings(){
  if(!progressData||!current)return;
  const playerId=current.playerId;
  const meta=sortMeta[standingsSort]??sortMeta.overall;
  $('standings-subtitle').textContent=meta.subtitle;

  const ranked=progressData.leaderboard.map((p,index)=>({...p,rank:index+1}));

  const myEntry=ranked.find(p=>p.playerId===playerId);
  const rankPill=$('my-rank-pill');
  if(myEntry){
    rankPill.hidden=false;
    rankPill.textContent=`本榜第 ${myEntry.rank} 名`;
  }else if(progressData.leaderboard.length>0){
    rankPill.hidden=false;
    rankPill.textContent='暂未上榜';
  }else{
    rankPill.hidden=true;
  }

  const query=standingsQuery.trim().toLowerCase();
  const filtered=query
    ?ranked.filter(p=>(p.nickname||'').toLowerCase().includes(query)||(p.tag||'').toLowerCase().includes(query))
    :ranked;

  const podium=$('standings-podium');
  podium.replaceChildren();
  const showPodium=!query&&ranked.length>0;
  podium.hidden=!showPodium;
  if(showPodium){
    const labels=['第 1 名','第 2 名','第 3 名'];
    for(const p of ranked.slice(0,3)){
      const card=document.createElement('article');
      card.className='podium-card';
      card.dataset.rank=String(p.rank);
      if(p.playerId===playerId)card.dataset.self='';
      const head=document.createElement('div');
      head.className='podium-head';
      const rankEl=document.createElement('span');
      rankEl.className='podium-rank';
      rankEl.textContent=labels[p.rank-1];
      head.append(rankEl);
      if(p.tag){
        const tagEl=document.createElement('span');
        tagEl.className='tag-chip';
        tagEl.textContent=p.tag;
        head.append(tagEl);
      }
      const nameEl=document.createElement('div');
      nameEl.className='podium-name';
      nameEl.textContent=p.nickname+(p.playerId===playerId?' · 你':'');
      const metricEl=document.createElement('div');
      metricEl.className='podium-metric';
      metricEl.textContent=meta.metric(p);
      card.append(head,nameEl,metricEl);
      podium.append(card);
    }
  }

  $('standings').replaceChildren(...filtered.map(p=>{
    const row=document.createElement('tr');
    if(p.playerId===playerId)row.dataset.self='';
    const cells=[
      {node:rankBadge(p.rank)},
      {node:playerIdentityCell(p.nickname,p.tag,p.playerId===playerId)},
      {text:String(p.bossKills),num:true},
      {text:formatBossKillRate(p.bossKills,p.completed),num:true},
      {text:'Lv.'+p.bestLevel,num:true},
      {text:String(p.heroKills),num:true},
      {text:numFmt.format(p.xp),num:true},
      {text:String(p.completed),num:true}
    ];
    for(const c of cells){
      const td=document.createElement('td');
      if(c.num)td.className='num';
      if(c.node)td.append(c.node);
      else td.textContent=c.text;
      row.append(td);
    }
    return row;
  }));

  $('standings-table').hidden=filtered.length===0;
  $('standings-empty').hidden=filtered.length>0;
  $('standings-empty').textContent=progressData.leaderboard.length===0?'暂无已结算玩家。':'没有匹配该关键词的玩家。';
}

async function refreshProgress(force=false){
  if(!current)return;
  const sort=standingsSort,key=current.playerId+':'+current.progressVersion+':'+sort;
  if(!force&&overviewKey===key)return;
  overviewKey=key;
  const request=++progressRequest;
  $('my-rank-pill').hidden=true;
  $('progress-state').hidden=false;
  $('progress-state').textContent='正在载入战绩…';
  $('progress-totals').hidden=$('progress-tables').hidden=true;
  try{
    const data=await api('progress?sort='+encodeURIComponent(sort));
    if(overviewKey!==key||progressRequest!==request)return;
    progressData=data;
    const {self,recent}=data;
    const totals=self??{bestLevel:'—',xp:0,bossKills:0,completed:0,heroKills:0,monsterKills:0};
    const statDefs=[
      {title:'最高英雄等级',value:self?`Lv.${totals.bestLevel}`:'—',sub:self?`累计击杀英雄 ${totals.heroKills}`:'完成首局后记录',accent:'#dbb87e'},
      {title:'击败首领',value:String(totals.bossKills),sub:`首领击败率 ${formatBossKillRate(totals.bossKills,totals.completed)}`,accent:'#c44e3e'},
      {title:'累计经验',value:numFmt.format(totals.xp),sub:totals.completed?`场均 ${numFmt.format(Math.round(totals.xp/totals.completed))} 经验`:'等待首次结算',accent:'#83afc8'},
      {title:'完成对局',value:String(totals.completed),sub:`累计击杀怪物 ${numFmt.format(totals.monsterKills??0)}`,accent:'#8ac27e'}
    ];
    $('progress-totals').replaceChildren();
    for(const item of statDefs){
      const stat=document.createElement('div');
      stat.className='stat-card';
      stat.style.setProperty('--stat-accent',item.accent);
      const label=document.createElement('dt');
      label.textContent=item.title;
      const number=document.createElement('dd');
      number.textContent=item.value;
      const sub=document.createElement('div');
      sub.className='stat-sub';
      sub.textContent=item.sub;
      stat.append(label,number,sub);
      $('progress-totals').append(stat);
    }

    renderStandings();

    $('history').replaceChildren(...recent.map(p=>{
      const row=document.createElement('tr');
      const timeTd=document.createElement('td');
      const timeWrap=document.createElement('div');
      timeWrap.className='time-cell';
      const dateSpan=document.createElement('span');
      dateSpan.textContent=matchTime.format(p.completedAt);
      const durSpan=document.createElement('span');
      durSpan.className='time-duration';
      durSpan.textContent=formatDuration(p.durationSeconds);
      timeWrap.append(dateSpan,durSpan);
      timeTd.append(timeWrap);

      const outcomeTd=document.createElement('td');
      outcomeTd.append(outcomePill(p,p.bossDefeated));

      const levelTd=document.createElement('td');
      levelTd.className='num';
      levelTd.textContent=p.abandoned?'—':'Lv.'+p.level;

      const xpTd=document.createElement('td');
      xpTd.className='num';
      xpTd.textContent=p.abandoned?'—':numFmt.format(p.xp);

      const killsTd=document.createElement('td');
      killsTd.className='num';
      killsTd.textContent=p.abandoned?'—':`${p.heroKills} / ${p.monsterKills}`;

      row.append(timeTd,outcomeTd,levelTd,xpTd,killsTd);
      return row;
    }));

    $('history-table').hidden=recent.length===0;
    $('history-empty').hidden=recent.length>0;
    $('progress-state').hidden=true;
    $('progress-totals').hidden=$('progress-tables').hidden=false;
  }catch(error){
    if(overviewKey!==key||progressRequest!==request)return;
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
  if(!result){
    $('match-outcome').textContent='本局未完成首领结算。';
    return;
  }
  const winner=result.players.find(p=>p.bossKill);
  const title=winner?winner.nickname+' 击败了首领':result.bossDefeated?'首领已被击败':'首领获胜';
  $('match-outcome').textContent=title+' · '+formatDuration(result.durationSeconds);
  $('match-result-rows').replaceChildren(...result.players.map(p=>{
    const row=document.createElement('tr');
    if(p.playerId===current.playerId)row.dataset.self='';
    const nameTd=document.createElement('td');
    nameTd.append(playerIdentityCell(p.nickname,p.tag,p.playerId===current.playerId));
    const outcomeTd=document.createElement('td');
    outcomeTd.append(outcomePill(p,result.bossDefeated));
    row.append(nameTd,outcomeTd);
    for(const value of [p.abandoned?'—':'Lv.'+p.level,p.abandoned?'—':numFmt.format(p.xp),p.abandoned?'—':String(p.heroKills),p.abandoned?'—':String(p.monsterKills)]){
      const td=document.createElement('td');
      td.className='num';
      td.textContent=value;
      row.append(td);
    }
    return row;
  }));
}

function renderOpenRooms(rooms){
  const openRooms=(rooms??[]).filter(r=>r.phase==='Lobby');
  $('room-list-wrap').hidden=openRooms.length===0;
  $('room-list-count').textContent=`${openRooms.length} 个房间`;
  $('room-list').replaceChildren();
  for(const r of openRooms){
    const button=document.createElement('button');
    button.type='button';
    button.className='room-card';
    button.onclick=()=>act('join',{code:r.code});

    const top=document.createElement('div');
    top.className='room-card-top';
    const codeEl=document.createElement('span');
    codeEl.className='room-card-code';
    codeEl.textContent=r.code;
    const cta=document.createElement('span');
    cta.className='room-card-cta';
    cta.textContent='点击加入 →';
    top.append(codeEl,cta);

    const bottom=document.createElement('div');
    bottom.className='room-card-bottom';
    const dots=document.createElement('span');
    dots.className='slot-dots';
    dots.setAttribute('aria-hidden','true');
    for(let i=0;i<4;i++){
      const dot=document.createElement('span');
      dot.className='slot-dot'+(i<r.count?' filled':'');
      dots.append(dot);
    }
    const count=document.createElement('span');
    count.className='room-card-count';
    count.textContent=`${r.count}/4 人`;
    bottom.append(dots,count);

    button.append(top,bottom);
    $('room-list').append(button);
  }
}

function apply(data){
  if(current?.room&&data.room?.roomId===current.room.roomId&&data.room.revision<current.room.revision)data.room=current.room;
  if(data.room?.failure==='RESULT_SAVE_FAILED'&&current?.room?.failure!==data.room.failure)notice(data.room.failure);
  current=data;
  $('login-panel').hidden=true;
  $('logout').hidden=false;
  render();
}

function render(){
  const room=current.room;
  $('home').hidden=!!room;
  $('room').hidden=!room;
  renderResults(room);
  document.body.classList.toggle('playing',!!room&&['Loading','Running'].includes(room.phase));
  renderOpenRooms(current.rooms);

  if(!room){
    destroyGame();
    refreshProgress();
    return;
  }

  const me=room.members.find(m=>m.playerId===current.playerId);
  const owner=room.ownerId===current.playerId;
  const inLobby=room.phase==='Lobby';
  const readyCount=room.members.filter(m=>m.ready).length;

  $('code').textContent=room.code;
  $('phase').textContent={Lobby:'等待玩家',Loading:'正在载入',Running:'游戏进行中',Results:'本局结束',Failed:'游戏已中断'}[room.phase]??room.phase;
  $('room-ready-summary').hidden=!inLobby;
  $('room-ready-summary').textContent=`${room.members.length}/4 人 · ${readyCount}/${room.members.length} 已准备`;

  $('players').replaceChildren();
  const colors=['#d97b66','#6da9cc','#9fc472','#b58fd4'];
  for(let slot=0;slot<4;slot++){
    const member=room.members.find(m=>m.slot===slot);
    const card=document.createElement('article');
    const isReady=!!(member&&inLobby&&member.lobbyConnected&&member.ready);
    card.className='player'+(member?'':' empty')+(isReady?' is-ready-card':'');
    card.style.setProperty('--player-color',colors[slot]);

    if(member){
      const seatRow=document.createElement('div');
      seatRow.className='player-seat-row';
      const seatLabel=document.createElement('span');
      seatLabel.className='seat-label';
      seatLabel.textContent=`P${slot+1}`;
      const badges=document.createElement('div');
      badges.className='seat-badges';
      if(member.playerId===room.ownerId){
        const ownerPill=document.createElement('span');
        ownerPill.className='role-pill role-owner';
        ownerPill.textContent='房主';
        badges.append(ownerPill);
      }
      if(member.playerId===current.playerId){
        const selfPill=document.createElement('span');
        selfPill.className='role-pill role-self';
        selfPill.textContent='你';
        badges.append(selfPill);
      }
      seatRow.append(seatLabel,badges);

      const badge=document.createElement('div');
      badge.className='badge';
      badge.textContent=member.tag;

      const name=document.createElement('div');
      name.className='name';
      name.textContent=member.nickname;

      const statusText=member.abandoned?'已离开本局'
        :inLobby?(member.lobbyConnected?(member.ready?'已准备':'尚未准备'):'暂时离线')
        :(member.gameConnected?'游戏已连接':'等待连接');
      const status=document.createElement('div');
      status.className='status'+(member.ready&&inLobby?' ready':'');
      status.textContent=statusText;

      card.append(seatRow,badge,name,status);

      if(owner&&member.playerId!==current.playerId&&inLobby){
        const kick=document.createElement('button');
        kick.className='quiet kick';
        kick.textContent='移出房间';
        kick.onclick=()=>act('kick',{playerId:member.playerId});
        card.append(kick);
      }
    }else{
      const num=document.createElement('div');
      num.className='empty-slot-num';
      num.textContent=`P${slot+1}`;
      const label=document.createElement('div');
      label.textContent='等待玩家加入';
      card.append(num,label);
    }
    $('players').append(card);
  }

  $('profile-form').hidden=!inLobby;
  $('ready').hidden=!inLobby;
  $('start').hidden=!inLobby||!owner;
  $('return').hidden=!owner||!['Results','Failed'].includes(room.phase);
  $('ready').textContent=me?.ready?'取消准备':'准备';
  $('ready').classList.toggle('is-ready',!!me?.ready);
  $('ready').disabled=!me?.lobbyConnected;
  $('start').disabled=room.members.length<2||room.members.some(m=>!m.ready||!m.lobbyConnected);
  for(const input of $('profile-form').elements)input.disabled=!!me?.ready;
  if(document.activeElement!==$('nickname'))$('nickname').value=me?.nickname??'';
  if(document.activeElement!==$('tag'))$('tag').value=me?.tag??'';
  $('hint').textContent=room.failure?(errors[room.failure]??room.failure):inLobby?'所有玩家准备后即可开始。图鉴与解锁沿用房主存档。':'刷新页面后可以回到同一席位。';
  $('leave').textContent=inLobby?'离开房间':'离开本局';

  if(['Loading','Running'].includes(room.phase)&&!me?.abandoned){
    if(gameMatch!==room.matchId)mountGame(room.matchId);
  }else destroyGame();
}

async function act(route,data={}){
  try{
    apply(await api(route,{revision:current?.room?.revision,...data}));
  }catch(error){
    notice(error.message);
    if(error.message==='AUTH_REQUIRED')showLogin();
    else if(error.message==='ROOM_CHANGED')apply(await api('state'));
  }
}

function setConnectionState(state,text){
  const el=$('connection');
  el.dataset.state=state;
  el.textContent=text;
}

function connectLobby(){
  clearTimeout(socketTimer);
  if(lobbySocket&&[0,1].includes(lobbySocket.readyState))return;
  setConnectionState('connecting','连接中');
  const socket=lobbySocket=new WebSocket(location.origin.replace(/^http/,'ws')+'/lobby');
  socket.onopen=()=>{setConnectionState('online','大厅已连接');$('create').disabled=false;};
  socket.onmessage=event=>{const data=JSON.parse(event.data);if(data.type==='state')apply(data);};
  socket.onclose=()=>{setConnectionState('offline','大厅重连中');$('create').disabled=true;if(current)socketTimer=setTimeout(connectLobby,1200);};
  socket.onerror=()=>{};
}

function mountGame(matchId){
  generation++;
  clearTimeout(reconnectTimer);
  iframe?.remove();
  gameMatch=matchId;
  $('game').hidden=false;
  $('curtain').hidden=false;
  $('curtain').textContent='正在载入游戏…';
  iframe=document.createElement('iframe');
  iframe.title='Crawl 游戏';
  iframe.allow='fullscreen; gamepad; autoplay';
  iframe.src='/game.html';
  $('game-frame').append(iframe);
}

function reconnect(){
  if(!current?.room||!['Loading','Running'].includes(current.room.phase))return;
  $('curtain').hidden=false;
  $('curtain').textContent='连接中断，正在恢复同一席位…';
  clearTimeout(reconnectTimer);
  reconnectTimer=setTimeout(async()=>{
    try{
      const data=await api('state');
      apply(data);
      if(current?.room?.matchId)mountGame(current.room.matchId);
    }catch(error){
      if(error.message==='AUTH_REQUIRED'){showLogin();notice(error.message);}
      else reconnect();
    }
  },1200);
}

window.addEventListener('offline',()=>{
  setConnectionState('offline','网络已断开');
  if(gameMatch){$('curtain').hidden=false;$('curtain').textContent='网络已断开，恢复后会自动重连。';}
});
window.addEventListener('online',()=>{
  connectLobby();
  if(gameMatch)mountGame(gameMatch);
});

window.addEventListener('message',async event=>{
  if(event.origin!==location.origin||event.source!==iframe?.contentWindow)return;
  const data=event.data,token=generation;
  if(data.type==='unity-progress'){$('curtain').textContent=`正在载入游戏 ${Math.round(data.progress*100)}%`;return;}
  if(data.type==='unity-ready'){
    updateVolume();
    updateFrameRate();
    $('curtain').textContent='正在连接游戏并同步场景…';
    while(token===generation){
      try{
        const ticket=await api('ticket',{});
        if(token===generation)iframe.contentWindow.postMessage({type:'configure',config:ticket},location.origin);
        return;
      }catch(error){
        if(error.message==='SERVER_LOADING'){await new Promise(resolve=>setTimeout(resolve,700));continue;}
        notice(error.message);
        if(error.message==='AUTH_REQUIRED')showLogin();
        else reconnect();
        return;
      }
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
      $('curtain').hidden=false;
      $('curtain').textContent=errors[failure]??'游戏连接已断开。';
      if(!s.worldError&&['DISCONNECTED','RESYNC_TIMEOUT'].includes(s.error))reconnect();
      else notice(failure);
    }else if(s.worldFrames>0)$('curtain').hidden=true;
  }
  if(data.type==='game-error'){$('curtain').hidden=false;$('curtain').textContent='游戏载入失败，请重新连接。';notice(data.message);}
});

$('standings-sort').addEventListener('click',event=>{
  const btn=event.target.closest('.sort-tab');
  if(!btn||btn.dataset.sort===standingsSort)return;
  standingsSort=btn.dataset.sort;
  for(const tab of $('standings-sort').querySelectorAll('.sort-tab')){
    const active=tab===btn;
    tab.classList.toggle('is-active',active);
    tab.setAttribute('aria-selected',String(active));
  }
  refreshProgress();
});
$('standings-search').addEventListener('input',event=>{
  standingsQuery=event.target.value;
  renderStandings();
});
$('refresh-progress').onclick=()=>refreshProgress(true);

$('login-form').onsubmit=async event=>{
  event.preventDefault();
  try{
    apply(await api('login',{key:$('key').value}));
    $('key').value='';
    connectLobby();
    if(inviteCode&&!current.room)await act('join',{code:inviteCode});
  }catch(error){notice(error.message);}
};
$('create').onclick=()=>act('create');
$('join-form').onsubmit=event=>{
  event.preventDefault();
  act('join',{code:$('room-code').value.trim().toUpperCase()});
};
$('profile-form').onsubmit=event=>{
  event.preventDefault();
  act('profile',{nickname:$('nickname').value,tag:$('tag').value.toUpperCase()});
};
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
  }catch(error){notice(error.message);}
  finally{if(current)render();}
};
$('start').onclick=()=>act('start',{requestId:crypto.randomUUID()});
$('return').onclick=()=>act('return');
$('invite').onclick=async()=>{
  try{
    await navigator.clipboard.writeText(location.origin+'/?room='+current.room.code);
    notice('邀请链接已复制。朋友首次进入时仍需访问密钥。');
  }catch{
    notice('房间码：'+current.room.code);
  }
};
$('leave').onclick=()=>{
  if(current.room.phase!=='Lobby'&&!confirm('离开后不能重新加入本局。确定离开？'))return;
  act('leave');
};
$('logout').onclick=async()=>{
  try{await api('logout',{});current=null;lobbySocket?.close();showLogin();}
  catch(error){notice(error.message);}
};
$('reconnect').onclick=()=>{if(gameMatch)mountGame(gameMatch);};
$('fullscreen').onclick=async()=>{
  try{
    if(document.fullscreenElement===$('game'))await document.exitFullscreen();
    else await $('game').requestFullscreen();
    iframe?.contentWindow?.focus();
  }catch(error){notice(error.message);}
};
document.addEventListener('fullscreenchange',()=>{
  $('fullscreen').textContent=document.fullscreenElement===$('game')?'退出全屏':'全屏';
});

try{
  apply(await api('state'));
  connectLobby();
  if(inviteCode&&!current.room)await act('join',{code:inviteCode});
}catch{showLogin();}

const launchKey=location.hash.slice(1);
if(launchKey){
  history.replaceState(null,'',location.pathname+location.search);
  $('key').value=decodeURIComponent(launchKey);
  $('login-form').requestSubmit();
}
