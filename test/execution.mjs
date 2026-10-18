import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnJob } from '../src/execution.js';

mkdirSync('_tmp', { recursive: true });
const tmp = mkdtempSync(resolve('_tmp/execution-'));
try {
  const logPath = join(tmp, 'spawn.log');
  const result = await spawnJob({ cmd: join(tmp, 'missing-python'), args: [], cwd: tmp, logPath });
  assert.equal(result.pidValid, false);
  assert.ok(existsSync(logPath));
  assert.match(readFileSync(logPath, 'utf8'), /spawn error/);
  console.log('PASS: failed background spawn is reported and recorded in the log');
} finally { rmSync(tmp, { recursive: true, force: true }); }
