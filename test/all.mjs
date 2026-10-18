import { spawnSync } from 'node:child_process';
process.env.PYTHONIOENCODING = 'utf-8';
process.env.PYTHONUTF8 = '1';
for (const name of ['smoke', 'config', 'execution', 'ks', 'parser', 'duration', 'register', 'package']) {
  const run = spawnSync(process.execPath, [`test/${name}.mjs`], { stdio: 'inherit', env: process.env });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}
