module.exports = Object.freeze({
  // Trial / release: the deployed Huoji API, never the WorkBuddy /.cloud/ gateway.
  // 优先使用微信云托管域名：域名已由云托管体系托管，无需在微信后台另外配置服务器域名。
  API_BASE_URL: 'https://huoji-api-yanpeng-d1giw89zv518e3f6e-1374757182.ap-shanghai.run.wxcloudrun.com',
  // Only used in the desktop WeChat development tools.
  USE_LOCAL_API: false,
  LOCAL_API_BASE_URL: 'http://127.0.0.1:3000',
  // 微信云托管通道：wx.cloud.callContainer 不受 request 合法域名限制，小程序默认走该通道。
  CLOUD_ENV: 'yanpeng-d1giw89zv518e3f6e',
  CLOUD_SERVICE: 'huoji-api',
  ENABLE_LOCAL_DEV_LOGIN: false
});
