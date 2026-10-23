const api = require('../../utils/api');
const session = require('../../utils/session');
const kit = require('../../utils/page-kit');
const profile = require('../../utils/profile');
const roleNames = ['采购员', '商家', '采购与经营'];
Page(kit.protectedPage({
  data: { user: null, profile: profile.normalize(), form: profile.normalize(), roleName: '', roles: roleNames, roleIndex: 0, currencies: profile.currencies, currencyIndex: 0, editing: true, saving: false, avatarBusy: false, avatarPreview: '', avatarInitial: '我', keyboardHeight: 0, error: '' },
  onLoad() { this._unloaded = false; },
  onShow() { if(!kit.requireLogin(this))return; this._alive = true; if (!this._initialized) this.load(); else if (this._binding && !session.valid(this._binding)) { this.setData({ form: profile.normalize(), avatarPreview: '', error: '账号已变化，请返回重新打开' }); } },
  onHide() { kit.stop(this); },
  onUnload() { this._unloaded = true; kit.stop(this); },
  display(value) {
    const next = profile.normalize(value);
    this.setData({ profile: next, roleName: roleNames[profile.roles.indexOf(next.role)] });
  },
  async load() {
    if (!kit.requireLogin(this)) return;
    const seq = kit.start(this), info = session.info();
    let binding;
    const sameOwner = info && this._owner === info.user.id;
    this._owner = info && info.user.id;
    this.setData({ user: info && info.user, error: '' });
    if (!sameOwner) { this._formDirty = false; this.setData({ editing: false, form: profile.normalize() }); }
    this.display(info && info.user.profile);
    if (!this._initialized && !this._formDirty) this.editProfile();
    // Choosing an avatar can hide the page before the first network response.
    // Initialize from the account cache now so returning cannot reset the form.
    this._initialized = true;
    try {
      if (info) { binding = session.capture();  }
      const me = binding ? await api.request('/api/auth/me', { identity: binding }) : null;
      if (!this._alive || this._seq !== seq) return;
      if (binding && !session.valid(binding)) {
        if (!session.info()) { this.setData({ user: null, editing: false, form: profile.normalize(), error: '' }); this.display(null); }
        return;
      }
      if (me) { const next = profile.accept(binding, me.user.profile); this.setData({ user: me.user }); this.display(next); if (!this._formDirty) this.editProfile(); }
    } catch (e) { if (this._alive && this._seq === seq) kit.message(this, e); }
  },
  editProfile() {
    if (!session.info() || this._saving) return;
    this._binding = session.capture();
    const form = profile.read(this._binding);
    this.setData({ editing: true, form, avatarPreview: form.avatar || '', avatarInitial: (form.name || '我').slice(0,1), roleIndex: profile.roles.indexOf(form.role), currencyIndex: profile.currencies.indexOf(form.defaultCurrency), error: '' });
  },
  input(e) { const key = e.currentTarget.dataset.key; if (!this._saving && ['name', 'company', 'phone', 'wechat'].includes(key)) { this._formDirty = true; this.setData({ ['form.' + key]: e.detail.value }); if (key === 'name') this.setData({ avatarInitial:(e.detail.value || '我').slice(0,1) }); } },
  role(e) { if (!this._saving) { const index = Number(e.detail.value); this._formDirty = true; this.setData({ roleIndex: index, 'form.role': profile.roles[index] }); } },
  currency(e) { if (!this._saving) { const index = Number(e.detail.value); this._formDirty = true; this.setData({ currencyIndex: index, 'form.defaultCurrency': profile.currencies[index] }); } },
  cancelEdit() { if (!this._saving && !this._avatarBusy) wx.navigateBack(); },
  async saveProfile(e) {
    if (this._saving || this._avatarBusy) return;
    this._saving = true; this.setData({ saving: true, error: '' });
    const seq = this._seq;
    let binding;
    try {
      binding = this._binding || session.capture(); session.assert(binding);
      const submitted = e && e.detail && e.detail.value;
      const form = Object.assign({},this.data.form);
      if (submitted) ['name','company','phone','wechat'].forEach(key=>{if(typeof submitted[key]==='string')form[key]=submitted[key];});
      this._formDirty = true;
      this.setData({ form, avatarInitial:(form.name || '我').slice(0,1) });
      const fields = profile.validate(form);
      const value = await api.request('/api/profile', { method: 'POST', identity: binding, data: fields });
      // Cache only acknowledged state for the same account, even when the view is hidden.
      profile.accept(binding, value);
      if (kit.current(this, binding, seq)) { this.display(value); this.setData({ editing: false }); this._formDirty = false; kit.toast('资料已保存'); wx.navigateBack(); }
    } catch (e) {
      if (this._alive && this._seq === seq) kit.message(this, e);
    } finally { this._saving = false; if (this._alive) this.setData({ saving: false }); }
  },
  keyboard(e) { this.setData({ keyboardHeight:Math.max(0, Number(e.detail.height) || 0) }); },
  blur() { this.setData({ keyboardHeight:0 }); },
  async chooseAvatar(e) {
    if (this._saving || this._avatarBusy || !e.detail.avatarUrl) return;
    const binding = this._binding || session.capture(), path = e.detail.avatarUrl;
    this._avatarBusy = true; this.setData({ avatarBusy:true,error:'' });
    try {
      const compressed = await new Promise(resolve => {
        if (typeof wx.compressImage !== 'function') return resolve(path);
        wx.compressImage({ src:path,quality:65,compressedWidth:192,compressedHeight:192,success:r=>resolve(r.tempFilePath),fail:()=>resolve(path) });
      });
      session.assert(binding);
      const image = await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:compressed,encoding:'base64',success:r=>resolve(r.data),fail:()=>reject(new Error('头像读取失败，请重新选择'))}));
      if (typeof image !== 'string' || image.length > 65536) throw new Error('头像过大，请裁剪后重新选择');
      const result = await api.request('/api/profile/avatar',{method:'POST',identity:binding,data:{image}});
      session.assert(binding);
      if (this._unloaded) return;
      if (!result || typeof result.avatar !== 'string' || !/^data:image\/jpeg;base64,/.test(result.avatar)) throw new Error('头像处理失败，请重新选择');
      this._formDirty = true;
      this.setData({ 'form.avatar':result.avatar,avatarPreview:result.avatar });
    } catch (e) { if (!this._unloaded && session.valid(binding)) kit.message(this,e); }
    finally { this._avatarBusy = false; if (!this._unloaded) this.setData({avatarBusy:false}); }
  },
  removeAvatar() { if(this._saving || this._avatarBusy)return; this._formDirty=true;this.setData({'form.avatar':'',avatarPreview:''}); },
}));
