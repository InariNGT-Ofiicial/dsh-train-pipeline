import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync('_tmp', { recursive: true });
const tmp = mkdtempSync(resolve('_tmp/config-'));
const previous = process.env.DSH_TRAIN_ROOT;
try {
  mkdirSync(join(tmp, 'src'));
  copyFileSync('src/config.js', join(tmp, 'src/config.js'));
  writeFileSync(join(tmp, 'package.json'), '{"type":"module"}');
  const { resolveConfig } = await import(pathToFileURL(join(tmp, 'src/config.js')));
  const root = join(tmp, 'song');
  const future = join(tmp, 'not-created', 'workspace');
  const lib = join(tmp, 'not-created', 'voices');
  const ddsp = join(tmp, 'missing-ddsp');
  const python = join(tmp, 'missing-python');
  process.env.DSH_TRAIN_ROOT = join(tmp, 'workspace-from-env');
  let cfg = resolveConfig({ songRoot: root, trainRoot: future, voiceLibDir: lib, ddspDir: ddsp, ddspEnv: python, ffmpeg: 'ffmpeg' });
  for (const [k, v] of Object.entries({ songRoot: root, trainRoot: future, voiceLibDir: lib, ddspDir: ddsp, ddspEnv: python })) {
    assert.equal(cfg[k], v.replace(/\\/g, '/'), `${k} must not silently fall back`);
  }
  assert.equal(cfg.ffmpeg, 'ffmpeg', 'PATH commands must remain executable names');
  cfg = resolveConfig({ songRoot: root });
  assert.equal(cfg.trainRoot, process.env.DSH_TRAIN_ROOT.replace(/\\/g, '/'));
  writeFileSync(join(tmp, 'train.local.json'), JSON.stringify({ trainRoot: future, songRoot: '', expName: 'local-exp' }));
  cfg = resolveConfig({ songRoot: root, trainRoot: join(tmp, 'raw'), expName: 'raw-exp' });
  assert.equal(cfg.trainRoot, future.replace(/\\/g, '/'));
  assert.equal(cfg.songRoot, root.replace(/\\/g, '/'));
  assert.equal(cfg.expName, 'local-exp');
  console.log('PASS: missing output paths, invalid explicit paths, env scope, PATH ffmpeg and local precedence');
} finally {
  if (previous === undefined) delete process.env.DSH_TRAIN_ROOT;
  else process.env.DSH_TRAIN_ROOT = previous;
  rmSync(tmp, { recursive: true, force: true });
}
