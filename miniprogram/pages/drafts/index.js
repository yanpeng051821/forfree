const kit=require('../../utils/page-kit'),session=require('../../utils/session'),draft=require('../../utils/draft');
Page(kit.protectedPage({data:{drafts:[]},onShow(){if(!kit.requireLogin(this))return;this.setData({drafts:draft.list(session.capture())});},resume(e){const item=this.data.drafts[e.currentTarget.dataset.index];if(item)wx.navigateTo({url:draft.editorUrl(item)});}}));
