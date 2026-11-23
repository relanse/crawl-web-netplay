import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=path.join(root,'analysis/netplay/windows-probe/CrawlAuthorityProbe.exe');
await fs.access(executable);
const runId=new Date().toISOString().replace(/[:.]/g,'-');
const directory=path.join(root,'server/test-results/netplay/authority-'+runId);
await fs.mkdir(directory,{recursive:true});
const log=path.join(directory,'player.log'),samples=[],checks=[];
let id=0,exitResult=null,latest;
const process=spawn(executable,['-batchmode','-nographics','-screen-width','1280','-screen-height','720','-logFile',log],{
  cwd:directory,windowsHide:true,env:{...globalThis.process.env,CRAWL_SERVER_DATA:directory},stdio:'ignore'
});
const exited=new Promise(resolve=>process.once('exit',(code,signal)=>{exitResult={code,signal};resolve(exitResult);}));
process.on('error',error=>{exitResult={error:String(error)};});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function status(){
  if(exitResult)throw new Error('Authority exited: '+JSON.stringify(exitResult));
  const deadline=Date.now()+2500;
  for(let attempt=0;;attempt++)try{latest=JSON.parse(await fs.readFile(path.join(directory,'status.json'),'utf8'));break;}catch(error){
    if(error.code==='ENOENT'&&latest===undefined)return undefined;
    if(!['ENOENT','EBUSY','EPERM','EACCES'].includes(error.code)||Date.now()>=deadline)throw error;
    await sleep(Math.min(100,25+attempt*10));
  }
  if(latest&&samples.at(-1)?.frame!==latest.frame)samples.push(latest);
  return latest;
}
async function command(inputs=[],quit=false){
  const temporary=path.join(directory,'command.tmp');
  await fs.writeFile(temporary,JSON.stringify({id:++id,inputs,quit}));
  for(let attempt=0;;attempt++)try{await fs.rename(temporary,path.join(directory,'command.json'));break;}catch(error){if(attempt>=10)throw error;await sleep(20);}
}
const packet=(slot,x=0,y=0,buttons=0)=>({slot,x,y,buttons,pressed:buttons,connected:true});
async function drive(ms,make){
  const until=Date.now()+ms;
  while(Date.now()<until){await command(make());await sleep(120);await status();}
}
let failed;
try{
  console.log('Authority probe directory: '+directory);
  const deadline=Date.now()+110_000;
  while(Date.now()<deadline){
    const s=await status();
    if(s?.scene==='SceneGame'&&s.actors[0].objectName&&s.actors[1].objectName)break;
    if(s?.scene==='SceneMenuIntroAnimatic')await command([packet(0,0,0,id%2?0:1)]);
    await sleep(250);
  }
  assert.equal(latest?.scene,'SceneGame','Native authority did not reach SceneGame');
  assert.equal(latest.mode,'AuthorityServer');assert.equal(latest.graphics,'Null');assert.equal(latest.steam,false);
  checks.push('Original two-player match starts in native null-graphics authority with Steam disabled');
  console.log(checks.at(-1));
  // Narration length varies by randomly selected original intro. Wait for the
  // actual gameplay state rather than assuming an arbitrary 18-second clip.
  const introDeadline=Date.now()+70_000;
  while(Date.now()<introDeadline){
    await drive(250,()=>[packet(0),packet(1)]);
    if(latest.actors.slice(0,2).every(a=>a.state&&a.state!=='Cutscene'&&a.state!=='Spawn'))break;
  }
  assert.ok(latest.actors.slice(0,2).every(a=>a.state&&a.state!=='Cutscene'&&a.state!=='Spawn'),'Original intro did not release control');
  const before=structuredClone(latest.actors);
  await drive(1400,()=>[packet(0,1),packet(1)]);
  await drive(500,()=>[packet(0),packet(1)]);
  const after=structuredClone(latest.actors);
  assert.ok(Math.hypot(after[0].x-before[0].x,after[0].y-before[0].y)>2,'Player did not move');
  checks.push('Server-controlled input produces real original movement');console.log(checks.at(-1));
  const attacksBefore=latest.attackCallbacks;
  await drive(4000,()=>[packet(0,0,0,id%3===0?1:0),packet(1,0,0,id%3===0?1:0)]);
  assert.ok(latest.attackCallbacks>attacksBefore,'Animation-driven attack callbacks never executed without rendering');
  checks.push('Original animation attack callbacks execute without a rendered frame');console.log(checks.at(-1));
  const damageBefore=latest.damageCommits;
  await drive(18_000,()=>{
    const a=latest.actors[0],b=latest.actors[1],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    return [packet(0,length>7?dx/length:0,length>7?dy/length:0,id%3===0?1:0),packet(1)];
  });
  assert.ok(latest.damageCommits>damageBefore,'Original attacks did not commit damage through Health.Damage');
  checks.push('Original attack collision causes damage without graphics');console.log(checks.at(-1));
  assert.ok(!latest.actors[1].hero,'Defeated player did not become a ghost');
  const aftermathDeadline=Date.now()+25_000;
  while(Date.now()<aftermathDeadline&&(!latest.actors[1].objectName?.includes('Ghost')||!latest.exits?.some(e=>e.connected&&e.open&&!e.blocked)))
    await drive(250,()=>[packet(0),packet(1)]);
  assert.ok(latest.actors[1].objectName?.includes('Ghost'),'Death did not finish spawning the original ghost');
  checks.push('Original hero battle resolves a death and converts the defeated player to a ghost');console.log(checks.at(-1));
  const startingRoom={name:latest.room,x:latest.roomX,y:latest.roomY};
  const exit=latest.exits?.find(value=>value.connected&&value.open&&!value.blocked);
  assert.ok(exit,'No traversable original exit after the hero battle');
  const goal={x:exit.x+exit.dx*24,y:exit.y+exit.dy*24};
  const approach={x:exit.x-exit.dx*20,y:exit.y-exit.dy*20};let aligned=false;
  await drive(12_000,()=>{
    if(latest.roomX!==startingRoom.x||latest.roomY!==startingRoom.y)return [packet(0),packet(1)];
    const actor=latest.actors[0];if(Math.hypot(approach.x-actor.x,approach.y-actor.y)<4)aligned=true;
    const target=aligned?goal:approach,dx=target.x-actor.x,dy=target.y-actor.y,length=Math.hypot(dx,dy);
    return [packet(0,length>2?dx/length:0,length>2?dy/length:0),packet(1)];
  });
  assert.ok(latest.roomX!==startingRoom.x||latest.roomY!==startingRoom.y,'Hero failed to traverse the original room exit');
  checks.push('Original door traversal changes the active room without graphics');console.log(checks.at(-1));
  assert.equal(latest.exceptions,0,'Runtime emitted errors; see player.log');
  assert.ok(latest.headlessCommitFrames>0&&latest.spriteManagers>0,'Headless geometry boundary was not running');
  checks.push('Headless geometry boundary runs camera-manager commits without a graphics device');
  await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,scope:'Native authority feasibility only; not network multiplayer; possession and bosses still need separate verification',checks,before,after,latest},null,2));
}catch(error){
  failed=error;
  await fs.writeFile(path.join(directory,'failure.json'),JSON.stringify({passed:false,error:String(error),checks,latest},null,2));
}finally{
  await fs.writeFile(path.join(directory,'samples.json'),JSON.stringify(samples,null,2));
  if(!exitResult){await command([],true).catch(()=>{});await Promise.race([exited,sleep(5000)]);}
  if(!exitResult){process.kill();await Promise.race([exited,sleep(5000)]);}
}
if(failed)throw failed;
console.log('Probe complete: '+path.join(directory,'result.json'));
