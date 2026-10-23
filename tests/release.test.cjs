const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkRelease } = require('../scripts/check-miniprogram-release.cjs');
test('release preflight refuses loopback, gateway, development login and disabled domain checking', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huoji-release-'));
  function write(base, dev = false) {
    fs.writeFileSync(path.join(root, 'config.js'), 'module.exports=' + JSON.stringify({ API_BASE_URL: base, ENABLE_LOCAL_DEV_LOGIN: dev,USE_LOCAL_API:false,CLOUD_ENV:'synthetic-env',CLOUD_SERVICE:'synthetic-service' }));
  }
  try {
    fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ setting: { urlCheck: true } }));
    fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({ pages: ['pages/login/index'], tabBar: { list: [] } }));
    for (const value of ['', 'http://127.0.0.1:3000', 'https://127.0.0.1', 'https://mp-api.app.workbuddy.host', 'https://example.com', 'https://api.example', 'https://api.invalid/path', 'https://user:pass@api.invalid']) {
      write(value); assert.ok(checkRelease(root).length, value);
    }
    write('https://api.invalid'); assert.deepEqual(checkRelease(root), []);
    write('https://api.invalid', true); assert.match(checkRelease(root).join(), /DEV_LOGIN/);
    write('https://api.invalid'); fs.writeFileSync(path.join(root, 'project.private.config.json'), JSON.stringify({ setting: { urlCheck: false } }));
    assert.match(checkRelease(root).join(), /private/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('release preflight requires cloud-only configuration and rejects private data or credential material in the mini program root',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'huoji-release-package-'));
  const config={API_BASE_URL:'https://api.invalid',ENABLE_LOCAL_DEV_LOGIN:false,USE_LOCAL_API:false,CLOUD_ENV:'synthetic-env',CLOUD_SERVICE:'synthetic-service'};
  const write=patch=>fs.writeFileSync(path.join(root,'config.js'),'module.exports='+JSON.stringify({...config,...patch}));
  try{
    fs.writeFileSync(path.join(root,'project.config.json'),JSON.stringify({setting:{urlCheck:true}}));fs.writeFileSync(path.join(root,'app.json'),JSON.stringify({pages:['pages/login/index'],tabBar:{list:[]}}));
    write({});assert.deepEqual(checkRelease(root),[]);
    write({USE_LOCAL_API:true});assert.match(checkRelease(root).join(),/USE_LOCAL_API/);write({CLOUD_ENV:''});assert.match(checkRelease(root).join(),/CLOUD_ENV/);write({CLOUD_SERVICE:''});assert.match(checkRelease(root).join(),/CLOUD_SERVICE/);write({});
    for(const filename of ['.env.local','synthetic.xlsx','synthetic.sqlite','synthetic.pem']){fs.writeFileSync(path.join(root,filename),'synthetic only');assert.ok(checkRelease(root).some(p=>p.includes(filename)));fs.unlinkSync(path.join(root,filename));}
    fs.mkdirSync(path.join(root,'.data'));assert.match(checkRelease(root).join(),/\.data/);fs.rmdirSync(path.join(root,'.data'));
    fs.symlinkSync('/tmp',path.join(root,'outside'));assert.match(checkRelease(root).join(),/符号链接/);fs.unlinkSync(path.join(root,'outside'));
    fs.writeFileSync(path.join(root,'secret.js'),'// -----BEGIN PRIVATE KEY-----');assert.match(checkRelease(root).join(),/疑似密钥/);fs.unlinkSync(path.join(root,'secret.js'));assert.deepEqual(checkRelease(root),[]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
