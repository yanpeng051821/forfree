const api = require('./api');
const session = require('./session');
const domain = require('./domain');
const drafts = require('./draft');
const jobs = require('./jobs');
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
function comparisonScope(options){const base=options.date ? 'day:'+options.date : options.favorite ? 'favorites' : options.projectId;return base+(options.supplier!==undefined && options.supplier!==null ? ':supplier:'+JSON.stringify(options.supplier) : '');}
function compareKey(binding, projectId) { session.assert(binding); return 'huoji.compare.' + binding.owner + '.' + projectId; }
function compareSelection(binding, projectId) {
  const value = wx.getStorageSync(compareKey(binding, projectId));
  return Array.isArray(value) ? value.filter(id => typeof id === 'string').slice(0, 2) : [];
}
function setCompareSelection(binding, projectId, ids) { wx.setStorageSync(compareKey(binding, projectId), [...new Set(ids)].slice(0, 2)); }
async function hydratePhotos(photos, binding) {
  const result = [];
  for (const photo of photos) {
    session.assert(binding);
    if (photo.path && photo.persistent) {
      try { wx.getFileSystemManager().accessSync(photo.path); result.push(photo); continue; }
      catch (_) { if (!photo.id) { result.push(Object.assign({}, photo, { path: '', error: true })); continue; } }
    }
    if (photo.path && !photo.persistent) { result.push(photo); continue; }
    try { const path = await api.download('/api/photos/' + encodeURIComponent(photo.id), binding); result.push(Object.assign({}, photo, { path })); }
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
  if(!api.usesContainer()){const named=exportFilePath(domain.uuid(),fileName);wx.getFileSystemManager().renameSync(filePath,named);filePath=named;}
  if (options.onFileReady) options.onFileReady(filePath);
  if (share && wx.shareFileMessage) return new Promise((resolve, reject) => wx.shareFileMessage({ filePath, fileName, success: resolve, fail: () => reject(new Error('分享未完成，可重新打开文件')) }));
  return new Promise((resolve, reject) => wx.openDocument({ filePath, fileType: 'xlsx', showMenu: true, success: resolve, fail: () => reject(new Error('文件已下载，但无法打开，请在支持 Excel 的设备重试')) }));
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
  const submitted = await api.request('/api/export-jobs', { method: 'POST', identity: binding, data: query });
  return downloadJobFile(submitted.jobId, binding, options.fileName);
}
function exportFileName(value){return Array.from(String(value).replace(/\.xlsx$/i,'').replace(/[\\/:*?"<>|\x00-\x1f]/g,' ').trim()).slice(0,75).join('')+'.xlsx';}
function exportFilePath(jobId,fileName){const directory=wx.env.USER_DATA_PATH+'/export-'+jobId;wx.getFileSystemManager().mkdirSync(directory,true);return directory+'/'+exportFileName(fileName);}
async function downloadJobFile(jobId, binding, fileName) {
  await jobs.pollJob(jobId, binding, { maxPolls: 80 });
  const route = '/api/jobs/' + jobId + '/file';
  const meta = await api.request(route, { identity: binding });
  if (!meta || !Number.isSafeInteger(meta.size) || meta.size <= 0 || meta.size > 80 * 1024 * 1024 || meta.chunkSize !== 4 * 1024 * 1024) throw session.error('BAD_RESPONSE', '文件信息无效，请重新导出');
  const fs = wx.getFileSystemManager(), file = fileName ? exportFilePath(jobId,fileName) : wx.env.USER_DATA_PATH + '/export-' + jobId + '.xlsx';
  fs.writeFileSync(file, '', 'binary');
  try {
    for (let offset = 0; offset < meta.size; offset += meta.chunkSize) {
      session.assert(binding);
      const chunkPath = await api.download(route + '?offset=' + offset, binding);
      try {
        const bytes = fs.readFileSync(chunkPath);
        if (!bytes || bytes.byteLength !== Math.min(meta.chunkSize, meta.size - offset)) throw session.error('DOWNLOAD_FAILED', '文件下载不完整，请重新导出');
        fs.appendFileSync(file, bytes);
      } finally { try { fs.unlinkSync(chunkPath); } catch (_) {} }
    }
    session.assert(binding);
    return file;
  } catch (error) { try { fs.unlinkSync(file); } catch (_) {} throw error; }
}
module.exports = { comparisonScope, rememberMerchantView, rememberedMerchant, selectMerchant, consumeMerchant, downloadJobFile, exportInContainer, activeProject, selectProject, compareSelection, setCompareSelection, hydratePhotos, uploadPhotos, payload, exportProject, drafts, requestProductView, consumeProductView };
