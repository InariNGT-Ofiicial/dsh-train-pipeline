/**
 * 环境体检：把「跑不起来」的原因在动手前说清楚。
 *
 * 原则：每条检查都必须给出**具体修复办法**，否则等于没说。
 */
import { existsSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { DDSP_SCRIPTS, DDSP_ASSETS, join, isDir, isFile, workspace } from './config.js';
import { runOnce, pythonEnv } from './execution.js';
import { checkTools } from './toolchain.js';

const CHECKS = [];
const add = (name, level, ok, detail, fix = '') => CHECKS.push({ name, level, ok, detail, fix });

/** 读 YAML 里几个关键标量（不引 yaml 依赖，够用即可） */
function readYamlScalars(path) {
  const out = {};
  try {
    const text = readFileSync(path, 'utf8');
    const grab = (key) => {
      const re = new RegExp(`^\\s*${key}\\s*:\\s*('?)([^'#\\n]+)\\1`, 'm');
      const m = re.exec(text);
      return m ? m[2].trim() : null;
    };
    out.duration = Number(grab('duration'));
    out.sampling_rate = Number(grab('sampling_rate'));
    out.expdir = grab('expdir');
    out.batch_size = Number(grab('batch_size'));
    out.encoder_ckpt = grab('encoder_ckpt');
    out.vocoder_ckpt = grab('ckpt');
  } catch { /* ignore */ }
  return out;
}

function diskFreeBytes(dir) {
  try {
    const st = statfsSync(dir);
    return st.bavail * st.bsize;
  } catch { return null; }
}

export async function doctor(cfg) {
  CHECKS.length = 0;
  const d = cfg.ddspDir;

  // ── 1 · DDSP 工程 ─────────────────────────────────────────────────────
  if (!d || !isDir(d)) {
    add('DDSP 工程目录', 'error', false, `不存在: ${d || '(空)'}`,
      '把 DDSP 整合包解到 <根>/02_*/DDSP-*/，或用 train_setup 指定 ddspDir');
  } else {
    add('DDSP 工程目录', 'info', true, d);
    const missing = Object.entries(DDSP_SCRIPTS)
      .filter(([, f]) => !isFile(join(d, f))).map(([k, f]) => `${k}:${f}`);
    add('训练脚本完整性', 'error', missing.length === 0,
      missing.length ? `缺 ${missing.join(', ')}` : '6 个脚本齐全（slice/draw/preprocess/train/infer/batch）',
      missing.length ? '确认 ddspDir 指向含 train_reflow.py 的那一层，而不是它的父目录' : '');
    for (const [k, rel] of Object.entries(DDSP_ASSETS)) {
      const p = join(d, rel);
      add(`权重 ${k}`, 'error', isFile(p), isFile(p) ? p : `缺失: ${rel}`, '见 materials/README.md 的网盘清单');
    }
  }

  // ── 2 · Python 环境 ───────────────────────────────────────────────────
  if (!cfg.ddspEnv || !isFile(cfg.ddspEnv)) {
    add('DDSP Python', 'error', false, `不存在: ${cfg.ddspEnv || '(空)'}`,
      '整合包自带 env/python.exe；若用独立环境，把 ddspEnv 指过去');
  } else {
    const r = await runOnce({
      cmd: cfg.ddspEnv, args: ['-c', 'import sys;print(sys.version.split()[0])'],
      cwd: d, env: pythonEnv(d, cfg.ddspEnv), timeoutMs: 60_000,
    });
    add('DDSP Python', 'error', r.ok, r.ok ? `${cfg.ddspEnv} → Python ${r.stdout.trim()}` : (r.stderr || r.error || '无法执行').slice(-300),
      '检查 env 是否被移动/删除，或杀软拦截');
    if (r.ok) {
      const dep = await runOnce({
        cmd: cfg.ddspEnv,
        args: ['-c', 'import torch,soundfile,librosa,numpy;print("torch",torch.__version__,"cuda",torch.cuda.is_available())'],
        cwd: d, env: pythonEnv(d, cfg.ddspEnv), timeoutMs: 180_000,
      });
      add('Python 依赖', 'error', dep.ok,
        dep.ok ? dep.stdout.trim().split('\n').pop() : (dep.stderr || '').split('\n').slice(-3).join(' '),
        '在整合包 env 里 pip install -r requirements.txt（别用系统 Python）');
      if (dep.ok && /cuda True/.test(dep.stdout)) add('CUDA', 'info', true, 'torch 可用 CUDA');
      else if (dep.ok) add('CUDA', 'warn', false, 'torch 报告 cuda 不可用', '训练需要 N 卡 + 驱动；CPU 训练慢到不可用');
    }
  }

  // ── 3 · 训练配置 ──────────────────────────────────────────────────────
  if (!cfg.configPath || !isFile(cfg.configPath)) {
    add('训练配置', 'error', false, `不存在: ${cfg.configPath || '(空)'}`, `确认 configs/${cfg.configName} 存在`);
  } else {
    const y = readYamlScalars(cfg.configPath);
    add('训练配置', 'info', true, `${cfg.configName} · duration=${y.duration}s · sr=${y.sampling_rate} · batch=${y.batch_size}`);
    if (y.sampling_rate && y.sampling_rate !== cfg.sampleRate) {
      add('采样率一致性', 'error', false, `配置要求 ${y.sampling_rate}Hz，插件设置 ${cfg.sampleRate}Hz`,
        '两者必须一致，否则预处理出的特征全部错位');
    } else {
      add('采样率一致性', 'info', true, `${cfg.sampleRate}Hz`);
    }
    const dur = Number(y.duration) || 0;
    if (dur && cfg.minSec < dur + 1) {
      add('片段时长下限', 'warn', false,
        `minSec=${cfg.minSec}s，而配置 duration=${dur}s —— 太短的片段会让训练报错`,
        `把 minSec 提到 ≥ ${dur + 1}s（推荐 ${dur + 2}s）`);
    } else {
      add('片段时长下限', 'info', true, `minSec=${cfg.minSec}s ≥ duration=${dur}s`);
    }
    if (y.expdir && !y.expdir.endsWith(cfg.expName)) {
      add('exp 目录', 'warn', false, `配置 expdir=${y.expdir}，插件期望 exp/${cfg.expName}`,
        `改 configName 或把配置里的 expdir 改成 exp/${cfg.expName}`);
    } else {
      add('exp 目录', 'info', true, join(d, 'exp', cfg.expName));
    }
  }

  // ── 4 · 外部工具 ──────────────────────────────────────────────────────
  if (cfg.ffmpeg && cfg.ffmpeg !== 'ffmpeg' && isFile(cfg.ffmpeg)) {
    const r = await runOnce({ cmd: cfg.ffmpeg, args: ['-version'], timeoutMs: 30_000 });
    add('ffmpeg', 'error', r.ok, r.ok ? r.stdout.split('\n')[0] : '无法执行', '用 MSST 整合包里自带的那份完整版');
  } else {
    const r = await runOnce({ cmd: 'ffmpeg', args: ['-version'], timeoutMs: 20_000 });
    add('ffmpeg', 'warn', r.ok, r.ok ? 'PATH 中的 ffmpeg 可用' : '未找到 ffmpeg',
      '转码需要它；精简版可能读不了 wav，建议指定 MSST 整合包里的 ffmpeg.exe');
  }

  // ── 5 · 工作区与磁盘 ──────────────────────────────────────────────────
  const ws = workspace(cfg);
  const capacity = diskFreeBytes(isDir(dirname(ws.base)) ? dirname(ws.base) : cfg.songRoot);
  if (capacity !== null) {
    const gb = capacity / 1024 ** 3;
    add('磁盘余量', gb < 5 ? 'error' : 'info', gb >= 5, `${gb.toFixed(1)} GB 可用（工作区所在盘）`,
      gb < 5 ? '训练会产生大量切片与 checkpoint，至少留 5GB' : '');
  }
  add('训练工作区', 'info', isDir(ws.base), ws.base, '首次 train_build 时会自动创建');

  // ── 6 · 音色库（闭环出口）───────────────────────────────────────────────
  add('音色库', cfg.voices.length ? 'info' : 'warn', true,
    cfg.voiceLibDir ? `${cfg.voiceLibDir} → ${cfg.voices.length} 个可用权重` : '未发现 03_* 音色库目录',
    cfg.voices.length ? '' : '训练完成后 train_register 会自动建目录；也可先手动建 03_音色模型_xxx/');

  // ── 7 · galgame 工具链（可选，但决定能不能自动取材）─────────────────────
  // 注意这里用的是 toolchain 模块的统一判定，而不是自己再猜一遍路径：
  //   can.unpack / can.decompile 表示「插件能无人值守调用」，
  //   只有 GUI 的工具即使装了也不计入 can —— 否则会给出工具就绪的假象。
  const tc = checkTools(cfg);
  add('解包器 arc_unpacker', 'warn', tc.can.unpack,
    tc.can.unpack ? tc.tools.find((t) => t.id === 'arc_unpacker')?.bin : `未安装（找不到 ${tc.root}/arc_unpacker）`,
    'train_toolchain action=install 可自动从官方 release 装好');
  add('反编译 PsbDecompile', 'warn', tc.can.decompile,
    tc.can.decompile ? tc.tools.find((t) => t.id === 'freemote')?.bin : '未安装（反编译 scn/psb 必需）',
    'train_toolchain action=install id=freemote');
  const guiTools = tc.tools.filter((t) => t.installed && !t.cli).map((t) => t.name);
  add('GUI 兜底工具', 'info', true,
    guiTools.length ? `已备: ${guiTools.join(' / ')}（加密封包时人工用）` : '未装 GARbro / KrkrExtract（遇到加密封包时才需要）',
    guiTools.length ? '' : 'train_toolchain action=install id=krkrextract');

  const errors = CHECKS.filter((c) => c.level === 'error' && !c.ok);
  const warns = CHECKS.filter((c) => c.level === 'warn' && !c.ok);
  return { ok: errors.length === 0, checks: CHECKS.slice(), errors, warnings: warns };
}

export function renderDoctor(res) {
  // info 且 ok=false 只是「尚未创建」之类的提示，不该用警告图标吓人
  const icon = (c) => (c.ok ? '✅' : c.level === 'error' ? '❌' : c.level === 'warn' ? '⚠️' : '·');
  const lines = [`【训练环境体检】${res.ok ? '硬依赖通过' : `${res.errors.length} 项阻塞`}`
    + (res.warnings.length ? ` · ${res.warnings.length} 项提醒` : '')];
  for (const c of res.checks) {
    lines.push(`${icon(c)} ${c.name}: ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`    ↳ ${c.fix}`);
  }
  if (!res.ok) lines.push('', '★ 有阻塞项时不要开始训练：先修上面 ❌ 的项。');
  return lines.join('\n');
}
