const session = require('./session');
const { stable } = require('./domain');
const PREFIX = 'huoji.draft.v1.';
const protectedFiles = new Map();
function snapshot(value) { return stable(value || null); }
function matches(binding, projectId, productId, expected) {
  session.assert(binding);
  return snapshot(wx.getStorageSync(key(binding.owner, projectId, productId))) === expected;
}
function key(owner, projectId, productId) { return PREFIX + [owner, projectId, productId || 'new'].map(encodeURIComponent).join('.'); }
function invalid(message) { const error = new Error(message || '草稿格式异常，请放弃损坏草稿后重新开始'); error.code = 'DRAFT_CORRUPT'; return error; }
function validate(value, owner, projectId) {
  if (!value || value.format !== 1 || value.owner !== owner || value.projectId !== projectId || !value.fields || !Array.isArray(value.photos) || value.photos.length > 6) throw invalid();
  if (value.retired !== undefined && (!Array.isArray(value.retired) || value.retired.length > 12)) throw invalid();
  return value;
}
function read(binding, projectId, productId) {
  session.assert(binding);
  const value = wx.getStorageSync(key(binding.owner, projectId, productId));
  if (!value) return null;
  return validate(value, binding.owner, projectId);
}
function write(binding, projectId, productId, value, options = {}) {
  session.assert(binding);
  if (Object.prototype.hasOwnProperty.call(options, 'expected') && !matches(binding, projectId, productId, options.expected)) {
    throw session.error('DRAFT_CHANGED', '已有更新的本机草稿，请返回后重新打开；本页未覆盖新草稿');
  }
  const entry = Object.assign({}, value, { format: 1, owner: binding.owner, projectId, productId: productId || '', updatedAt: Date.now() });
  entry.photos = (value.photos || []).map(p => ({ id: p.id || '', name: p.name || '商品照片', path: p.persistent ? p.path : '', persistent: !!p.persistent }));
  const storageKey = key(binding.owner, projectId, productId);
  wx.setStorageSync(storageKey, entry);
  if (stable(wx.getStorageSync(storageKey)) !== stable(entry)) throw new Error('草稿写入未确认，请勿关闭页面');
  return entry;
}
function removeFile(photo) {
  if (photo && photo.persistent && typeof photo.path === 'string' && photo.path) wx.removeSavedFile({ filePath: photo.path, fail() {} });
}
function safeOwnedFiles(value, binding, projectId) {
  if (!value || value.owner !== binding.owner || value.projectId !== projectId) return [];
  const groups = [value.photos, value.retired];
  if (groups.some(group => group !== undefined && (!Array.isArray(group) || group.length > 12))) return [];
  return groups.flatMap(group => group || []).filter(photo => photo && photo.persistent === true && typeof photo.path === 'string' && photo.path);
}
// Active editors keep their references across temporary hiding (camera/preview).
function protect(holder, binding, photos) {
  session.assert(binding);
  protectedFiles.set(holder, (photos || []).filter(photo => photo && photo.persistent && photo.path).map(photo => photo.path));
}
function release(holder) { protectedFiles.delete(holder); }
function releaseFiles(photos) {
  let referenced;
  try {
    referenced = new Set([...protectedFiles.values()].flat());
    for (const storageKey of wx.getStorageInfoSync().keys.filter(value => value.startsWith(PREFIX))) {
      const value = wx.getStorageSync(storageKey);
      // Unknown/corrupt reference lists cannot justify deleting a local file.
      if (!value || !Array.isArray(value.photos) || (value.retired !== undefined && !Array.isArray(value.retired))) return;
      for (const photo of [...value.photos, ...(value.retired || [])]) if (photo && photo.path) referenced.add(photo.path);
    }
  } catch (_) { return; }
  const visited = new Set();
  for (const photo of photos || []) {
    if (!photo || !photo.persistent || !photo.path || referenced.has(photo.path) || visited.has(photo.path)) continue;
    visited.add(photo.path); removeFile(photo);
  }
}
// 本人明确放弃时，即使草稿已损坏也先解除页面阻塞；只有归属和文件列表可安全确认时才清理文件。
function discard(binding, projectId, productId, options = {}) {
  session.assert(binding);
  const storageKey = key(binding.owner, projectId, productId);
  const raw = wx.getStorageSync(storageKey);
  if (Object.prototype.hasOwnProperty.call(options, 'expected') && snapshot(raw) !== options.expected) return false;
  wx.removeStorageSync(storageKey);
  if (wx.getStorageSync(storageKey)) throw session.error('DRAFT_REMOVE_FAILED', '草稿未能清理，请返回后重新核查');
  releaseFiles(safeOwnedFiles(raw, binding, projectId));
  return true;
}
async function persistPhotos(files, binding) {
  const added = [];
  try {
    for (const file of files) {
      session.assert(binding);
      if (!file.tempFilePath) throw new Error('照片路径不可用，请重新选择');
      let source = file.tempFilePath;
      if (file.size > 2 * 1024 * 1024 && wx.compressImage) {
        try { source = await new Promise((resolve, reject) => wx.compressImage({ src: source, quality: 72, success: res => resolve(res.tempFilePath), fail: reject })); } catch (_) {}
      }
      if (source === file.tempFilePath && file.size > 8 * 1024 * 1024) throw new Error('单张照片不能超过8MB，请使用压缩照片');
      const path = await new Promise((resolve, reject) => wx.saveFile({ tempFilePath: source, success: res => resolve(res.savedFilePath), fail: () => reject(new Error('照片无法保存在本机，请检查存储空间后重试')) }));
      added.push({ id: '', name: '商品照片', path, persistent: true });
      session.assert(binding);
    }
    return added;
  } catch (error) { added.forEach(removeFile); throw error; }
}
function list(binding) {
  session.assert(binding);
  const ownerPrefix = PREFIX + encodeURIComponent(binding.owner) + '.';
  return wx.getStorageInfoSync().keys.filter(storageKey=>storageKey.startsWith(ownerPrefix)).map(storageKey => ({ storageKey, value: wx.getStorageSync(storageKey) }))
    .filter(item => item.storageKey.startsWith(ownerPrefix) && item.value && item.value.format === 1 && item.value.owner === binding.owner && item.value.fields && Array.isArray(item.value.photos))
    .map(item => Object.assign({}, item.value, { draftKey: item.storageKey }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function editorUrl(item) {
  return '/pages/editor/index?resume=yes&projectId=' + encodeURIComponent(item.projectId) + (item.editId ? '&id=' + encodeURIComponent(item.editId) : '') + (item.productId ? '&draftId=' + encodeURIComponent(item.productId) : '');
}
module.exports = { editorUrl, key, read, write, discard, persistPhotos, removeFile, list, snapshot, matches, protect, release, releaseFiles };
