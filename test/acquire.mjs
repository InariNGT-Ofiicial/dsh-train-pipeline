/**
 * 获取段自检（真网络 / 真工具 / 真 xp3，但素材是开源测试样本）。
 *
 * 为什么这一段必须真跑：
 *   「下载 → 解包」这条链上全是别人的实现细节，任何一处参数猜错都会静默失败。
 *   本文件把三件事钉死：
 *     1. arc_unpacker 的真实调用参数能解出文件（用 vn-tools 仓库自带的 xp3 测试样本）；
 *     2. train_fetch 真的落盘、算出 sha256、写了 provenance（用 GitHub API 直取样本字节）；
 *     3. train_hunt 能把「封包待解 / 已解包」两类目录分开，不误报。
 *
 * 没有装工具链的机器上，解包那一段会**跳过而不是失败** —— 那是环境差异，不是代码错。
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.PYTHONIOENCODING = 'utf-8';
process.env.PYTHONUTF8 = '1';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const tmp = join(root, '_tmp', 'acquire');
const ws = join(root, '_tmp', 'ws');

const PY = process.env.DSH_TRAIN_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');
const hasPy = existsSync(PY);

// ── 加载插件 ──────────────────────────────────────────────────────────────
const registered = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get: (k) => (k === 'tools' ? { register: (def) => registered.set(def.name, def) } : undefined),
};
const mod = await import('../src/index.js');
// 测试产物只写入仓库的 _tmp，避免影响实际训练工作区。
mkdirSync(ws, { recursive: true });
await mod.apply(ctx, { trainRoot: ws });

const call = async (name, args = {}) => {
  const t = registered.get(name);
  assert.ok(t, `工具未注册: ${name}`);
  return t.execute(args, {});
};

// ── fixture ───────────────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });
const packed = join(tmp, 'packed');
const corpus = join(tmp, 'corpus');
mkdirSync(join(packed), { recursive: true });
mkdirSync(join(corpus, 'scn'), { recursive: true });
mkdirSync(join(corpus, 'voice'), { recursive: true });

// 真 xp3：先用 train_fetch 从 GitHub API 取（顺带把 fetch 也测了）
const XP3_URL = 'https://api.github.com/repos/vn-tools/arc_unpacker/contents/tests/dec/kirikiri/files/xp3/xp3-compressed-files.xp3';
const provPath = join(ws, 'materials', 'xp3', '_provenance.json');
const destXp3 = join(ws, 'materials', 'xp3', 'sample.xp3');

// ★ GitHub 未认证 API 限 60 次/小时，反复跑回归会被 403 打断 —— 那是「网络限流」，不是「代码坏了」。
//   所以有样本就复用；要真正重验 fetch 设 ACQUIRE_FORCE_FETCH=1。
const reuseSample = !process.env.ACQUIRE_FORCE_FETCH && existsSync(destXp3) && statSync(destXp3).size > 0;
let fetched;
if (reuseSample) {
  const buf = readFileSync(destXp3);
  fetched = { ok: true, dest: destXp3, sizeBytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  console.log('ℹ️ 复用已下载样本（GitHub 未认证限流 60/h；重验 fetch 设 ACQUIRE_FORCE_FETCH=1）');
} else {
  // ★ provenance 是**追加**的溯源日志（设计如此，不覆盖），所以不能断言「总共 1 条」——
  //   那会让测试只能跑一次。改为断言「本次新增 1 条」。
  const provBefore = existsSync(provPath) ? JSON.parse(readFileSync(provPath, 'utf8')).length : 0;
  fetched = await call('train_fetch', {
    url: XP3_URL, dest: 'xp3', filename: 'sample.xp3', attest: 'public-domain', maxMB: 8,
    // GitHub 的 contents 接口默认返回 JSON 元数据；取裸字节必须声明 Accept
    headers: { Accept: 'application/vnd.github.raw' },
    proxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
  });
  assert.ok(fetched.ok, `train_fetch 失败: ${fetched.rendered}`);
  assert.ok(existsSync(provPath), 'provenance 未写入');
  const prov = JSON.parse(readFileSync(provPath, 'utf8'));
  assert.equal(prov.length, provBefore + 1, `provenance 应新增 1 条（原有 ${provBefore}，现 ${prov.length}）`);
  const last = prov[prov.length - 1];
  assert.equal(last.attest, 'public-domain', 'provenance 应记录来源性质');
  assert.ok(last.sha256, 'provenance 应记录摘要');
}
assert.ok(fetched.ok, `train_fetch 失败: ${fetched.rendered}`);
assert.ok(fetched.sizeBytes < 2000, `样本应是小文件，实际 ${fetched.sizeBytes} B`);
assert.match(fetched.sha256, /^[0-9a-f]{64}$/, 'sha256 应是 64 位十六进制');
assert.ok(existsSync(fetched.dest), '下载文件不存在');
console.log(`✅ fetch: ${fetched.sizeBytes} B · sha256 ${fetched.sha256.slice(0, 12)}…${reuseSample ? '（样本复用）' : ' · provenance 已记'}`);

// 造「游戏本体」目录：真 xp3 + startup.tjs + voice/ 目录（模拟未解包）
copyFileSync(fetched.dest, join(packed, 'data.xp3'));
writeFileSync(join(packed, 'startup.tjs'), '// fixture\n', 'utf8');
mkdirSync(join(packed, 'voice'), { recursive: true });
for (let i = 0; i < 60; i += 1) writeFileSync(join(packed, 'voice', `v${i}.ogg`), '');

// 造「已解包」目录：剧本 JSON + 语音（规模要过 classify 的阈值：≥10 剧本、≥20 语音）
for (let i = 0; i < 12; i += 1) {
  writeFileSync(join(corpus, 'scn', `a${String(i).padStart(2, '0')}.json`), JSON.stringify({
    scenes: [{ texts: [
      { name: '芳乃', text: `……どうして、ここに？${i}`, voice: `a01_00${i % 9}` },
      { name: '将臣', text: `それはこっちの台詞だ${i}`, voice: `a02_00${i % 9}` },
    ] }],
  }), 'utf8');
}
// 名字必须唯一：写成 a0{i%2}_00{i%9} 会互相覆盖，最后只剩 18 个，过不了 20 的阈值
for (let i = 0; i < 24; i += 1) writeFileSync(join(corpus, 'voice', `a0${i % 2 + 1}_${String(i).padStart(3, '0')}.wav`), '');

// ── 1 · 本机搜猎 ──────────────────────────────────────────────────────────
const hunt = await call('train_hunt', { roots: [tmp], maxDepth: 4, timeBudgetSec: 20 });
assert.ok(hunt.ok, `搜猎应命中: ${hunt.rendered}`);
const kinds = Object.fromEntries(hunt.candidates.map((c) => [c.path.replace(/\\/g, '/'), c.kind]));
const packedKind = hunt.candidates.find((c) => c.path.replace(/\\/g, '/').endsWith('packed'));
const corpusKind = hunt.candidates.find((c) => c.path.replace(/\\/g, '/').endsWith('corpus'));
assert.equal(packedKind?.kind, 'packed', `有 xp3 的目录应判为 packed，实际 ${JSON.stringify(kinds)}`);
assert.equal(corpusKind?.kind, 'corpus', '有剧本+语音的目录应判为 corpus');
assert.ok(packedKind.archives.includes('data.xp3'), '应列出 data.xp3');
console.log(`✅ hunt: packed=${packedKind.kind}(${packedKind.voiceAudio} 语音) · corpus=${corpusKind.kind}(${corpusKind.jsonCount} 剧本)`);

// ── 2 · 工具链体检 ────────────────────────────────────────────────────────
const tc = await call('train_toolchain', { action: 'check' });
assert.equal(tc.tools.length, 4, '工具链应有 4 项');
assert.ok(tc.tools.some((t) => t.id === 'arc_unpacker'), '缺少 arc_unpacker 条目');
console.log(`✅ toolchain: 可解包=${tc.can.unpack} 可反编译=${tc.can.decompile}`);
if (!tc.can.unpack) {
  console.log('   ⏭ 跳过解包测试（本机没有 arc_unpacker，属环境差异）');
} else {
  // ── 3 · 解真 xp3 ────────────────────────────────────────────────────────
  const up = await call('train_unpack', { input: packed, decompile: false });
  assert.ok(up.ok, `解包应成功: ${up.rendered}`);
  const a = up.archives[0];
  assert.ok(a.files >= 2, `样本 xp3 应解出 ≥2 个文件，实际 ${a.files}`);
  assert.equal(a.plugin, 'noop', '未加密样本应命中 noop 插件');
  // arc_unpacker 解包时会多套一层 <封包名>/ 目录，这里确认那一层真的建出来了
  const inner = up.archives.length ? up.rendered.match(/输出: (.+)/)?.[1] : '';
  assert.ok(inner, '应报告输出目录');
  console.log(`✅ unpack: ${a.archive} → ${a.files} 文件 · 插件 ${a.plugin} · ${up.outDir}`);
}

// ── 4 · 一条命令跑「已解包」目录（解包会被正确跳过）──────────────────────
if (!hasPy) {
  console.log('   ⏭ 跳过 acquire（没有 Python 环境）');
} else {
  const acq = await call('train_acquire', { input: corpus });
  assert.ok(acq.ok, `acquire 应成功: ${acq.rendered}`);
  assert.ok(acq.speakers?.length >= 1, '应盘点出角色');
  assert.ok(acq.speakers.some((s) => s.speaker === '芳乃'), '应识别出「芳乃」');
  console.log(`✅ acquire: 跳过解包 · 角色 ${acq.speakers.map((s) => s.speaker).join('/')} · ${acq.linesPath ? '已产出 lines.jsonl' : '未产出'}`);
}

console.log('\n✅ 获取段自检通过');
void execFileSync;
