/**
 * 配置：内置默认值 + 自动发现 + 合并/归一化。
 *
 * 设计原则（沿用 dsh-cover-pipeline 的实证经验）：
 *   1. 路径默认留空，由显式配置、环境变量或当前目录决定。
 *   2. 自动发现只补空值，保留尚未创建的输出目录和错误路径供 doctor 诊断。
 *   3. 所有路径统一成**正斜杠绝对路径**，避免 Windows 反斜杠在 JSON/日志里的转义问题。
 *   4. 可选 `train.local.json`（仓库根，git 忽略）作为**本机覆盖层**，优先级最高。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoPath = (rel) => fileURLToPath(new URL('../' + rel, import.meta.url)).replace(/\\/g, '/').replace(/\/+$/, '');

export const repoRoot = repoPath('.');
export const PY_DIR = repoPath('py');
export const LOCAL_CONFIG = repoPath('train.local.json');

/** 机器相关的默认值。空字符串 = 交给自动发现。 */
export const DEFAULTS = {
  songRoot: '',
  trainRoot: '',
  voiceLibDir: '',

  // 解包工具链的安装位置（空 = <songRoot>/tools）
  toolsDir: '',

  /**
   * 网络代理。**默认空 = 直连**，由部署环境自己决定。
   * 取值顺序：本配置 → HTTPS_PROXY/HTTP_PROXY 环境变量。
   * 这里绝不允许写死某一台机器的地址 —— 插件是要分发的。
   */
  proxy: '',

  ddspDir: '',
  ddspEnv: '',

  ffmpeg: '',

  configName: 'reflow-barbara.yaml',
  expName: 'reflow-test',

  minSec: 3.0,
  maxSec: 15.0,
  targetHours: 0.5,
  sampleRate: 44100,
  speakerFilter: '',

  timeoutMs: 3_600_000,
  maxOutputChars: 6000,
};

const PATH_KEYS = [
  'songRoot', 'trainRoot', 'voiceLibDir', 'toolsDir', 'ddspDir', 'ddspEnv',
];

/** 训练工程里必须存在的脚本（缺任何一个都说明 ddspDir 指错了） */
export const DDSP_SCRIPTS = {
  slice: 'slicer.py',
  draw: 'draw.py',
  preprocess: 'preprocess.py',
  train: 'train_reflow.py',
  infer: 'main_reflow.py',
  batchInfer: 'batch_infer.py',
};

/** 预处理/训练/推理都必须有的权重 */
export const DDSP_ASSETS = {
  hifigan: 'pretrain/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02/model.ckpt',
  contentvec: 'pretrain/contentvec/checkpoint_best_legacy_500.pt',
};

export function toPosixPath(p) {
  if (typeof p !== 'string' || p === '') return p;
  const s = p.replace(/\\/g, '/');
  return isAbsolute(s) ? s : resolve(s).replace(/\\/g, '/');
}

export function join(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p, i) => (i === 0 ? String(p).replace(/\/+$/, '') : String(p).replace(/^\/+|\/+$/g, '')))
    .join('/');
}

export const isFile = (p) => { try { return !!p && existsSync(p) && statSync(p).isFile(); } catch { return false; } };
export const isDir = (p) => { try { return !!p && existsSync(p) && statSync(p).isDirectory(); } catch { return false; } };
const hasFile = (dir, name) => isFile(join(dir, name));

function children(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
  } catch { return []; }
}

function filesOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  } catch { return []; }
}

const childByPrefix = (dir, re) => children(dir).find((p) => re.test(basename(p))) || '';

/** 读本机覆盖层（不存在或格式坏掉都不报错） */
function readLocal() {
  try {
    if (!isFile(LOCAL_CONFIG)) return {};
    return JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8'));
  } catch { return {}; }
}

// ───────────────────────────────────────────────────────────────────────────
// 自动发现
// ───────────────────────────────────────────────────────────────────────────

function pickSongRoot(cfg) {
  return toPosixPath(cfg.songRoot || process.env.DSH_COVER_ROOT || process.cwd());
}

/** DDSP 工程 = 含 train_reflow.py 的那一层（可能在 02_xxx/DDSP-xxx 子目录里） */
function findDdsp(root) {
  const direct = (d) => (hasFile(d, DDSP_SCRIPTS.train) ? d : '');
  const hit = direct(root);
  if (hit) return hit;
  for (const d of children(root)) {
    if (/^0[12][_-]/.test(basename(d))) {
      const nested = direct(d);
      if (nested) return nested;
      for (const dd of children(d)) {
        const deep = direct(dd);
        if (deep) return deep;
      }
    }
  }
  // 兜底：任何一层含 train_reflow.py 的目录
  for (const d of children(root)) {
    for (const dd of children(d)) if (direct(dd)) return dd;
  }
  return '';
}

function pickPython(ddspDir) {
  if (!ddspDir) return '';
  for (const rel of ['env/python.exe', 'env/bin/python', 'env/Scripts/python.exe', 'python.exe']) {
    const p = join(ddspDir, rel);
    if (isFile(p)) return p;
  }
  return '';
}

function pickFfmpeg(cfg) {
  if (isFile(cfg.ffmpeg)) return toPosixPath(cfg.ffmpeg);
  const roots = [cfg.songRoot, process.env.DSH_COVER_ROOT].filter(Boolean);
  for (const r of roots) {
    for (const d of children(r)) {
      if (!/01[_-]/.test(basename(d))) continue;
      for (const rel of ['env/ffmpeg.exe', 'ffmpeg/bin/ffmpeg.exe', 'env/Scripts/ffmpeg.exe']) {
        const p = join(d, rel);
        if (isFile(p)) return p;
      }
    }
  }
  return 'ffmpeg';
}

function discover(cfg) {
  const out = {};
  const root = pickSongRoot(cfg);
  if (!cfg.songRoot) out.songRoot = root;

  if (!cfg.trainRoot) out.trainRoot = process.env.DSH_TRAIN_ROOT || join(root, '04_训练工作区');

  const ddsp = cfg.ddspDir || findDdsp(root);
  if (ddsp && ddsp !== cfg.ddspDir) out.ddspDir = ddsp;

  const python = cfg.ddspEnv || pickPython(ddsp);
  if (python && python !== cfg.ddspEnv) out.ddspEnv = python;

  if (!cfg.voiceLibDir) out.voiceLibDir = childByPrefix(root, /^03[_-]/) || '';

  if (!cfg.ffmpeg) out.ffmpeg = pickFfmpeg({ ...cfg, songRoot: root });

  return out;
}

/** 默认值 → 插件配置 → 非空本机覆盖；自动发现只补空路径。 */
export function resolveConfig(raw = {}) {
  const local = Object.fromEntries(Object.entries(readLocal()).filter(([, v]) => v !== '' && v != null));
  const merged = { ...DEFAULTS, ...raw, ...local };
  for (const k of PATH_KEYS) merged[k] = toPosixPath(merged[k] ?? '');
  for (const k of ['minSec', 'maxSec', 'targetHours']) merged[k] = Number(merged[k]) || DEFAULTS[k];
  for (const k of ['sampleRate', 'timeoutMs', 'maxOutputChars']) merged[k] = Number(merged[k]) || DEFAULTS[k];

  const found = discover(merged);
  const cfg = { ...merged, ...found };
  for (const k of PATH_KEYS) cfg[k] = toPosixPath(cfg[k] ?? '');
  if (/[\\/]/.test(cfg.ffmpeg)) cfg.ffmpeg = toPosixPath(cfg.ffmpeg);

  cfg.configPath = cfg.ddspDir ? join(cfg.ddspDir, 'configs', cfg.configName) : '';
  cfg.expDir = cfg.ddspDir ? join(cfg.ddspDir, 'exp', cfg.expName) : '';
  cfg.trainAudioDir = cfg.ddspDir ? join(cfg.ddspDir, 'data/train/audio') : '';
  cfg.valAudioDir = cfg.ddspDir ? join(cfg.ddspDir, 'data/val/audio') : '';
  cfg.voices = listVoices(cfg);
  return cfg;
}

// ───────────────────────────────────────────────────────────────────────────
// 音色库
// ───────────────────────────────────────────────────────────────────────────

/**
 * 扫描音色库，规则**与 dsh-cover-pipeline 完全一致**（这是闭环的契约，不能改）：
 *   03_xxx/<音色名>_步数N/exp[exp名]/reflow[reflow名]/model_<步数>.pt
 * 训练插件产出的模型只要落进这个结构，翻唱插件下次加载就能看见。
 */
export function listVoices(cfg) {
  const libs = [];
  if (isDir(cfg.voiceLibDir)) libs.push(cfg.voiceLibDir);
  for (const d of children(cfg.songRoot || '')) {
    if (/^03[_-]/.test(basename(d)) && !libs.includes(d)) libs.push(d);
  }
  const out = [];
  const seen = new Set();
  for (const lib of libs) {
    for (const vd of children(lib)) {
      const name = basename(vd).split('_')[0] || basename(vd);
      for (const exp of children(vd)) {
        if (!/^exp/i.test(basename(exp))) continue;
        const rt = children(exp).find((d) => /reflow/i.test(basename(d))) || exp;
        for (const f of filesOf(rt)) {
          const m = /^model_(\d+)\.pt$/.exec(f);
          if (!m || Number(m[1]) <= 0) continue;
          const model = join(rt, f);
          if (seen.has(model)) continue;
          seen.add(model);
          out.push({
            name, dir: vd, exp: rt, model,
            config: join(rt, 'config.yaml'),
            steps: Number(m[1]),
            source: 'library',
          });
        }
      }
    }
  }
  return out;
}

/** 按名字找音色（精确优先，再做包含匹配），与 cover 插件同规则。 */
export function findVoice(cfg, query) {
  const vs = Array.isArray(cfg.voices) ? cfg.voices : listVoices(cfg);
  const norm = (s) => String(s ?? '').replace(/[\s_·・.\-]/g, '').toLowerCase();
  const q = norm(query);
  if (!q) return null;
  const exact = vs.filter((v) => norm(v.name) === q);
  if (exact.length) return exact[0];
  const part = vs.filter((v) => norm(v.name).includes(q) || q.includes(norm(v.name)));
  return part[0] ?? null;
}

/** 训练工作区里的固定子目录 */
export function workspace(cfg, name) {
  const base = cfg.trainRoot || join(cfg.songRoot, '04_训练工作区');
  return {
    base,
    jobs: join(base, 'jobs'),
    logs: join(base, 'logs'),
    corpus: join(base, 'corpus'),          // 解包产物 + lines.jsonl
    datasets: join(base, 'datasets'),      // dataset_raw/<角色>/*.wav
    reports: join(base, 'reports'),        // qc / build 报告
    name: name ?? '',
  };
}

export function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
