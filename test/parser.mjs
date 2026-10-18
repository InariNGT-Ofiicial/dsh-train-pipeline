/**
 * 端到端自检（不碰真游戏）：造一份「假解包产物」把
 *   krkr_parse.py → build_dataset.py → qc_dataset.py
 * 这条链路真跑一遍。
 *
 * fixture 故意混用三种键名风格（name/voice、speaker/message/vofile、chara/text），
 * 用来验证启发式解析器不是只认一种游戏。
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.PYTHONIOENCODING = 'utf-8';
process.env.PYTHONUTF8 = '1';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const tmp = join(root, '_tmp', 'fixture');

const PY = process.env.DSH_TRAIN_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');

const run = (args) => {
  const out = execFileSync(PY, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().startsWith('{')) {
      try { return JSON.parse(lines[i]); } catch { /* 继续 */ }
    }
  }
  throw new Error(`没有 JSON 输出: ${out.slice(-400)}`);
};

// ── 1 · 造 fixture ────────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(tmp, 'scn'), { recursive: true });
mkdirSync(join(tmp, 'voice'), { recursive: true });

const scn1 = {
  scenes: [{
    texts: [
      { name: '芳乃', text: '……どうして、ここに？', voice: 'a01_001' },
      { name: '将臣', text: 'それはこっちの台詞だ', voice: 'a01_002' },
      { name: '', text: '（夕阳洒在神社的石阶上）', voice: null },
      { name: '芳乃', text: 'ふふ、そうですね', voice: 'a01_003' },
    ],
  }],
};
const scn2 = {
  root: {
    blocks: [
      { speaker: '茉子', message: 'からかうのはやめてください', vofile: { file: 'a02_010.ogg' } },
      { chara: '芳乃', text: 'ごめんなさい、茉子', voice: 'a02_011' },
      { chara: '丛雨', text: '……', voice: 'a02_012' },
    ],
  },
};
writeFileSync(join(tmp, 'scn', 'a01.json'), JSON.stringify(scn1, null, 1), 'utf8');
writeFileSync(join(tmp, 'scn', 'a02.json'), JSON.stringify(scn2, null, 1), 'utf8');

const mkAudio = `
import numpy as np, soundfile as sf, sys, os
sr=44100
d=sys.argv[1]
# 每个文件用不同频率（否则会被质量门正确判为"重复片段"）
# 4 秒正弦，前后各 0.4 秒静音 —— 验证裁静音与时长判定
names=['a01_001','a01_002','a01_003','a02_010','a02_011','a02_012']
for i,name in enumerate(names):
    n=sr*4
    t=np.arange(n)/sr
    y=(0.35*np.sin(2*np.pi*(200+i*37)*t)).astype('float32')
    y[:int(sr*0.4)]=0; y[-int(sr*0.4):]=0
    sf.write(os.path.join(d,name+'.wav'), y, sr, subtype='PCM_16')
print('audio ok')
`;
execFileSync(PY, ['-c', mkAudio, join(tmp, 'voice')], { cwd: root, encoding: 'utf8' });
assert.ok(existsSync(join(tmp, 'voice', 'a01_001.wav')), 'fixture 音频未生成');

// ── 2 · 解析 ──────────────────────────────────────────────────────────────
const linesOut = join(tmp, 'lines.jsonl');
const parse = run([
  join(root, 'py', 'krkr_parse.py'),
  '--scn-dir', join(tmp, 'scn'),
  '--voice-dir', join(tmp, 'voice'),
  '--out', linesOut,
  '--report', join(tmp, 'parse.json'),
]);

assert.equal(parse.scn_files, 2, '应解析 2 个剧本文件');
// 7 条文本里，纯旁白（既无 speaker 也无 voice）按设计被丢弃 → 留 6 条
assert.equal(parse.lines, 6, `应抽到 6 条台词（旁白已丢弃），实际 ${parse.lines}`);
assert.equal(parse.with_voice, 6, `应 6 条带语音，实际 ${parse.with_voice}`);
assert.equal(parse.voice_hit.matched, 6, '6 条语音都应命中');

const names = parse.speakers.map((s) => s.speaker).sort();
assert.deepEqual(names, ['丛雨', '将臣', '茉子', '芳乃'].sort(), `角色集合不对: ${names.join(',')}`);
const fang = parse.speakers.find((s) => s.speaker === '芳乃');
assert.equal(fang.with_voice, 3, '芳乃应有 3 条语音');

const rows = readFileSync(linesOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.equal(rows.length, 6, 'lines.jsonl 行数不对');
assert.ok(!rows.some((r) => r.text.includes('夕阳')), '纯旁白不应进入语料');
assert.ok(rows.some((r) => r.text.includes('どうして')), '文本内容丢失');

// ── 3 · 按角色出数据集 ────────────────────────────────────────────────────
const dsDir = join(tmp, 'dataset');
const build = run([
  join(root, 'py', 'build_dataset.py'),
  '--lines', linesOut,
  '--voice-dir', join(tmp, 'voice'),
  '--out-dir', dsDir,
  '--speaker', '芳乃,茉子',
  '--min-sec', '2',
  '--max-sec', '15',
  '--report', join(tmp, 'build.json'),
]);
assert.ok(build.built >= 4, `应至少产出 4 段，实际 ${build.built}`);
assert.ok(build.minutes > 0, '总时长应 > 0');
const dirs = build.speakers.map((s) => s.speaker).sort();
assert.deepEqual(dirs, ['丛雨', '将臣', '茉子', '芳乃'].filter((x) => dirs.includes(x)).sort(), '');

// ── 4 · 质量门 ────────────────────────────────────────────────────────────
const qc = run([
  join(root, 'py', 'qc_dataset.py'),
  '--dir', dsDir,
  '--sample-rate', '44100',
  '--min-sec', '2',
  '--max-sec', '15',
  '--report', join(tmp, 'qc.json'),
]);
assert.ok(qc.files >= 4, '质量门应看到 ≥4 个文件');
assert.equal(qc.bad, 0, `不应有不合格样本，实际 ${qc.bad}: ${JSON.stringify(qc.bad_samples)}`);
assert.equal(qc.duration_buckets['<min'], 0, '不应有太短的片段');

// ── 5 · 整目录模式（media 适配器复用的那条路）──────────────────────────────
const build2 = run([
  join(root, 'py', 'build_dataset.py'),
  '--voice-dir', join(tmp, 'voice'),
  '--out-dir', join(tmp, 'dataset2'),
  '--voice-only', '--speaker', '单角色',
  '--min-sec', '2',
]);
assert.equal(build2.built, 6, `voice-only 应产出 6 段，实际 ${build2.built}`);

console.log('✅ 端到端自检通过');
console.log(`   parse: ${parse.lines} 行 / ${parse.speakers.length} 角色 / 语音命中 ${parse.voice_hit.matched}/${parse.voice_hit.checked}`);
console.log(`   build: ${build.built} 段 / ${build.minutes} 分钟 → ${dirs.join(', ')}`);
console.log(`   qc:    ${qc.files} 文件 / 合格 ${qc.good} / ${qc.total_minutes} 分钟`);
console.log(`   voice-only: ${build2.built} 段`);
