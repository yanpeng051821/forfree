'use strict';
// Create an upload source containing only reviewed runtime files. Never copy .env or .data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT_FILES = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json'];
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function collectBackend(root) {
  root = fs.realpathSync(root);
  const files = [];
  function collect(relative, allowDirectory = false) {
    const absolute = path.join(root, relative);
    const entry = fs.lstatSync(absolute);
    if (entry.isSymbolicLink()) throw new Error('Backend source cannot contain symlinks');
    if (entry.isDirectory() && allowDirectory) {
      for (const name of fs.readdirSync(absolute).sort()) collect(path.join(relative, name), true);
      return;
    }
    if (!entry.isFile()) throw new Error('Backend source must contain regular files');
    if (allowDirectory && !/\.ts$/.test(relative)) throw new Error('Unexpected non-TypeScript runtime source');
    const bytes = fs.readFileSync(absolute);
    // A public app identifier is permitted; private signing keys and environment assignments are not.
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:WB_SESSION_ENCRYPTION_KEY|WECHAT_APP_SECRET|MODEL_API_KEY)\s*=\s*[^\s"';]+/.test(bytes.toString('utf8'))) throw new Error('Potential private credentials in runtime source');
    files.push({ relative, bytes });
  }
  ROOT_FILES.forEach(file => collect(file));
  collect('src', true);
  if (!files.some(file => file.relative === path.join('src', 'server', 'index.ts'))) throw new Error('Backend entry missing');
  return files;
}
function packageBackend(root, output) {
  root = fs.realpathSync(root);
  const parent = fs.realpathSync(path.dirname(path.resolve(output)));
  output = path.join(parent, path.basename(output));
  for (const restricted of ['src', 'miniprogram', '.data', '.git', 'node_modules', 'docs']) {
    if (inside(path.join(root, restricted), output)) throw new Error('Unsafe backend output directory');
  }
  if (inside(output, root)) throw new Error('Output cannot be the project or its ancestor');
  if (fs.existsSync(output)) throw new Error('Backend output already exists; use a new directory');
  const files = collectBackend(root); // All validation completes before creating the destination.
  fs.mkdirSync(output, { mode: 0o700 });
  const manifest = [];
  for (const file of files) {
    const target = path.join(output, file.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o600 });
    manifest.push({ path: file.relative.split(path.sep).join('/'), size: file.bytes.length, sha256: crypto.createHash('sha256').update(file.bytes).digest('hex') });
  }
  fs.writeFileSync(path.join(output, 'backend-manifest.json'), JSON.stringify({ format: 1, files: manifest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { files: manifest.length, bytes: manifest.reduce((sum, file) => sum + file.size, 0) };
}
if (require.main === module) {
  if (!process.argv[2]) { console.error('Usage: npm run pack:backend -- /absolute/path/to/new-upload-directory'); process.exitCode = 1; }
  else {
    try { const result = packageBackend(path.resolve(__dirname, '..'), process.argv[2]); console.log(JSON.stringify(result)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
module.exports = { collectBackend, packageBackend };
