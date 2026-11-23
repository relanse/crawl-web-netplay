import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createOnlineServer} from './online-server.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const directory=path.join(here,'online-data');await fs.mkdir(directory,{recursive:true});
const keyFile=path.join(directory,'access-key.txt');let key;
try{key=(await fs.readFile(keyFile,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;key=randomBytes(24).toString('base64url');await fs.writeFile(keyFile,key,{flag:'wx'});}
let tunnel,app,closing=false,timer;const id=randomBytes(16).toString('hex'),port=8792;
async function close(){if(closing)return;closing=true;clearInterval(timer);await app?.close();tunnel?.kill();await fs.rm(path.join(directory,'launcher.json'),{force:true});process.exit(0);}
try{
  let publicOrigin='';
  if(process.argv.includes('--public')){
    tunnel=spawn(path.join(here,'../tools/cloudflared.exe'),['tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:'+port],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    publicOrigin=await new Promise((resolve,reject)=>{
      let output='';const timeout=setTimeout(()=>reject(Error('公网连接超时，请查看 tunnel.log。')),60_000);
      const finish=(error,value)=>{clearTimeout(timeout);error?reject(error):resolve(value);};
      tunnel.once('error',error=>finish(error));tunnel.once('exit',()=>finish(Error('公网连接已退出。')));
      tunnel.stderr.on('data',chunk=>{const text=chunk.toString();output=(output+text).slice(-32000);fs.appendFile(path.join(directory,'tunnel.log'),text).catch(()=>{});const url=/https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output);if(url&&output.includes('Registered tunnel connection'))finish(null,url[0]);});
    });
  }
  app=await createOnlineServer({key,publicOrigin,directory:path.join(directory,'matches')});const origin=await app.listen(port);
  await fs.writeFile(path.join(directory,'launcher.json'),JSON.stringify({id,pid:process.pid,origin,started:new Date().toISOString()}));
  await fs.writeFile(path.join(directory,'联机邀请.txt'),origin+'\n访问密钥：'+key+'\n使用 Chrome 或 Edge，每位玩家使用自己的浏览器。\n'+(publicOrigin?'关闭服务或隧道重启后，请使用新邀请。':'本地模式只供这台电脑访问；邀请朋友请运行“开启公网联机”。')+'\n');
  timer=setInterval(async()=>{try{if((await fs.readFile(path.join(directory,'stop-request'),'utf8')).trim()===id)await close();}catch{}},1000);timer.unref();
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.once(signal,close);
  console.log('Ready: '+origin);
}catch(error){console.error(error.message);await app?.close();tunnel?.kill();process.exitCode=1;}
