const session = require('./utils/session');
const gate = require('./utils/auth-gate');
App({
  onLaunch() { session.restore(); gate.watch(); },
  onShow() { gate.show(); },
  onHide() { gate.hide(); }
});
