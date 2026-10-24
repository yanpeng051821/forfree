// Incremental SHA-256: bounded buffers for container blocks and local file reads.
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotate = (n,b) => (n >>> b) | (n << (32-b));
class Hash {
  constructor() { this.state=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];this.pending=new Uint8Array(64);this.used=0;this.length=0; }
  clone() { const copy=new Hash();copy.state=this.state.slice();copy.pending.set(this.pending);copy.used=this.used;copy.length=this.length;copy.done=this.done;return copy; }
  block(bytes) {
    const words=new Uint32Array(64);
    for(let i=0;i<16;i++)words[i]=(bytes[i*4]<<24)|(bytes[i*4+1]<<16)|(bytes[i*4+2]<<8)|bytes[i*4+3];
    for(let i=16;i<64;i++){const a=words[i-15],b=words[i-2];words[i]=(words[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
    let [a,b,c,d,e,f,g,h]=this.state;
    for(let i=0;i<64;i++){const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+words[i])>>>0,t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    [a,b,c,d,e,f,g,h].forEach((v,i)=>this.state[i]=(this.state[i]+v)>>>0);
  }
  update(value) {
    if(this.done)throw new Error('Hash already finalized');
    const bytes=value instanceof Uint8Array?value:new Uint8Array(value);this.length+=bytes.length;
    for(let offset=0;offset<bytes.length;){const count=Math.min(64-this.used,bytes.length-offset);this.pending.set(bytes.subarray(offset,offset+count),this.used);this.used+=count;offset+=count;if(this.used===64){this.block(this.pending);this.used=0;}}
    return this;
  }
  digest() {
    if(this.done)return this.done;
    const bits=this.length*8;this.pending[this.used++]=128;
    if(this.used>56){this.pending.fill(0,this.used);this.block(this.pending);this.used=0;}
    this.pending.fill(0,this.used,56);
    const view=new DataView(this.pending.buffer);view.setUint32(56,Math.floor(bits/0x100000000));view.setUint32(60,bits>>>0);this.block(this.pending);
    this.done=this.state.map(value=>value.toString(16).padStart(8,'0')).join('');return this.done;
  }
}
function digest(bytes) { return new Hash().update(bytes).digest(); }
function fileHash(fs,path,size) {
  const hash=new Hash(),fd=fs.openSync({filePath:path,flag:'r'});
  try {
    const buffer=new ArrayBuffer(Math.min(655360,size));
    for(let position=0;position<size;){const length=Math.min(buffer.byteLength,size-position),result=fs.readSync({fd,arrayBuffer:buffer,position,length,offset:0});if(result.bytesRead!==length)throw new Error('文件读取不完整');hash.update(new Uint8Array(buffer,0,length));position+=length;}
    return hash;
  } finally { fs.closeSync({fd}); }
}
function fileDigest(fs,path,size) { return fileHash(fs,path,size).digest(); }
function textDigest(text) { const bytes=[];for(const char of text){const n=char.codePointAt(0);if(n<128)bytes.push(n);else if(n<2048)bytes.push(192|(n>>6),128|(n&63));else if(n<65536)bytes.push(224|(n>>12),128|((n>>6)&63),128|(n&63));else bytes.push(240|(n>>18),128|((n>>12)&63),128|((n>>6)&63),128|(n&63));}return digest(new Uint8Array(bytes)); }
module.exports={Hash,digest,fileHash,fileDigest,textDigest};
