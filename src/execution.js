/**
 * 执行层：统一的子进程调用、产物自证、后台任务。
 *
 * 三条硬规矩（都是踩过的坑）：
 *   1. **产物自证**：退出码 0 不等于成功。每个阶段都要回读产物大小，缺失即失败。
 *   2. **不吞 stderr**：失败时把尾部原样带回，否则用户只能看到"没成功"。
 *   3. **后台任务写日志文件**：训练可能跑几小时，进程被回收也必须能从日志恢复进度。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

/** 把 Windows 路径里的空格等安全地拼成一行（仅用于展示） */
export function cmdlineOf(cmd, args = []) {
  const q = (s) => (/[\s"]/u.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
  return [q(cmd), ...args.map(q)].join(' ');
}

/** 相对 ddspDir 的 Python 环境，前置 env/Scripts 到 PATH（DDSP 的 bat 就是这么做的） */
export function pythonEnv(ddspDir, pythonExe, extra = {}) {
  const sep = delimiter;
  const pre = ddspDir
    ? [`${ddspDir}/env/Scripts`, `${ddspDir}/env/bin`, `${ddspDir}/env`].join(sep) + sep
    : '';
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PATH: pre + (process.env.PATH ?? ''),
    ...extra,
  };
}

/** 前台执行一次，收集输出，超时强杀。 */
export function runOnce({ cmd, args = [], cwd, env, timeoutMs = 3_600_000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, exitCode: null, stdout, stderr: String(e?.message ?? e), ms: 0, error: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.stdout?.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout, stderr: stderr + '\n' + String(e?.message ?? e), ms: Date.now() - started, error: String(e?.message ?? e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, exitCode: code, stdout, stderr, ms: Date.now() - started, timedOut });
    });
  });
}

/** 后台启动，stdout/stderr 落到日志文件；进程 detach，插件重载也不影响训练。 */
export async function spawnJob({ cmd, args = [], cwd, env, logPath }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(cmd, args, {
      cwd, env, windowsHide: true, detached: true,
      stdio: ['ignore', fd, fd],
    });
    // ★ spawn 失败（找不到 exe / cwd 不存在）在 detached 下是**静默**的：
    //   父进程秒退、日志 0 字节，看起来像"启动了但没动静"。必须把错误写进日志。
    child.on('error', (e) => {
      try { appendFileSync(logPath, `\n[spawn error] ${e?.message ?? e}\n`); } catch { /* ignore */ }
    });
  } finally {
    closeSync(fd);
  }
  const started = await new Promise((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  child.unref();
  return { pid: child.pid, logPath, pidValid: started && Number.isInteger(child.pid) };
}

/** 产物自证：回读每个路径的存在性与大小。 */
export function artifactsOf(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p);
  return list.map((p) => {
    let exists = false;
    let sizeBytes = 0;
    try {
      if (existsSync(p)) { exists = true; sizeBytes = statSync(p).size; }
    } catch { /* ignore */ }
    return { path: p, exists, sizeBytes };
  });
}

/** 产物判定：全部存在且大于阈值字节 */
export function artifactsOk(paths, minBytes = 1024) {
  const arts = artifactsOf(paths);
  return { arts, ok: arts.length > 0 && arts.every((a) => a.exists && a.sizeBytes >= minBytes) };
}

/** 读日志尾部若干行（后台任务的唯一进度来源） */
export function tailFile(path, lines = 40) {
  try {
    if (!existsSync(path)) return '';
    const text = readFileSync(path, 'utf8');
    const arr = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    return arr.slice(-lines).join('\n');
  } catch { return ''; }
}

/** 从日志里抓最新的训练进度（DDSP 的 tqdm/日志格式不稳定，故只做尽力而为的解析） */
export function parseProgress(text) {
  const out = { step: null, loss: null, epoch: null };
  if (!text) return out;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (out.step === null) {
      const m = /(?:step|Step|it(?:er)?)[\s:=]*([0-9]{2,7})/.exec(l) || /^\s*([0-9]{2,7})\s*\|/.exec(l);
      if (m) out.step = Number(m[1]);
    }
    if (out.loss === null) {
      const m = /(?:loss|Loss)\s*[:=]?\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)/.exec(l);
      if (m) out.loss = Number(m[1]);
    }
    if (out.epoch === null) {
      const m = /epoch\s*[:=]?\s*([0-9]+)/i.exec(l);
      if (m) out.epoch = Number(m[1]);
    }
    if (out.step !== null && out.loss !== null) break;
  }
  return out;
}

/** 扫 exp 目录里已落盘的 model_<步数>.pt，返回按步数升序的列表 */
export function scanCheckpoints(expDir) {
  try {
    if (!existsSync(expDir)) return [];
    return readdirSync(expDir)
      .map((f) => /^model_(\d+)\.pt$/.exec(f))
      .filter(Boolean)
      .map((m) => ({ steps: Number(m[1]), file: m[0] }))
      // model_0.pt 是初始权重，不是训练产物，不能当 checkpoint 用
      .filter((x) => x.steps > 0)
      .sort((a, b) => a.steps - b.steps);
  } catch { return []; }
}
