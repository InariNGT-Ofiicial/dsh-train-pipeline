/**
 * 真游戏跑出来的两个盲区，各配一个可重复的回归测试。
 *
 * 背景：拿 Vector 的免费同人 galgame（SPARTOI 吉里吉里版，2007，KAG3）真跑了一遍，
 * 发现插件当时两处会直接断链：
 *   ① 单文件发行版：数据追加在 exe 尾部，目录里没有任何 .xp3 → 被判成「没有封包」
 *   ② KAG3 明文 .ks 剧本：解析器只认反编译后的 JSON → 一整个世代的游戏全部漏掉
 *
 * 本文件不依赖那部游戏（不能把别人的游戏打包进仓库），用合成 fixture 固定行为：
 *   A. .ks 解析：CP932 编码、[name] 状态机、inline 名字、playse 不能当语音、术语表误判
 *   B. 内嵌封包：探测/校验/切出，以及「签名对但索引不自洽」必须拒绝
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.PYTHONIOENCODING = 'utf-8';
process.env.PYTHONUTF8 = '1';

import { probeEmbeddedXp3, carveEmbeddedXp3 } from '../src/unpack.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const tmp = join(root, '_tmp', 'ks');
const PY = process.env.DSH_TRAIN_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');

// ── A · KAG3 明文剧本 ────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(tmp, 'scn'), { recursive: true });

const KS = [
  '; 合成 fixture 実データではありません',
  '*start',
  '[playse storage="snd_bomb.ogg"]',
  '[name name="芳乃"]',
  '「……どうして、ここに？」',
  '今日はいい天気ですね。[r]',
  '[name name="将臣"]',
  'そうだな。[r]',
  '[link2 target=*a][selectidx]メニュー項目「選択肢」[endlink2][r]',
  '[playse storage="v_001.ogg"]',
  '芳乃「タグを使わない名前の書き方です」',
  '用語集「ミーミアー」',
  '芳乃「はい」',
  '',
].join('\r\n');

// 故意写成 CP932（Shift_JIS）：KAG3 时代几乎全是这个编码，
// 用 UTF-8 存会让这个测试失去意义。Node 没有内置 CP932 编码器，借 Python 写字节。
writeFileSync(join(tmp, 'src.utf8.ks'), KS, 'utf8');
execFileSync(PY, ['-B', '-c',
  'import sys,io;'
  + 'src,dst=sys.argv[1],sys.argv[2];'
  + 'open(dst,"wb").write(io.open(src,encoding="utf-8").read().encode("cp932"))',
  join(tmp, 'src.utf8.ks'), join(tmp, 'scn', 'test.ks'),
], { encoding: 'utf8' });

// 二进制护栏：.ks 位置上也可能躺着二进制（比如存档被改名）。
// utf-16 这类编码几乎永远"解码成功"，所以必须有内容级判断，不能只靠 try/except。
writeFileSync(join(tmp, 'scn', 'bogus.ks'), Buffer.concat([
  Buffer.alloc(400, 0x00), Buffer.from('これはテキストではない', 'utf8'),
]));

const parseOut = execFileSync(PY, [
  '-B', join(root, 'py', 'krkr_parse.py'),
  '--scn-dir', join(tmp, 'scn'),
  '--out', join(tmp, 'lines.jsonl'),
  '--report', join(tmp, 'report.json'),
  '--json',
], { cwd: root, encoding: 'utf8' });
const rep = JSON.parse(parseOut.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop());
const rows = readFileSync(join(tmp, 'lines.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));

assert.equal(rep.ks_files, 2, '应识别出 2 个 .ks（含 1 个二进制）');
assert.deepEqual(rep.encodings, { cp932: 1 }, '只有真剧本该被算进编码统计');
assert.equal(rep.binary_skipped, 1, '二进制 .ks 应被内容级护栏挡掉，而不是硬解出垃圾');
assert.equal(rep.bad_files, 0, '不应有解码失败的文件');
assert.equal(rep.menu_lines, 1, 'menu_lines：link2 那一行应被当成菜单过滤');

const byText = (frag) => rows.find((r) => r.text.includes(frag));

// ① [name] 状态机：设定一次，后续多行都算这个角色
assert.equal(byText('ここに')?.speaker, '芳乃', '[name] 之后的台词应归到芳乃');
assert.equal(byText('いい天気')?.speaker, '芳乃', '[name] 的说话人应保持到下一个 [name]');
assert.equal(byText('そうだな')?.speaker, '将臣', '切换 [name] 后应改判');

// ② inline 写法：名前「台词」
assert.equal(byText('タグを使わない')?.speaker, '芳乃', '「名前「台词」」写法应认出说话人');
assert.equal(byText('タグを使わない')?.speaker_source, 'inline', '来源应标 inline');

// ③ playse 不能当语音（这是最危险的误判：会把音效当成台词音频）
const bomb = rows.find((r) => r.voice === 'snd_bomb' || r.voice === 'snd_bomb.ogg');
assert.equal(bomb, undefined, 'snd_bomb.ogg 是音效，绝不能算成台词语音');
// 两个 playse 都记进 sound_refs（v_001 也是 playse），但只有名字像语音的那个额外算 voice
assert.equal(rep.sound_refs, 2, 'playse 引用总数应记进 sound_refs');

// ④ 但名字像语音的 playse 要采纳
const voiced = rows.find((r) => r.voice === 'v_001');
assert.ok(voiced, 'v_001.ogg 名字像语音，应被采纳为台词语音');
assert.equal(voiced.text.includes('タグを使わない'), true, '语音应挂到紧随其后的那句台词上');
assert.equal(rep.voice_refs_from_playse, 1, '应记录来自 playse 的语音引用');

// ⑤ 术语表误判：和「名前「台词」」写法长得一样，但必须丢掉
assert.equal(byText('ミーミアー'), undefined, '术语表「用語集「ミーミアー」」不应被当成台词');

// ⑥ 极短的一句：inline 写法按精度优先原则丢弃（build 阶段本来也会按时长过滤）
assert.equal(rows.find((r) => r.text === 'はい'), undefined, 'inline 写法的极短句按精度优先原则丢弃');
assert.ok(rep.inline_rejected >= 2, `应记录被拒的 inline 行，实际 ${rep.inline_rejected}`);

console.log(`✅ .ks 解析: ${rep.ks_files} 文件 / ${rep.text_lines} 行文本 → ${rep.lines} 条台词`);
console.log(`   编码 ${Object.keys(rep.encodings).join(',')} · 说话人来源 ${JSON.stringify(rep.speaker_sources)}`
  + ` · 菜单过滤 ${rep.menu_lines} 行`);

// ── B · 内嵌封包（exe 尾部追加 xp3）──────────────────────────────────────
const SIG = Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]);
const decoyLen = 5000;
const indexSize = 16;
const dataLen = 128;

const archive = Buffer.alloc(11 + 8 + dataLen + 2 + indexSize);
SIG.copy(archive, 0);
archive.writeBigUInt64LE(BigInt(11 + 8 + dataLen), 11);           // index_offset
archive.writeUInt16LE(indexSize, 11 + 8 + dataLen);               // u16 index_size
const fakeExe = Buffer.concat([Buffer.alloc(decoyLen, 0x90), archive]);
const exePath = join(tmp, 'fake-game.exe');
writeFileSync(exePath, fakeExe);

const probe = probeEmbeddedXp3(exePath);
assert.ok(probe, '应能探到 exe 尾部的内嵌封包');
assert.equal(probe.offset, decoyLen, '封包起点应为 exe 结束处');
assert.equal(probe.indexSize, indexSize, '索引大小应与写入一致');

const carvedPath = join(tmp, 'carved.xp3');
const c = await carveEmbeddedXp3({ exePath, destPath: carvedPath, offset: probe.offset });
assert.ok(c.ok, `切出应成功: ${c.error}`);
assert.equal(c.bytes, archive.length, '切出的字节数应等于封包长度');
assert.deepEqual(readFileSync(carvedPath), archive, '切出的内容应逐字节相同');

// 签名对但索引不自洽 → 必须拒绝（压缩资源里偶然出现签名时就是这样）
const bogus = Buffer.concat([Buffer.alloc(1000, 0x90), SIG, Buffer.alloc(64, 0xff)]);
const bogusPath = join(tmp, 'bogus.exe');
writeFileSync(bogusPath, bogus);
assert.equal(probeEmbeddedXp3(bogusPath), null, '索引落在文件外时必须拒绝，不能瞎切');

console.log(`✅ 内嵌封包: 偏移 ${probe.offset} / 切出 ${c.bytes} 字节 / 伪签名被拒`);

rmSync(tmp, { recursive: true, force: true });
console.log('\n全部通过');
