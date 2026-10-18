// Synthetic checkpoints test the file contract; they are never used for inference.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../src/index.js';
import { listVoices, findVoice } from '../src/config.js';

mkdirSync('_tmp', { recursive: true });
const tmp = mkdtempSync(resolve('_tmp/register-'));
try {
  const ddsp = join(tmp, 'ddsp');
  const exp = join(ddsp, 'exp', 'test-experiment');
  const lib = join(tmp, '03_voices');
  mkdirSync(exp, { recursive: true });
  writeFileSync(join(exp, 'model_20000.pt'), Buffer.alloc(2048, 42));
  const tools = new Map();
  await apply({ logger: { info() {}, warn() {} }, get: () => ({ register: t => tools.set(t.name, t) }) },
    { songRoot: tmp, ddspDir: ddsp, trainRoot: join(tmp, 'workspace'), voiceLibDir: lib, expName: 'test-experiment' });
  const register = tools.get('train_register').execute;
  const args = { role: 'Test_Role', steps: 20000, libDir: lib };
  const missing = await register(args);
  assert.equal(missing.ok, false, 'config.yaml is required before copying any model');
  assert.equal(existsSync(lib), false);
  writeFileSync(join(exp, 'config.yaml'), 'data:\n  sampling_rate: 44100\n');
  const result = await register(args);
  assert.equal(result.ok, true, result.rendered);
  assert.match(result.targetDir, /reflow-test-experiment$/);
  const target = join(result.targetDir, 'model_20000.pt');
  assert.deepEqual(readFileSync(target), readFileSync(join(exp, 'model_20000.pt')));
  assert.deepEqual(readFileSync(join(result.targetDir, 'config.yaml')), readFileSync(join(exp, 'config.yaml')));
  const manifest = JSON.parse(readFileSync(join(result.targetDir, '.train-manifest.json')));
  assert.equal(manifest.steps, 20000);
  assert.equal(manifest.role, 'Test_Role');
  const cfg = { songRoot: tmp.replace(/\\/g, '/'), voiceLibDir: lib.replace(/\\/g, '/') };
  assert.equal(findVoice({ voices: listVoices(cfg) }, 'TestRole').model, target.replace(/\\/g, '/'));
  assert.equal((await register(args)).ok, false, 'existing registration must not be overwritten implicitly');
  assert.deepEqual(readFileSync(target), readFileSync(join(exp, 'model_20000.pt')));
  assert.equal((await register({ ...args, overwrite: true })).ok, true);
  assert.equal((await register({ ...args, steps: 19000 })).ok, false);
  assert.equal((await register({ ...args, role: ' ' })).ok, false);
  if (process.env.DSH_COVER_PLUGIN_ROOT) {
    const cover = await import(pathToFileURL(join(process.env.DSH_COVER_PLUGIN_ROOT, 'src/config.js')));
    const voice = cover.findVoice({ voices: cover.listVoices(cfg) }, 'TestRole');
    assert.equal(voice.model, target.replace(/\\/g, '/'));
    assert.deepEqual(readFileSync(voice.config), readFileSync(join(exp, 'config.yaml')));
    console.log('PASS: original cover plugin discovers the exact registered model and config');
  }
  console.log('PASS: portable registration, config requirement, reflow naming, sanitization and overwrite guards');
} finally { rmSync(tmp, { recursive: true, force: true }); }
