import {inflateRawSync} from 'node:zlib';

// QA-only reader of server world messages. Never records auth or ticket packets.
const id=name=>{let h=0x811c9dc5;for(const c of name)h=Math.imul(h^c.charCodeAt(0),0x1000193);return ((h>>>16)^h)&65535;};
const begin=id('CrawlBaselineBegin'),chunk=id('CrawlBaselineChunk'),end=id('CrawlBaselineEnd');
export function observeWorld(){
  let pending,latest,previous,previousFrame;
  return {get latest(){return latest;},receive(payload){
    const b=Buffer.from(payload);let at=8;
    while(at<b.length){
      const tag=b[at++];let size;
      if(tag<241)size=tag;else if(tag<=248)size=240+(tag-241)*256+b[at++];
      else if(tag===249){size=2288+b[at]*256+b[at+1];at+=2;}else{const n=tag-247;size=b.readUIntLE(at,n);at+=n;}
      const m=b.subarray(at,at+size);at+=size;const type=m.readUInt16LE(0);
      if(![begin,chunk,end].includes(type))continue;
      const frame=m.readUInt32LE(44);
      if(type===begin)pending={frame,chunks:[],count:m.readUInt16LE(52)};
      if(type===chunk&&pending?.frame===frame)pending.chunks[m.readUInt16LE(48)]=Buffer.from(m.subarray(52));
      if(type===end&&pending?.frame===frame&&pending.chunks.filter(Boolean).length===pending.count){
        const packed=Buffer.concat(pending.chunks),size=packed.readInt32LE(0),delta=size<0;
        const body=inflateRawSync(packed.subarray(delta?8:4));
        if(body.length!==(size&0x7fffffff))throw Error('QA world size mismatch');
        if(delta){
          if(!previous||previousFrame!==packed.readUInt32LE(4))throw Error('QA world delta baseline mismatch');
          for(let i=0;i<Math.min(body.length,previous.length);i++)body[i]^=previous[i];
        }
        previous=body;previousFrame=frame;
        latest=inspect(body);pending=null;
      }
    }
  }};
}
function inspect(b){
  let at=0;const u=()=>{const x=b.readUInt32LE(at);at+=4;return x;},short=()=>{const x=b.readUInt16LE(at);at+=2;return x;};
  const str=()=>{const n=short();const s=b.toString('utf8',at,at+Math.max(0,n-1));at+=Math.max(0,n-1);return s;};
  const vector=n=>{const v=[];for(let i=0;i<n;i++){v.push(b.readFloatLE(at));at+=4;}return v;};
  if(u()!==0x43574631)throw Error('QA world magic');str();const scene=u(),tick=u();at+=8+1+128+16;
  const entities=[];for(let n=u();n--;){const entity=u();at+=4+1;const position=vector(3);at+=12+8;entities.push({entity,position,state:str()});}
  for(let n=u();n--;){at+=4+12+1;const doors=u();at+=doors*15;}
  const actors=[];for(let n=u();n--;){actors.push(u());at+=8;}
  const palettes=[];for(let n=u();n--;){const id=u(),w=short(),h=short(),colors=new Set();for(let j=0;j<w*h;j++)colors.add(u());palettes.push({id,colors:colors.size});}
  const sprites=[];for(let n=u();n--;){const s={id:u(),entity:u(),texture:u(),shader:u(),palette:u(),pivot:vector(3)};at+=16;s.tint=vector(4);s.textureST=vector(4);s.clipped=!!b[at++];if(s.clipped){s.clipRect=vector(4);at+=64;}s.uv=[];for(let j=0;j<4;j++){at+=12;s.uv.push(vector(2));at+=4;}sprites.push(s);}
  return {scene,tick,actors,entities,palettes,sprites};
}
