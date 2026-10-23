const { resolve } = require('node:path');
const { readFileSync, existsSync, readdirSync, lstatSync } = require('node:fs');
const { isIP } = require('node:net');
function checkRelease(root) {
  const configFile = require.resolve(resolve(root, 'config.js')); delete require.cache[configFile];
  const config = require(configFile);
  const project = JSON.parse(readFileSync(resolve(root, 'project.config.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8'));
  const problems = [];
  try {
    const url = new URL(config.API_BASE_URL);
    if (!/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?\/?$/i.test(config.API_BASE_URL) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || isIP(url.hostname) || !url.hostname.includes('.') || /(?:^|\.)(localhost|local|internal|test|example)$/.test(url.hostname) || /(?:^|\.)(?:example\.(?:com|org|net)|workbuddy\.host)$/.test(url.hostname)) throw new Error();
  } catch (_) { problems.push('API_BASE_URL 必须是已部署货记后端的公网 HTTPS 域名；不能是本机地址、示例地址或 WorkBuddy 云网关。'); }
  if (config.ENABLE_LOCAL_DEV_LOGIN) problems.push('发布前必须关闭 ENABLE_LOCAL_DEV_LOGIN。');
  if (config.USE_LOCAL_API !== false) problems.push('发布前必须显式关闭 USE_LOCAL_API。');
  if (typeof config.CLOUD_ENV !== 'string' || !config.CLOUD_ENV.trim() || typeof config.CLOUD_SERVICE !== 'string' || !config.CLOUD_SERVICE.trim()) problems.push('发布版本必须配置 CLOUD_ENV 和 CLOUD_SERVICE，真机只允许云容器通道。');
  if (project.setting.urlCheck !== true) problems.push('project.config.json 必须开启 urlCheck。');
  const privateFile = resolve(root, 'project.private.config.json');
  if (existsSync(privateFile)) {
    const privateProject = JSON.parse(readFileSync(privateFile, 'utf8'));
    if (privateProject.setting && privateProject.setting.urlCheck === false) problems.push('本机 project.private.config.json 仍关闭合法域名检查；发布验收前请恢复 true。');
  }
  if (manifest.pages[0] !== 'pages/login/index' || manifest.tabBar.list.some(tab => tab.pagePath === 'pages/login/index')) problems.push('登录页必须为首入口，且不属于 tabBar。');
  function inspect(directory,relative='') {
    for(const name of readdirSync(directory)){
      const path=resolve(directory,name),entry=relative?relative+'/'+name:name,stat=lstatSync(path);
      if(stat.isSymbolicLink()){problems.push('小程序包不能包含符号链接：'+entry);continue;}
      if(name.toLowerCase()==='.data' || name.toLowerCase().startsWith('.env') || /\.(?:xlsx?|sqlite3?|db|pem|key|p12|pfx)$/i.test(name)){problems.push('小程序包包含数据或密钥文件：'+entry);continue;}
      if(stat.isDirectory()){inspect(path,entry);continue;}
      if(/\.(?:js|json|wxml|wxss|txt|md)$/i.test(name)){
        const source=readFileSync(path,'utf8');
        if(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{32,}|\bAKID[A-Za-z0-9]{20,}/.test(source))problems.push('小程序包存在疑似密钥内容：'+entry);
      }
    }
  }
  inspect(root);
  return problems;
}
if (require.main === module) {
  const problems = checkRelease(resolve(process.argv[2] || 'miniprogram'));
  if (problems.length) { console.error('小程序发布配置未通过：\n' + problems.map(p => '- ' + p).join('\n')); process.exitCode = 1; }
  else console.log('发布静态配置与包内数据/密钥检查通过。仍需验证云容器通道、云端就绪和微信真实登录。');
}
module.exports = { checkRelease };
