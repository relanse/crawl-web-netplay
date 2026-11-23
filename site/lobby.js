(()=>{
  if(window.__CRAWL_HOST__)return;
  const $=id=>document.getElementById(id),profile=$('lobby-profile'),name=$('lobby-name'),tag=$('lobby-tag'),deity=$('lobby-deity');
  let room=null,dirty=false,committed='',catalog='',roster='',previousPhase='',saving=false;
  const own=()=>room?.players.find(p=>p.slot===window.crawlOnline.slot);
  const command=data=>window.crawlOnline.command(data);
  const fieldState=p=>JSON.stringify([p.name,p.tag,p.deity]);
  const draftState=()=>JSON.stringify([name.value.trim(),tag.value,Number(deity.value)]);
  const faith=id=>id===-1?'随机信仰':room?.deities.find(d=>d.id===id)?.name||'等待同步';
  const element=(type,className,text)=>{const node=document.createElement(type);node.className=className;node.textContent=text;return node;};
  function describe(){
    const choice=room?.deities.find(d=>d.id===Number(deity.value));
    $('deity-description').textContent=choice?(choice.trial?'试炼 · ':'')+choice.description:'由原版从已解锁的信仰中随机选择。';
  }
  function buttons(){
    const me=own();if(!me)return;
    const selectable=room.phase==='selecting'&&window.crawlOnline.socket?.readyState===1&&window.crawlOnline.mediaReady,prepared=room.game?.lobbyPhase==='selecting'&&room.state==='ready';
    for(const control of profile.elements)control.disabled=!selectable||me.ready||saving;
    $('lobby-save').disabled=!selectable||me.ready||!dirty||saving;
    $('lobby-ready').disabled=!selectable||!prepared||dirty||saving;
    $('lobby-ready').textContent=me.ready?'取消准备':'我准备好了';
    $('lobby-ready').classList.toggle('secondary',me.ready);
    $('lobby-start').hidden=room.ownerSlot!==me.slot;
    $('lobby-start').disabled=!room.canStart;
    const ready=room.players.filter(p=>p.connected&&p.ready).length;
    $('lobby-start-hint').textContent=dirty?'选择尚未保存，保存后即可准备。':!prepared?'游戏正在准备，稍后即可确认角色。':room.phase==='starting'?'正在进入地牢…':room.players.length<2?'至少 2 位玩家才能开始，邀请朋友加入吧。':room.canStart?(room.ownerSlot===me.slot?'所有人已准备，点击开始对局。':'所有人已准备，等待房主开局。'):`${ready} / ${room.players.length} 人已准备，${room.ownerSlot===me.slot?'你是房主。':'等待房主统一开局。'}`;
  }
  function render(data){
    room=data;const me=own();if(!me)return;
    $('online-form').hidden=true;$('room-intro').hidden=true;
    $('play-mode').textContent=data.phase==='playing'?'联机对局':'联机选人大厅';
    const selecting=data.phase!=='playing';
    $('web-lobby').hidden=!selecting;$('lobby-controls').hidden=!selecting;
    $('fullscreen').disabled=selecting;
    if(data.phase==='playing'&&previousPhase!=='playing'){$('online-video').focus();$('online-state').textContent='对局已开始。点击画面操作，祝你活着出来。';}
    previousPhase=data.phase;
    $('self-slot').textContent=(me.slot+1)+' 号'+(data.ownerSlot===me.slot?' · 房主':'');
    $('lobby-count').textContent=data.players.filter(p=>p.connected).length+' / 4';
    $('lobby-title').textContent=data.phase==='starting'?'地牢大门正在开启':'集结你的对手';
    $('lobby-hint').textContent=data.phase==='starting'?'正在按大家的选择开始原版对局…':'在右侧选择信仰并准备。英雄之位将在开局时争夺。';
    $('lobby-progress').textContent=data.state==='starting'?'首次启动游戏，请稍候…':data.phase==='starting'?'正在开始对局…':data.players.filter(p=>p.ready&&p.connected).length+' / '+data.players.length+' 人已准备';
    const nextCatalog=JSON.stringify(data.deities);
    if(nextCatalog!==catalog){
      const selected=deity.value;catalog=nextCatalog;deity.replaceChildren(new Option('随机信仰','-1'));
      for(const choice of data.deities){const option=new Option((choice.trial?'试炼 · ':'')+choice.name+(choice.unlocked?'':' · 未解锁'),String(choice.id));option.disabled=!choice.unlocked;deity.add(option);}
      if([...deity.options].some(o=>o.value===selected))deity.value=selected;
    }
    const next=fieldState(me);
    if(saving&&draftState()===next){saving=false;dirty=false;}
    if(!committed||(!dirty&&!saving&&next!==committed)){name.value=me.name;tag.value=me.tag;deity.value=String(me.deity);}
    committed=next;describe();buttons();
    const nextRoster=JSON.stringify([data.players,data.ownerSlot,data.deities,me.slot]);
    if(roster===nextRoster)return;roster=nextRoster;
    const cards=[];
    for(let slot=0;slot<4;slot++){
      const member=data.players.find(p=>p.slot===slot),card=element('article','seat-card'+(!member?' empty':'')+(slot===me.slot?' mine':''),'');card.dataset.slot=slot;
      const top=element('div','seat-top','');top.append(element('span','',String(slot+1).padStart(2,'0')+' / 玩家'),element('b','',member?(slot===me.slot?'你':'')+(data.ownerSlot===slot?' · 房主':''):''));
      const status=!member?'等待加入':!member.connected?'暂时离线':member.ready?'已准备':'选择中';
      card.append(top,element('div','seat-emblem',member?.tag||'+'),element('p','seat-name',member?.name||'留个位置给朋友'),element('p','seat-deity',member?faith(member.deity):'输入密钥即可加入'),element('span','seat-status'+(member?.ready?' ready':'')+(member&&!member.connected?' offline':''),(member?.ready?'✓ ':'')+status));cards.push(card);
    }
    $('lobby-seats').replaceChildren(...cards);
  }
  profile.addEventListener('input',()=>{tag.value=tag.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,3);dirty=draftState()!==committed;describe();buttons();});
  profile.onsubmit=event=>{
    event.preventDefault();if(!profile.reportValidity()||!own()||own().ready)return;
    saving=true;buttons();command({type:'lobby-profile',name:name.value.trim(),tag:tag.value,deity:Number(deity.value)});
  };
  $('lobby-ready').onclick=()=>{const me=own();if(me&&!dirty&&!saving)command({type:'lobby-ready',ready:!me.ready});};
  $('lobby-start').onclick=()=>{if(room?.canStart)command({type:'lobby-start'});};
  window.addEventListener('crawl-room',event=>render(event.detail));
  window.addEventListener('crawl-online-joined',()=>{committed='';dirty=false;saving=false;roster='';previousPhase='';$('web-lobby').hidden=false;$('online-form').hidden=true;$('room-intro').hidden=true;$('play-mode').textContent='正在进入房间';});
  window.addEventListener('crawl-online-ended',()=>{room=null;dirty=false;saving=false;committed='';roster='';$('web-lobby').hidden=true;$('lobby-controls').hidden=true;$('online-form').hidden=false;$('room-intro').hidden=false;$('play-mode').textContent='本地游玩';});
  window.addEventListener('crawl-online-error',()=>{saving=false;buttons();});
})();
