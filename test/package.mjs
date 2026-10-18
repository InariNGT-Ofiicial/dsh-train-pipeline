import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
assert.ok(existsSync(npm), 'npm CLI must be available');
const output = execFileSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
const [{ files }] = JSON.parse(output);
const paths = files.map(f => f.path);
for (const required of ['src/index.js', 'src/sources/galgame.js', 'py/probe_audio.py', 'scripts/install.ps1',
  'cordis.patch.yml', 'materials/README.md', 'requirements-test.txt', 'README.md', 'LICENSE']) {
  assert.ok(paths.includes(required), `package missing ${required}`);
}
for (const p of paths) {
  assert.ok(!/(^|\/)(?:_tmp|node_modules|__pycache__|data|pretrain|exp|reports|tools|datasets)(\/|$)/.test(p), `generated directory in package: ${p}`);
  assert.ok(!/\.(?:wav|ogg|mp3|flac|opus|m4a|mp4|pt|pth|ckpt|onnx|safetensors|xp3|psb|scn|ks|exe|dll|zip|7z|pyc|log)$/i.test(p), `private/binary artifact in package: ${p}`);
  assert.ok(!/(?:^|\/)(?:\.env.*|.*\.local\.json|_provenance\.json)$/.test(p), `local config in package: ${p}`);
}
console.log(`PASS: npm package contains ${paths.length} source/documentation files and no private artifacts`);
