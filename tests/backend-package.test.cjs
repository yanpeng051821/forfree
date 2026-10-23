'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectBackend, packageBackend } = require('../scripts/package-backend.cjs');
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'huoji-backend-package-'));
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  for (const file of ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) fs.writeFileSync(path.join(root, file), file.endsWith('.json') ? '{}' : 'fixture');
  fs.mkdirSync(path.join(root, 'src/server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/server/index.ts'), 'export {};');
  return { parent, root };
}
test('backend packaging copies only reviewed source, not credentials, client, or private workbooks', () => {
  const { parent, root } = fixture();
  try {
    fs.writeFileSync(path.join(root, '.env.local'), 'PRIVATE_TEST_VALUE');
    for (const name of ['.data', 'miniprogram', 'docs', 'node_modules']) {
      fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, 'private.xlsx'), 'PRIVATE_TEST_VALUE');
    }
    const output = path.join(parent, 'upload');
    const result = packageBackend(root, output);
    assert.equal(result.files, 7);
    for (const name of ['.env.local', '.data', 'miniprogram', 'docs', 'node_modules']) assert.equal(fs.existsSync(path.join(output, name)), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'backend-manifest.json')));
    assert.equal(manifest.files.length, 7); assert.ok(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.throws(() => packageBackend(root, output), /already exists/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
test('backend packaging refuses symlinks, unexpected files, unsafe paths, and embedded private keys before copying', () => {
  const { parent, root } = fixture();
  try {
    fs.mkdirSync(path.join(root, '.data'));
    assert.throws(() => packageBackend(root, path.join(root, '.data/upload')), /Unsafe/);
    fs.symlinkSync(path.join(root, 'package.json'), path.join(root, 'src/link.ts'));
    assert.throws(() => collectBackend(root), /symlinks/); fs.unlinkSync(path.join(root, 'src/link.ts'));
    fs.writeFileSync(path.join(root, 'src/internal.xlsx'), 'private');
    assert.throws(() => collectBackend(root), /non-TypeScript/); fs.unlinkSync(path.join(root, 'src/internal.xlsx'));
    fs.writeFileSync(path.join(root, 'src/server/index.ts'), '-----BEGIN PRIVATE KEY-----');
    const output = path.join(parent, 'blocked');
    assert.throws(() => packageBackend(root, output), /credentials/);
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
