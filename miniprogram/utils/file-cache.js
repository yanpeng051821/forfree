const session=require('./session');
const domain=require('./domain');
const hash=require('./sha256');
const INDEX='huoji.files.v1',BUDGET=60*1024*1024,RETENTION=7*24*60*60*1000;
const holders=new Map(),pending=new Map();
function index() { const value=wx.getStorageSync(INDEX);return Array.isArray(value)?value:[]; }
function owned(path) { return typeof path==='string' && wx.env && path.startsWith(wx.env.USER_DATA_PATH+'/') && !path.includes('/../') && !path.includes('/./') && /\/(?:huoji-cache-[a-f0-9-]+\.jpg|export-[a-f0-9-]+(?:\/[^/]+\.xlsx|\.xlsx)(?:\.part)?)$/.test(path); }
function size(path) { try { const value=wx.getFileSystemManager().statSync(path);return (value.stats || value).size; } catch(_){return null;} }
function protect(holder,paths) { holders.set(holder,(paths || []).filter(Boolean)); }
function retain(holder,paths) { holders.set(holder,[...new Set((holders.get(holder) || []).concat((paths || []).filter(Boolean)))]); }
function release(holder) { holders.delete(holder); }
function protectedPaths() {
  const refs=new Set([...holders.values()].flat());
  try {
    for(const key of wx.getStorageInfoSync().keys.filter(key=>key.startsWith('huoji.draft.v1.'))){
      const draft=wx.getStorageSync(key);
      if(!draft || !Array.isArray(draft.photos) || (draft.retired!==undefined && !Array.isArray(draft.retired)))return null;
      for(const photo of [...draft.photos,...(draft.retired || [])])if(photo && photo.path)refs.add(photo.path);
    }
  } catch(_){return null;}
  return refs;
}
function prune(incoming=0) {
  const refs=protectedPaths();if(!refs)return false;
  const entries=index().filter(entry=>entry && owned(entry.path) && Number.isSafeInteger(entry.size) && entry.size>0);
  let bytes=entries.reduce((sum,entry)=>sum+entry.size,0),now=Date.now();
  const kept=new Set(entries);
  for(const entry of [...entries].sort((a,b)=>a.usedAt-b.usedAt)){
    if(refs.has(entry.path))continue;
    const exists=size(entry.path)!==null;
    if(exists && bytes+incoming<=BUDGET && !(['export','partial'].includes(entry.kind) && now-entry.usedAt>RETENTION))continue;
    try{if(exists)wx.getFileSystemManager().unlinkSync(entry.path);kept.delete(entry);bytes-=entry.size;}catch(_){}
  }
  try{wx.setStorageSync(INDEX,entries.filter(entry=>kept.has(entry)));}catch(_){}
  return bytes+incoming<=BUDGET;
}
function get(binding,key) {
  session.assert(binding);const entries=index(),entry=entries.find(entry=>entry.owner===binding.owner && entry.key===key && owned(entry.path));
  if(!entry || size(entry.path)!==entry.size)return null;
  entry.usedAt=Date.now();try{wx.setStorageSync(INDEX,entries);}catch(_){}return entry.path;
}
function put(binding,key,path,kind='photo',sha256) {
  session.assert(binding);const bytes=size(path);if(!owned(path)||!Number.isSafeInteger(bytes)||bytes<=0)return;
  const entries=index().filter(entry=>entry.path!==path && !(entry.owner===binding.owner && entry.key===key));entries.push({owner:binding.owner,key,path,size:bytes,kind,sha256,usedAt:Date.now()});
  wx.setStorageSync(INDEX,entries);
}
function validFile(binding,path) {
  session.assert(binding);
  const entry=index().find(entry=>entry.owner===binding.owner && entry.path===path);
  if(!entry){try{wx.getFileSystemManager().accessSync(path);return true;}catch(_){return false;}}
  if(size(path)!==entry.size)return false;
  try{return !entry.sha256 || hash.fileDigest(wx.getFileSystemManager(),path,entry.size)===entry.sha256;}catch(_){return false;}
}
async function photo(binding,route,fetch) {
  session.assert(binding);
  if(!wx.env || !wx.env.USER_DATA_PATH || typeof wx.getFileSystemManager().statSync!=='function')return fetch();
  const cached=get(binding,route);if(cached)return cached;
  const key=domain.stable([binding.owner,binding.epoch,route]);
  if(pending.has(key))return pending.get(key);
  const promise=(async()=>{
    const source=await fetch();session.assert(binding);
    const bytes=size(source);if(!Number.isSafeInteger(bytes)||bytes<=0)return source;
    if(!prune(bytes)){try{wx.getFileSystemManager().unlinkSync(source);}catch(_){}throw session.error('CACHE_SPACE','本机缓存空间不足，请减少图片浏览或释放空间；草稿未删除');}
    const target=wx.env.USER_DATA_PATH+'/huoji-cache-'+domain.uuid()+'.jpg';
    wx.getFileSystemManager().renameSync(source,target);
    try{session.assert(binding);put(binding,route,target);return target;}catch(error){try{wx.getFileSystemManager().unlinkSync(target);}catch(_){}throw error;}
  })().finally(()=>pending.delete(key));
  pending.set(key,promise);return promise;
}
module.exports={get,put,photo,protect,retain,release,prune,size,validFile,BUDGET,RETENTION};
