const api = require('./api');
const session = require('./session');
const domain = require('./domain');
const drafts = require('./draft');
const jobs = require('./jobs');
const hash=require('./sha256');
const cache=require('./file-cache');
let requestedView = null;
function requestProductView(binding, mode) { session.assert(binding); if (mode === 'day' || mode === 'task') requestedView = { owner: binding.owner, mode }; }
function consumeProductView(binding) { session.assert(binding); const request = requestedView; requestedView = null; return request && request.owner === binding.owner ? request.mode : null; }
function activeKey(owner) { return 'huoji.activeProject.' + owner; }
function activeProject(binding) { session.assert(binding); return wx.getStorageSync(activeKey(binding.owner)) || ''; }
let merchantView=null;
function rememberMerchantView(binding,visit){session.assert(binding);wx.setStorageSync('huoji.merchantView.'+binding.owner,{projectId:visit.projectId,supplier:visit.supplier,supplierContact:visit.supplierContact || '',date:visit.date});}
function rememberedMerchant(binding){session.assert(binding);const value=wx.getStorageSync('huoji.merchantView.'+binding.owner);return value && value.projectId===activeProject(binding) && (typeof value.supplier==='string' || value.supplier===null) && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value:null;}
function selectMerchant(binding,visit){session.assert(binding);wx.setStorageSync(activeKey(binding.owner),visit.projectId);rememberMerchantView(binding,visit);merchantView={owner:binding.owner,...visit};requestProductView(binding,'task');}
function consumeMerchant(binding){session.assert(binding);const value=merchantView;merchantView=null;return value && value.owner===binding.owner ? value:null;}
function selectProject(binding, id) { session.assert(binding); merchantView=null;wx.removeStorageSync('huoji.merchantView.'+binding.owner);wx.setStorageSync(activeKey(binding.owner), id); requestProductView(binding, 'task'); }
function comparisonScope(options){const base=options.dateFrom ? 'range:'+options.dateFrom+':'+options.dateTo : options.date ? 'day:'+options.date : options.favorite ? 'favorites' : options.projectId;return base+(options.supplier!==undefined && options.supplier!==null ? ':supplier:'+JSON.stringify(options.supplier) : '');}
function compareKey(binding, projectId) { session.assert(binding); return 'huoji.compare.' + binding.owner + '.' + projectId; }
function compareSelection(binding, projectId) {
  const value = wx.getStorageSync(compareKey(binding, projectId));
  return Array.isArray(value) ? value.filter(id => typeof id === 'string').slice(0, 2) : [];
}
function setCompareSelection(binding, projectId, ids) { wx.setStorageSync(compareKey(binding, projectId), [...new Set(ids)].slice(0, 2)); }
async function hydratePhotos(photos, binding, holder) {
  const result = [];
  for (const photo of photos) {
    session.assert(binding);
    if (photo.path && photo.persistent) {
      try { wx.getFileSystemManager().accessSync(photo.path); result.push(photo); continue; }
      catch (_) { if (!photo.id) { result.push(Object.assign({}, photo, { path: '', error: true })); continue; } }
    }
    if (photo.path && !photo.persistent) {
      try { wx.getFileSystemManager().accessSync(photo.path); result.push(photo); continue; } catch (_) {}
    }
    try { const path = await api.download('/api/photos/' + encodeURIComponent(photo.id), binding);if(holder)cache.retain(holder,[path]);result.push(Object.assign({}, photo, { path })); }
    catch (e) { if (e.code === 'IDENTITY_CHANGED' || e.code === 'LOGIN_REQUIRED') throw e; result.push(Object.assign({}, photo, { path: '', error: true })); }
  }
  return result;
}
async function uploadPhotos(photos, binding) {
  const result = [];
  for (const photo of photos) {
    session.assert(binding);
    if (photo.id) { result.push(photo); continue; }
    if (!photo.path || !photo.persistent) throw new Error('本机照片不可用，请重新选择');
    const uploaded = await api.upload(photo.path, binding);
    result.push(Object.assign({}, photo, { id: uploaded.id, name: uploaded.name }));
  }
  return result;
}
function payload(fields, projectId, photos, productId, version) {
  const result = { projectId, fields: domain.validateFields(fields), photoIds: photos.map(p => p.id) };
  if (result.photoIds.some(id => !id) || result.photoIds.length > 6) throw new Error('请等待照片上传完成');
  if (productId) { result.id = productId; result.version = version; }
  return result;
}
async function exportProject(binding, projectId, share, options = {}) {
  const query=exportQuery(projectId,options),dateLabel=query.dateFrom?query.dateFrom+'至'+query.dateTo:options.date || domain.chinaLocalDate();
  const fileName=exportFileName(options.fileName || '看货记录-'+dateLabel+'.xlsx');
  let filePath = api.usesContainer() ? await exportInContainer(binding, projectId, Object.assign({},options,{fileName})) : await api.download('/api/export?' + Object.entries(query).map(([key,value])=>encodeURIComponent(key)+'='+encodeURIComponent(value)).join('&'), binding);
  session.assert(binding);
  if(options.isCurrent && !options.isCurrent())throw session.error('IDENTITY_CHANGED','页面已变化');
  if(!api.usesContainer()){const id=domain.uuid(),named=exportFilePath(id,fileName);wx.getFileSystemManager().renameSync(filePath,named);filePath=named;cache.put(binding,'export:'+id,filePath,'export');}
  if (options.onFileReady) options.onFileReady(filePath);
  const holder={};cache.protect(holder,[filePath]);
  try {
    if (share && wx.shareFileMessage) return await new Promise((resolve, reject) => wx.shareFileMessage({ filePath, fileName, success: resolve, fail: () => reject(new Error('分享未完成，可重新打开文件')) }));
    return await new Promise((resolve, reject) => wx.openDocument({ filePath, fileType: 'xlsx', showMenu: true, success: resolve, fail: () => reject(new Error('文件已下载，但无法打开，请在支持 Excel 的设备重试')) }));
  } finally {cache.release(holder);}
}
function exportQuery(projectId,options) {
  const query=projectId?{projectId}:options.favorite?{favorite:'yes'}:{};
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
  if(options.dateFrom!==undefined || options.dateTo!==undefined){
    if(options.date!==undefined || !validDate(options.dateFrom) || !validDate(options.dateTo) || options.dateFrom>options.dateTo)throw new Error('请选择有效的起止日期，不能与单日混用');
    query.dateFrom=options.dateFrom;query.dateTo=options.dateTo;
  }else if(options.date!==undefined){if(!validDate(options.date))throw new Error('请选择有效的导出日期');query.date=options.date;}
  if(!projectId && !options.favorite && query.date===undefined && query.dateFrom===undefined)throw new Error('请选择导出日期');
  Object.assign(query,{scope:options.scope==='confirmed'?'confirmed':'all',images:options.images===false?'no':'yes',audience:options.audience==='internal'?'internal':'selection'});
  if(options.supplier!==undefined)query.supplier=options.supplier;
  return query;
}
async function exportInContainer(binding, projectId, options) {
  const query = exportQuery(projectId,options);
  const key='huoji.exportJob.'+encodeURIComponent(binding.owner)+'.'+hash.textDigest(domain.stable(query));
  let submitted=wx.getStorageSync(key);
  if(!submitted || !submitted.jobId || submitted.query!==domain.stable(query) || Date.now()-submitted.createdAt>30*60*1000){
    submitted = await api.request('/api/export-jobs', { method: 'POST', identity: binding, data: query });
    session.assert(binding);wx.setStorageSync(key,{jobId:submitted.jobId,query:domain.stable(query),createdAt:Date.now()});
  }
  try{
    const file=await downloadJobFile(submitted.jobId, binding, options.fileName,options);
    session.assert(binding);wx.removeStorageSync(key);return file;
  }catch(error){if(error.jobFailure || ['NOT_FOUND','JOB_FAILED','EMPTY_EXPORT','EXPORT_LIMIT'].includes(error.code))wx.removeStorageSync(key);throw error;}
}
function exportFileName(value){return Array.from(String(value).replace(/\.xlsx$/i,'').replace(/[\\/:*?"<>|\x00-\x1f]/g,' ').trim()).slice(0,75).join('')+'.xlsx';}
function exportFilePath(jobId,fileName){const directory=wx.env.USER_DATA_PATH+'/export-'+jobId;wx.getFileSystemManager().mkdirSync(directory,true);return directory+'/'+exportFileName(fileName);}
async function downloadJobFile(jobId, binding, fileName, options={}) {
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(jobId || ''))throw session.error('BAD_RESPONSE','任务号无效');
  await jobs.pollJob(jobId, binding, { maxPolls: 80,isCurrent:options.isCurrent });
  const route = '/api/jobs/' + jobId + '/file';
  let supported=false;
  try{supported=(await api.request('/api/capabilities',{identity:binding})).exportFileV2===true;}catch(error){if(['IDENTITY_CHANGED','LOGIN_REQUIRED'].includes(error.code))throw error;}
  const metaRoute=route+(supported?'?protocol=2':'');
  const meta = await api.request(metaRoute, { identity: binding });
  if (!meta || !Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size > 80 * 1024 * 1024 || meta.chunkSize !== (supported?655360:4*1024*1024)) throw session.error('BAD_RESPONSE', '文件信息无效，请重新导出');
  if(!supported && meta.size>655360)throw session.error('EXPORT_PROTOCOL','当前服务不支持安全大文件下载，请更新服务或缩小范围/无图导出');
  if(supported && (meta.protocol!==2 || meta.jobId!==jobId || meta.chunkCount!==Math.ceil(meta.size/meta.chunkSize) || !/^[a-f0-9]{64}$/.test(meta.sha256 || '') || !Array.isArray(meta.chunkHashes) || meta.chunkHashes.length!==meta.chunkCount || meta.chunkHashes.some(value=>!/^[a-f0-9]{64}$/.test(value))))throw session.error('BAD_RESPONSE','文件校验信息无效');
  const fs = wx.getFileSystemManager(), file = fileName ? exportFilePath(jobId,fileName) : wx.env.USER_DATA_PATH + '/export-' + jobId + '.xlsx';
  const part=supported?file+'.part':file,checkpointKey='huoji.download.'+encodeURIComponent(binding.owner)+'.'+jobId,holder={};
  const check=()=>{session.assert(binding);if(options.isCurrent && !options.isCurrent())throw session.error('IDENTITY_CHANGED','页面已变化，下载检查点已保留');};
  let offset=0,rolling=new hash.Hash();
  cache.protect(holder,[part,file]);
  if(supported){
    const saved=wx.getStorageSync(checkpointKey);
    if(saved && saved.file===part && saved.sha256===meta.sha256 && saved.offset<=meta.size && saved.offset>0 && (saved.offset===meta.size || saved.offset%meta.chunkSize===0) && cache.size(part)===saved.offset){
      try{const prefix=hash.fileHash(fs,part,saved.offset);if(prefix.clone().digest()===saved.prefixHash){offset=saved.offset;rolling=prefix;}}catch(_){}
    }
    if(!cache.prune(meta.size-offset)){cache.release(holder);throw session.error('CACHE_SPACE','本机空间不足，请缩小导出范围；草稿未删除');}
  }
  try {
    if(!offset)fs.writeFileSync(part, '', 'binary');
    for (; offset < meta.size; offset += meta.chunkSize) {
      check();
      let chunkPath;
      for(let attempt=0;;attempt++){
        try{chunkPath=await api.download(route+'?'+(supported?'protocol=2&':'')+'offset='+offset,binding);break;}
        catch(error){if(attempt>=4 || !['DOWNLOAD_FAILED','NETWORK_UNKNOWN','HTTP_429'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(4000,500*2**attempt)+Math.random()*150));check();}
      }
      try {
        const bytes = fs.readFileSync(chunkPath);
        if (!bytes || bytes.byteLength !== Math.min(meta.chunkSize, meta.size - offset)) throw session.error('DOWNLOAD_FAILED', '文件下载不完整，请重新导出');
        if(supported && hash.digest(bytes)!==meta.chunkHashes[offset/meta.chunkSize])throw session.error('FILE_CORRUPT','文件分块校验失败，请重试下载');
        check();fs.appendFileSync(part, bytes);
        if(supported){rolling.update(bytes);const end=Math.min(meta.size,offset+meta.chunkSize);wx.setStorageSync(checkpointKey,{file:part,sha256:meta.sha256,offset:end,prefixHash:rolling.clone().digest()});cache.put(binding,'partial:'+jobId,part,'partial');}
      } finally { try { fs.unlinkSync(chunkPath); } catch (_) {} }
    }
    check();
    if(supported){
      if(cache.size(part)!==meta.size || rolling.digest()!==meta.sha256)throw session.error('FILE_CORRUPT','文件校验失败，不能打开或分享');
      fs.renameSync(part,file);wx.removeStorageSync(checkpointKey);cache.put(binding,'export:'+jobId,file,'export',meta.sha256);
    }
    if(!supported)cache.put(binding,'export:'+jobId,file,'export');
    return file;
  } catch (error) { if(!supported || error.code==='FILE_CORRUPT'){try { fs.unlinkSync(part);wx.removeStorageSync(checkpointKey); } catch (_) {}}throw error; }
  finally{cache.release(holder);}
}
module.exports = { files:cache,comparisonScope, rememberMerchantView, rememberedMerchant, selectMerchant, consumeMerchant, downloadJobFile, exportInContainer, activeProject, selectProject, compareSelection, setCompareSelection, hydratePhotos, uploadPhotos, payload, exportProject, drafts, requestProductView, consumeProductView };
