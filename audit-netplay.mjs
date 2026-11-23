import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url)),workspace=path.dirname(root);
const output=path.join(root,'analysis/netplay/audit');await fs.mkdir(output,{recursive:true});
async function walk(directory,extension){const out=[];for(const item of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())out.push(...await walk(file,extension));else if(file.endsWith(extension))out.push(file);}return out;}
const cs=path.join(root,'web-project/Assets/Scripts/Assembly-CSharp');
const definitions=new Map();
for(const file of await walk(cs,'.cs')){
  const lines=(await fs.readFile(file,'utf8')).split(/\r?\n/);
  lines.forEach((line,index)=>{const match=line.match(/^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:virtual\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/);if(match){const list=definitions.get(match[1])??[];list.push({path:path.relative(root,file).replaceAll('\\','/'),line:index+1});definitions.set(match[1],list);}});
}
const callbacks=new Map();let clipCount=0,eventCount=0;
for(const file of await walk(path.join(root,'web-project/Assets/MonoBehaviour'),'.asset')){
  const source=await fs.readFile(file,'utf8');if(!source.includes('\n  eventInfos:'))continue;clipCount++;
  const regexp=/^  - time: ([^\r\n]+)\r?\n    methodName: ([^\r\n]+)([\s\S]*?)(?=^  - time: |^  \w|$(?![\s\S]))/gm;
  for(const match of source.matchAll(regexp)){
    const method=match[2].trim();if(!method)continue;eventCount++;
    const list=callbacks.get(method)??[];
    const paramType=Number(match[3].match(/^    paramType: (\d+)/m)?.[1]??-1);
    list.push({clip:path.relative(root,file).replaceAll('\\','/'),time:Number(match[1]),paramType});callbacks.set(method,list);
  }
}
const rows=[...callbacks].sort(([a],[b])=>a.localeCompare(b)).map(([method,events])=>({method,count:events.length,definitions:definitions.get(method)??[],events,review:'pending individual authority/presentation classification'}));
await fs.writeFile(path.join(output,'animation-events.json'),JSON.stringify({clipCount,eventCount,methodCount:rows.length,scope:'Static inventory only, not proof that every callback works headlessly',callbacks:rows},null,2));
const protectedManifest=JSON.parse(await fs.readFile(path.join(root,'analysis/netplay/baseline/protected-manifest.json')));
const failures=[];
for(const entry of protectedManifest){try{const data=await fs.readFile(path.join(workspace,entry.path));if(createHash('sha256').update(data).digest('hex')!==entry.sha256)failures.push({path:entry.path,reason:'hash changed'});}catch(error){failures.push({path:entry.path,reason:error.code});}}
await fs.writeFile(path.join(output,'protected-files.json'),JSON.stringify({passed:failures.length===0,checked:protectedManifest.length,failures},null,2));
console.log(JSON.stringify({animationClips:clipCount,events:eventCount,uniqueCallbacks:rows.length,unresolvedCallbacks:rows.filter(r=>r.definitions.length===0).map(r=>r.method),protectedFiles:protectedManifest.length,protectedFailures:failures.length,output},null,2));
if(failures.length)process.exitCode=1;
