import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createOnlineServer} from '../online-server.mjs';

test('official settlement updates history and rankings once and survives an online server restart',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'crawl-online-progress-'));
  const key='test-only-progress-key-0123456789',contentHash='a'.repeat(64),releaseId='progress-test';
  const executable=path.join(directory,'authority.exe'),web=path.join(directory,'web');
  await fs.mkdir(web);
  await fs.writeFile(path.join(directory,'build-report.json'),JSON.stringify({kind:'authority',result:'Succeeded',contentHash}));
  await fs.writeFile(path.join(web,'client-build.json'),JSON.stringify({kind:'client',releaseId,contentHash}));
  let app,origin;
  async function boot(){
    app=await createOnlineServer({executable,web,key,directory:path.join(directory,'matches')});
    origin=await app.listen(0);
  }
  async function request(route,cookie='',data){
    const response=await fetch(origin+'/api/'+route,{method:data===undefined?'GET':'POST',
      headers:{cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},body:JSON.stringify(data)});
    const value=await response.json();
    assert.equal(response.status,200,JSON.stringify(value));
    return {value,cookies:response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
  }
  async function login(cookie=''){
    const {value,cookies}=await request('login',cookie,{key});
    return {playerId:value.playerId,cookies,guest:cookies.split('; ').find(c=>c.startsWith('crawl_net_guest='))};
  }
  try{
    await boot();
    assert.equal((await fetch(origin+'/api/progress')).status,401);
    const hero=await login(),other=await login(),left=await login();
    const created=(await request('create',hero.cookies,{})).value.room;
    await request('profile',hero.cookies,{revision:created.revision,nickname:'红衣',tag:'RED'});
    for(const p of [other,left])await request('join',p.cookies,{code:created.code});
    const room=app.rooms.get(created.code).session;
    for(const p of [hero,other,left]){
      room.lobbyConnection(p.playerId,true);
      await request('ready',p.cookies,{revision:room.revision,ready:true});
    }
    app.processes.start=async()=>{};
    await request('start',hero.cookies,{revision:room.revision,requestId:'progress-1'});
    const {matchId,processLeaseId,ownerId}=room.match;
    assert.equal(ownerId,hero.playerId);
    const record={roomId:room.roomId,matchId,processLeaseId};
    const players=room.match.roster.map(({playerId})=>({playerId,epoch:1,connected:true}));
    app.processes.onStatus(record,{phase:'Running',players});
    assert.equal(room.phase,'Running');
    assert.deepEqual((await request('progress',hero.cookies)).value,{self:null,leaderboard:[],recent:[]});
    const result={completed:true,bossDefeated:true,winnerSlot:0,durationSeconds:611,players:[
      {slot:0,level:12,xp:99,heroKills:2,monsterKills:30,abandoned:false},
      {slot:1,level:8,xp:58,heroKills:4,monsterKills:16,abandoned:false},
      {slot:2,level:1,xp:0,heroKills:0,monsterKills:0,abandoned:true}
    ]};
    app.processes.onStatus(record,{phase:'Running',players,result});
    app.processes.onStatus(record,{phase:'Results',players,result});
    assert.equal(room.phase,'Results');
    assert.equal((await request('state',hero.cookies)).value.room.result.players[0].bossKill,1);
    const first=(await request('progress',hero.cookies)).value;
    assert.deepEqual([first.self.completed,first.self.bestLevel,first.self.xp,first.self.bossKills],[1,12,99,1]);
    assert.deepEqual(first.leaderboard.map(p=>p.playerId),[hero.playerId,other.playerId]);
    assert.equal((await request('progress',left.cookies)).value.recent[0].abandoned,1);
    await app.close();app=null;

    await boot();
    const returning=await login(hero.guest);
    assert.equal(returning.playerId,hero.playerId);
    assert.deepEqual((await request('progress',returning.cookies)).value,first);
    const rejoined=(await request('create',returning.cookies,{})).value.room.members[0];
    assert.deepEqual([rejoined.nickname,rejoined.tag],['红衣','RED']);
    const stranger=await login();
    assert.notEqual(stranger.playerId,hero.playerId);
    assert.equal((await request('progress',stranger.cookies)).value.self,null);
  }finally{
    if(app)await app.close();
    await fs.rm(directory,{recursive:true,force:true});
  }
});
