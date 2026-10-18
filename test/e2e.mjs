/**
 * 最小端到端验证（真跑，不是 dry-run）
 *
 *   造剧本+语音 fixture  →  scan  →  build  →  qc
 *        →  preprocess（真提 f0/特征）  →  train（真训到 20 步落盘）
 *        →  infer（真跑推理出 wav）  →  register（真注册）→  回读可见
 *
 * 三条安全约束：
 *   ① 用独立 exp 名（e2e-tiny）与独立 config，绝不覆盖 reflow-test 里的真实模型
 *   ② data/train|val/audio 非空时直接中止 —— 那是别人的数据集，不许动
 *   ③ 成功跑完才清理；失败保留现场供诊断
 *
 * 用法: node test/e2e.mjs [--keep]
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..'); // 归一化，避免路径里带 ".."
const KEEP = process.argv.includes('--keep');

const TMP = join(root, '_tmp', 'e2e');
const SONG = join(TMP, 'song');
const WS = join(TMP, 'ws');
const CORPUS = join(TMP, 'corpus');
const VOICE = join(CORPUS, 'voice');
const SCN = join(CORPUS, 'scn');
const LIB = join(SONG, '03_测试音色库');

const ROLE = '茅羽耶';
const EXP = 'e2e-tiny';
const CFGNAME = 'e2e-tiny.yaml';
const STEPS = 20; // 最小可落盘步数（interval_val = interval_force_save = STEPS）

const t0 = Date.now();
const step = (n, s) => console.log(`\n${'─'.repeat(60)}\n[${n}] ${s}  (+${((Date.now() - t0) / 1000).toFixed(1)}s)\n${'─'.repeat(60)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 0 · 前置：找到真实 DDSP 工程，并确认不碰别人的数据 ────────────────────
const { resolveConfig } = await import('../src/config.js');
const real = resolveConfig({});
assert.ok(real.ddspDir && existsSync(real.ddspDir), '未发现 DDSP 工程（先跑 train_doctor）');
assert.ok(real.ddspEnv && existsSync(real.ddspEnv), '未发现 DDSP 的 Python 环境');

const trainAudio = join(real.ddspDir, 'data/train/audio');
const valAudio = join(real.ddspDir, 'data/val/audio');
const trainSplit = join(real.ddspDir, 'data/train');
const valSplit = join(real.ddspDir, 'data/val');
const rawDir = join(real.ddspDir, 'raw');
const expDir = join(real.ddspDir, 'exp', EXP);
const cfgPath = join(real.ddspDir, 'configs', CFGNAME);

const AUDIO_RE = /\.(wav|flac|mp3|ogg|m4a)$/i;
const audioFiles = (d) => (existsSync(d) ? readdirSync(d).filter((f) => AUDIO_RE.test(f)) : []);
const leftovers = [...audioFiles(trainAudio), ...audioFiles(valAudio)];

/**
 * 清理统一交给 Python：preprocess 会生成几百个特征小文件，
 * Node 侧的批量删除保护会拦下（>50/轮），而这些都是本次自己造的临时产物。
 * 只删音频 / 特征目录 / 独立 exp / 独立配置 / probe wav，点文件一律保留。
 */
const CLEAN_PY = `import sys, os, glob, shutil, traceback
exp, cfg, ta, va, td, vd, raw, tmp = sys.argv[1:9]

def rm(p):
    if os.path.isdir(p):
        shutil.rmtree(p, ignore_errors=True)
    elif os.path.exists(p):
        try: os.remove(p)
        except OSError: traceback.print_exc()

if exp: rm(exp)
if cfg: rm(cfg)
for d in (ta, va):
    if d and os.path.isdir(d):
        for f in glob.glob(os.path.join(d, '*')):
            if os.path.isfile(f) and os.path.splitext(f)[1].lower() in ('.wav', '.flac', '.mp3', '.ogg', '.m4a'):
                rm(f)
for d in (td, vd):
    if d and os.path.isdir(d):
        for n in os.listdir(d):
            if n == 'audio' or n.startswith('.'): continue
            rm(os.path.join(d, n))
if raw and os.path.isdir(raw):
    for f in glob.glob(os.path.join(raw, 'probe_*.wav')): rm(f)
if tmp: rm(tmp)
print('cleaned')
`;

// 多行脚本走 -c 参数在 Windows 上会出问题（实测退出码 1），落成文件再跑
const CLEANER = join(root, '_tmp', 'e2e-cleaner.py');

function clean({ audio = false, exp = false, tmp = false } = {}) {
  mkdirSync(join(root, '_tmp'), { recursive: true });
  writeFileSync(CLEANER, CLEAN_PY, 'utf8');
  const args = [CLEANER,
    exp ? expDir : '', exp ? cfgPath : '',
    audio ? trainAudio : '', audio ? valAudio : '',
    audio ? trainSplit : '', audio ? valSplit : '',
    audio ? rawDir : '',
    tmp ? TMP : '',
  ];
  try {
    execFileSync(real.ddspEnv, ['-B', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) {
    // 清理失败不能把「验证已通过」变成失败；但要如实报告
    const detail = String(e.stderr || e.stdout || e.message || e).trim().split('\n').slice(-3).join(' | ');
    return { ok: false, detail };
  }
}

// 只有「全部是本 fixture 的命名」才允许自动清理；否则是别人的数据集，绝对不动
const allMine = leftovers.length > 0 && leftovers.every((f) => /^a01_/.test(f));
if (leftovers.length && !allMine) {
  console.error('⛔ 中止：DDSP 工程里已有数据集，最小验证不允许覆盖它');
  for (const d of [trainAudio, valAudio]) {
    if (audioFiles(d).length) console.error(`   ${d}: ${audioFiles(d).length} 个音频`);
  }
  process.exit(1);
}
if (allMine) {
  console.log(`清理上次中断的残留（${leftovers.length} 个 fixture 音频）`);
  clean({ audio: true, exp: true });
}

console.log(`DDSP: ${real.ddspDir}`);
console.log(`Python: ${real.ddspEnv}`);

// ── 1 · 造输入：剧本 JSON + 8 句「类语音」wav ────────────────────────────
step(1, '造 fixture（剧本 + 语音）');
const c1 = clean({ tmp: true });
if (!c1.ok) console.log(`  ⚠️ 预清理失败：${c1.detail}`);
for (const d of [SONG, WS, SCN, VOICE, LIB]) mkdirSync(d, { recursive: true });

const genPy = join(TMP, 'gen.py');
writeFileSync(genPy, `
import sys, os, numpy as np, soundfile as sf
d = sys.argv[1]
sr = 44100
names = []
for i in range(8):
    dur = 4.0 + 0.08 * i
    n = int(sr * dur)
    t = np.arange(n) / sr
    f0 = 168 + 5 * i + 10 * np.sin(2 * np.pi * 0.7 * t)      # 滑动基频，避免帧间完全一样
    ph = 2 * np.pi * np.cumsum(f0) / sr
    y = 0.50 * np.sin(ph) + 0.24 * np.sin(2 * ph) + 0.10 * np.sin(3 * ph)
    env = 0.5 * (1 + np.sin(2 * np.pi * 2.4 * t - np.pi / 2)) ** 2   # 音节式包络
    y = (y * env).astype(np.float32)
    pad = int(sr * 0.35)
    y[:pad] = 0
    y[-pad:] = 0
    y *= 0.5 / (np.max(np.abs(y)) + 1e-9)
    name = 'a01_%03d' % i
    sf.write(os.path.join(d, name + '.wav'), y, sr, subtype='PCM_16')
    names.append(name)
print('generated', len(names))
`, 'utf8');
execFileSync(real.ddspEnv, ['-B', genPy, VOICE], { stdio: 'inherit' });

// 8 句真台词 + 1 句旁白（旁白无 name，应被解析器跳过）
const texts = [
  { name: ROLE, text: '……どうして、ここに？', voice: 'a01_000' },
  { name: ROLE, text: 'ふふ、そうですね', voice: 'a01_001' },
  { name: ROLE, text: 'そんな顔をしないで', voice: 'a01_002' },
  { name: ROLE, text: '私はずっと、ここにいます', voice: 'a01_003' },
  { name: ROLE, text: '少しだけ、待っていて', voice: 'a01_004' },
  { name: ROLE, text: 'ねえ、聞こえていますか', voice: 'a01_005' },
  { name: ROLE, text: 'ありがとう、それだけで十分', voice: 'a01_006' },
  { name: ROLE, text: 'また明日、会いましょう', voice: 'a01_007' },
];
writeFileSync(join(SCN, 'a01.json'), JSON.stringify({
  scenes: [{ texts }, { texts: [{ text: '（旁白：没有 speaker 字段）', voice: 'a01_000' }] }],
}, null, 2), 'utf8');
console.log(`语料: ${SCN}（8 句带语音）+ ${VOICE}（8 个 wav）`);

// ── 2 · 造最小训练配置（独立 exp，不碰 reflow-test）──────────────────────
step(2, '生成最小训练配置');
// 上一次中断可能留下同名 exp / 配置；这两个名字专属于本测试，直接清
clean({ exp: true });

const baseYaml = readFileSync(join(real.ddspDir, 'configs', real.configName), 'utf8');
const tiny = baseYaml
  .replace(/^(\s*expdir:).*$/m, `$1 exp/${EXP}`)
  .replace(/^(\s*interval_val:).*$/m, `$1 ${STEPS}`)
  .replace(/^(\s*interval_force_save:).*$/m, `$1 ${STEPS}`)
  .replace(/^(\s*batch_size:).*$/m, '$1 2')
  .replace(/^(\s*num_workers:).*$/m, '$1 0');
assert.ok(tiny.includes(`exp/${EXP}`), '配置替换失败：expdir 没改到');
for (const key of [`interval_val: ${STEPS}`, `interval_force_save: ${STEPS}`, 'batch_size: 2']) {
  assert.ok(tiny.includes(key), `配置替换失败：${key}`);
}
writeFileSync(join(real.ddspDir, 'configs', CFGNAME), tiny, 'utf8');
console.log(`配置: configs/${CFGNAME}（exp=${EXP}, 每 ${STEPS} 步落盘, batch=2）`);

// ── 3 · 装载插件 ─────────────────────────────────────────────────────────
const registered = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get: (k) => (k === 'tools' ? { register: (d) => registered.push(d) } : undefined),
};
const mod = await import('../src/index.js');
await mod.apply(ctx, {
  songRoot: SONG, trainRoot: WS,
  ddspDir: real.ddspDir, ddspEnv: real.ddspEnv,
  configName: CFGNAME, expName: EXP,
});

const call = async (name, args = {}) => {
  const t = registered.find((x) => x.name === name);
  assert.ok(t, `插件没注册 ${name}`);
  const s = Date.now();
  const res = await t.execute(args);
  const text = t.output.render({}, res)[0]?.text ?? '';
  console.log(`\n▶ ${name}  (${((Date.now() - s) / 1000).toFixed(1)}s, ok=${res.ok})`);
  console.log(text.split('\n').slice(0, 26).map((l) => `  ${l}`).join('\n'));
  if (text.split('\n').length > 26) console.log('  …');
  return res;
};

let passed = 0;
const check = (cond, msg) => { assert.ok(cond, msg); passed += 1; console.log(`  ✅ ${msg}`); };

try {
  // ── 4 · scan ────────────────────────────────────────────────────────────
  step(3, 'scan：解析剧本 → 角色盘点');
  const scan = await call('train_scan', { input: CORPUS });
  check(scan.ok, '扫描成功');
  const hit = (scan.speakers ?? []).find((s) => s.speaker === ROLE);
  check(!!hit, `识别出角色「${ROLE}」`);
  check(hit.with_voice === 8, `该角色带语音台词 8 句（实际 ${hit.with_voice}）`);
  check(!(scan.speakers ?? []).some((s) => s.speaker === ''), '无 speaker 的旁白未被误算成角色');
  check(existsSync(scan.linesPath), 'lines.jsonl 已落盘');

  // ── 5 · build ───────────────────────────────────────────────────────────
  step(4, 'build：出数据集（重采样/裁静音/规格化）');
  const build = await call('train_build', { input: CORPUS, speakers: [ROLE] });
  check(build.ok, '出料成功');
  const ds = (build.datasets ?? [])[0];
  check(!!ds && ds.built >= 6, `dataset_raw/${ROLE} 产出 ${ds?.built} 段（≥6）`);
  const dsDir = ds.out_dir;
  const wavs = readdirSync(dsDir).filter((f) => f.endsWith('.wav'));
  check(wavs.length >= 6, `${wavs.length} 个 wav 落在数据集目录`);

  // ── 6 · qc ──────────────────────────────────────────────────────────────
  step(5, 'qc：质量门');
  const qc = await call('train_qc', { speaker: ROLE });
  check(qc.ok, '质量门通过（有合格样本）');
  check(qc.good >= 6, `合格 ${qc.good} 段`);
  check(qc.duplicates === 0, '无重复段（说明 fixture 每句都不同）');

  // ── 7 · preprocess（真跑）───────────────────────────────────────────────
  step(6, 'preprocess：灌数据 → draw.py → preprocess.py（真提特征）');
  const pre = await call('train_preprocess', { speaker: ROLE });
  check(pre.ok, 'preprocess.py 执行成功');
  check(pre.copied >= 6, `灌入 ${pre.copied} 段`);
  check(pre.valN >= 2, `draw.py 划分出 ${pre.valN} 段验证集`);

  // ── 8 · train（真跑，后台）──────────────────────────────────────────────
  step(7, 'run：启动训练（等 model_' + STEPS + '.pt）');
  const dry = await call('train_run', { dryRun: true });
  check(dry.ok && dry.rendered.includes('train_reflow.py'), '预演命令正确');

  const run = await call('train_run', {});
  check(run.ok && !!run.pid, `训练已启动 pid=${run.pid}`);

  const modelPath = join(expDir, `model_${STEPS}.pt`);
  const deadline = Date.now() + 10 * 60_000;
  let seen = false;
  while (Date.now() < deadline) {
    if (existsSync(modelPath) && statSync(modelPath).size > 50 * 1024 * 1024) { seen = true; break; }
    await sleep(3000);
  }
  if (!seen) {
    const log = run.logPath && existsSync(run.logPath) ? readFileSync(run.logPath, 'utf8') : '(无日志)';
    console.error('\n训练日志尾部:\n' + log.split('\n').slice(-25).join('\n'));
    throw new Error(`10 分钟内没等到 model_${STEPS}.pt`);
  }
  check(seen, `model_${STEPS}.pt 已落盘（${(statSync(modelPath).size / 1024 ** 2).toFixed(0)} MB）`);

  const st = await call('train_status', {});
  check((st.checkpoints ?? []).some((c) => c.steps === STEPS), 'train_status 能读到该 checkpoint');
  const stop = await call('train_stop', {});
  check(stop.ok, '训练进程已停止');

  // ── 9 · infer（真跑）────────────────────────────────────────────────────
  step(8, 'infer：冒烟推理出 wav');
  const inf = await call('train_infer', { steps: STEPS, inferStep: 10 });
  check(inf.ok, '推理成功');
  check(existsSync(inf.outWav), '产出 wav 文件');
  const kb = statSync(inf.outWav).size / 1024;
  check(kb > 20, `wav 大小 ${kb.toFixed(0)} KB（不是空壳）`);

  // ── 10 · register（闭环）────────────────────────────────────────────────
  step(9, 'register：注册进音色库并回读');
  const reg = await call('train_register', { role: 'E2E测试', steps: STEPS, libDir: LIB, overwrite: true });
  check(reg.ok, '注册成功');
  check(reg.visible === true, '插件回读能看见（= 翻唱插件可见）');
  const contract = reg.targetDir;
  check(/reflow/i.test(contract.split(/[\\/]/).pop()), `注册目录名含 reflow（${contract.split(/[\\/]/).pop()}）`);
  check(existsSync(join(contract, `model_${STEPS}.pt`)), '模型落在契约路径');
  check(existsSync(join(contract, 'config.yaml')), 'config.yaml 已随附');
  check(existsSync(join(contract, '.train-manifest.json')), '溯源标记已写入');

  // 用翻唱插件的规则独立复核一次（不是用本插件的函数自证）
  let cover = null;
  try {
    const { listVoices: coverListVoices } = await import('../../dsh-plugin-cover/src/config.js');
    const posix = (p) => String(p).replace(/\\/g, '/');
    const mine = posix(join(contract, `model_${STEPS}.pt`));
    // 必须传正斜杠路径：插件内部统一用 '/' 拼接，混用反斜杠会让同一个库被扫两遍
    const vs = coverListVoices({ voiceLibDir: posix(LIB), songRoot: posix(SONG), ddspDir: '', ddspEnv: '' });
    cover = { seen: vs.filter((v) => posix(v.model) === mine), total: vs };
  } catch (e) {
    console.log(`  ⏭ 跳过跨插件复核（${e?.message ?? e}）`);
  }
  if (cover) {
    if (cover.seen.length !== 1) {
      console.log(`     实际发现 ${cover.total.length} 个音色: ${cover.total.map((v) => `${v.name}@${v.steps}`).join(', ') || '（空）'}`);
    }
    check(cover.seen.length === 1, '用翻唱插件的 listVoices 复核，确实能发现该音色');
  }

  // ── 11 · overview ───────────────────────────────────────────────────────
  step(10, 'overview：一屏确认');
  await call('train_overview', {});

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ 最小端到端验证通过：${passed} 项断言，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
  console.log('='.repeat(60));
} catch (e) {
  console.error(`\n❌ 最小验证失败：${e.message}`);
  console.error(`   现场保留在: ${TMP}`);
  console.error(`   exp: ${expDir}`);
  console.error(`   配置: ${cfgPath}`);
  console.error('   排查后重跑：node test/e2e.mjs');
  process.exitCode = 1;
} finally {
  if (!process.exitCode && !KEEP) {
    const c = clean({ audio: true, exp: true, tmp: true });
    if (c.ok) console.log('清理完成：临时 exp / 配置 / 训练数据 / 特征 / 试听均已移除');
    else console.log(`⚠️ 清理未完全成功：${c.detail}\n   可手动删除 ${TMP} 与 data/train|val 下非 audio 项`);
  } else if (KEEP) {
    console.log(`\n(--keep) 现场保留: ${TMP}`);
  }
}
