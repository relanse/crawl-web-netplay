import {closeSync,openSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const [archive,...ssh]=process.argv.slice(2);
const input=openSync(archive,'r');
try{
  const result=spawnSync('ssh.exe',ssh,{stdio:[input,'inherit','inherit']});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}finally{closeSync(input);}
