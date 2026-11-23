import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export class GameProcesses {
  constructor({executable,directory,profileDirectory,controlBase,releaseId,contentHash,onStatus=()=>{},onExit=()=>{},capacity=2}){
    this.executable=path.resolve(executable);this.directory=path.resolve(directory);this.controlBase=controlBase;
    this.profileDirectory=profileDirectory;
    this.releaseId=releaseId;this.contentHash=contentHash;this.onStatus=onStatus;this.onExit=onExit;this.capacity=capacity;
    this.matches=new Map();this.timer=setInterval(()=>this.poll(),500);this.timer.unref();
  }
  start(room){
    const {matchId,processLeaseId,roster,ownerId}=room.match;
    if(this.matches.has(matchId))return this.matches.get(matchId).starting;
    const profilePath=this.profileDirectory&&path.join(this.profileDirectory,ownerId);
    if(this.matches.size>=this.capacity||(profilePath&&[...this.matches.values()].some(m=>m.profilePath===profilePath)))throw new Error('SERVER_BUSY');
    const record={matchId,processLeaseId,profilePath,roomId:room.roomId,secret:randomBytes(32).toString('base64url'),directory:path.join(this.directory,matchId),
      started:Date.now(),lastHeartbeat:Date.now(),sequence:0,command:0,stopping:false,polling:false};
    this.matches.set(matchId,record);
    record.starting=(async()=>{
      await fs.mkdir(record.directory,{recursive:true});
      if(profilePath)await fs.mkdir(profilePath,{recursive:true,mode:0o700});
      const rosterFile=path.join(record.directory,'roster.json');
      await fs.writeFile(rosterFile,JSON.stringify({revision:1,players:roster.map(m=>({...m,ready:true,connected:true}))}));
      const reservation=net.createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
      record.port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
      const graphics=process.platform==='linux'
        ? ['-force-glcore','-screen-width','640','-screen-height','360','-job-worker-count','1']
        : ['-force-d3d11','-screen-width','1280','-screen-height','720'];
      const child=record.child=spawn(this.executable,['-batchmode',...graphics,'-logFile',path.join(record.directory,'player.log')],{
        cwd:record.directory,windowsHide:true,stdio:'ignore',env:{...process.env,CRAWL_SERVER_DATA:record.directory,CRAWL_ROSTER_FILE:rosterFile,
          CRAWL_SERVER_PROFILE_DIRECTORY:profilePath??record.directory,
          CRAWL_GAME_PORT:String(record.port),CRAWL_CONTROL_URL:this.controlBase+'/control/'+matchId+'/redeem',CRAWL_CONTROL_SECRET:record.secret,
          CRAWL_ROOM_ID:room.roomId,CRAWL_MATCH_ID:matchId,CRAWL_PROCESS_LEASE:processLeaseId,CRAWL_RELEASE_ID:this.releaseId,CRAWL_CONTENT_HASH:this.contentHash}});
      let exited=false;
      const ended=(code,error)=>{if(exited)return;exited=true;record.exited=true;record.exitCode=code;this.matches.delete(matchId);this.onExit(record,error);};
      child.once('error',error=>ended(null,error));child.once('exit',(code)=>ended(code,null));
      return record;
    })().catch(error=>{this.matches.delete(matchId);this.onExit(record,error);throw error;});
    return record.starting;
  }
  async poll(){
    for(const record of this.matches.values()){
      if(record.polling||!record.child||record.exited)continue;record.polling=true;
      try{
        const status=JSON.parse(await fs.readFile(path.join(record.directory,'host-status.json'),'utf8'));
        if(status.matchId!==record.matchId||status.processLeaseId!==record.processLeaseId||status.contentHash!==this.contentHash)throw new Error('PROCESS_BINDING');
        if(status.sequence>record.sequence){record.sequence=status.sequence;record.lastHeartbeat=Date.now();record.status=status;this.onStatus(record,status);}
      }catch(error){
        if(error.message==='PROCESS_BINDING'){record.stopping=false;record.child.kill();}
        // An atomic file replacement can briefly be locked on Windows. The next
        // heartbeat reads a fresh file; stale data never renews the deadline.
      }finally{record.polling=false;}
      if(Date.now()-record.lastHeartbeat>(record.sequence?15_000:60_000))record.child.kill();
    }
  }
  async command(record,changes){
    record.commands=(record.commands??Promise.resolve()).then(async()=>{
      const temporary=path.join(record.directory,'host-command.tmp'),destination=path.join(record.directory,'host-command.json');
      record.revoked??=new Set();
      for(const playerId of changes.revokePlayerIds??[])record.revoked.add(playerId);
      await fs.writeFile(temporary,JSON.stringify({id:++record.command,...changes,revokePlayerIds:[...record.revoked]}));
      for(let attempt=0;;attempt++)try{await fs.rename(temporary,destination);break;}catch(error){
        if(attempt>=20||!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    });
    return record.commands;
  }
  async stop(matchId){
    const record=this.matches.get(matchId);if(!record)return;
    return record.stopPromise??=this.stopProcess(record);
  }
  async stopProcess(record){
    record.stopping=true;await record.starting.catch(()=>{});
    if(!record.child||record.exited)return;
    await this.command(record,{stop:true}).catch(()=>{});
    await Promise.race([new Promise(resolve=>record.child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);
    if(!record.exited){record.child.kill();await new Promise(resolve=>record.child.once('exit',resolve));}
  }
  async close(){clearInterval(this.timer);await Promise.all([...this.matches.keys()].map(id=>this.stop(id)));}
}
