import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { apply } from '../src/index.js';
import { unpackGame } from '../src/unpack.js';

const py = process.env.DSH_TRAIN_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pythonPath = execFileSync(py, ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim();
mkdirSync('_tmp', { recursive: true });
const tmp = mkdtempSync(resolve('_tmp/duration-'));
try {
  const voices = join(tmp, 'voice');
  const a = join(voices, '01_Alpha');
  const b = join(voices, '02_Beta');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const generate = 'import sys,numpy as np,soundfile as sf;sr=24000;'
    + 'y=(.15*np.sin(2*np.pi*220*np.arange(sr*4)/sr)).astype("float32");'
    + 'sf.write(sys.argv[1],y,sr,format="OGG",subtype="VORBIS");'
    + 'sf.write(sys.argv[2],y,sr,subtype="PCM_16")';
  execFileSync(py, ['-c', generate, join(a, 'tone.ogg'), join(b, 'tone.wav')]);
  const tools = new Map();
  const cfg = { songRoot: tmp, trainRoot: join(tmp, 'workspace'), toolsDir: join(tmp, 'tools'), ddspEnv: pythonPath };
  await apply({ logger: { info() {}, warn() {} }, get: () => ({ register: t => tools.set(t.name, t) }) }, cfg);
  const scan = tools.get('train_scan').execute;
  let result = await scan({ input: voices });
  assert.equal(result.ok, true, result.rendered);
  assert.equal(result.withVoice, 2, 'voice directories must supply acquisition voice counts');
  assert.equal(result.durationComplete, true);
  assert.ok(Math.abs(result.durationSeconds - 8) < .01);
  for (const speaker of result.speakers) assert.ok(Math.abs(speaker.durationSeconds - 4) < .01);
  assert.match(result.rendered, /实测/);
  result = await scan({ input: a });
  assert.equal(result.kind, 'voice-only');
  assert.ok(Math.abs(result.durationSeconds - 4) < .01);
  writeFileSync(join(a, 'broken.ogg'), 'not audio');
  result = await scan({ input: voices });
  const alpha = result.speakers.find(s => s.speaker === 'Alpha');
  assert.equal(alpha.failedFiles, 1);
  assert.equal(alpha.durationSeconds, null, 'partial totals must not masquerade as complete duration');
  assert.equal(result.durationComplete, false);
  assert.match(result.rendered, /时长未知/);
  assert.equal(result.durationSeconds, null);
  // An already extracted voice directory must work without installing unpackers.
  const unpacked = await unpackGame({ cfg, input: voices, outDir: join(tmp, 'unused') });
  assert.equal(unpacked.ok, true);
  const acquired = await tools.get('train_acquire').execute({ input: voices, noInstall: true });
  assert.equal(acquired.ok, true, acquired.rendered);
  console.log('PASS: real OGG/WAV frames, single/multi-role scans, corrupt audio and extracted-input acquisition');
} finally { rmSync(tmp, { recursive: true, force: true }); }
