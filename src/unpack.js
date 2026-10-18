/**
 * 解包层：把「游戏目录」变成「语音目录 + 剧本 JSON」。
 *
 * 这里的每一条命令行都是**实测**出来的，不是照 README 猜的：
 *
 *   arc_unpacker  v0.11
 *     arc_unpacker.exe --dec=kirikiri/xp3 --plugin=<name> --out=<dir> <file.xp3>
 *     ★ 必须显式给 --plugin：不给会直接报 "No plugin was selected."，
 *       未加密游戏用 noop，XOR 系用 xor / xor-p1-neg / xor-mix。
 *     ★ 参数必须用等号形式（--dec=x）。写成 `-d x` 会被当成输入路径。
 *     ★ 解包结果会**自动多套一层 <封包名>/ 目录**，所以解完必须再定位一次真实根。
 *
 *   PsbDecompile  v4.8
 *     PsbDecompile.exe [-o <dir>] <file.psb> [more.psb ...]
 *     支持一次传多个文件，但 Windows 命令行有 32k 上限，所以按批传。
 *
 *   GARbro —— zip 发行包里**只有 GUI，没有 Console**（Console 工程在源码里，
 *     但没打进 zip；setup.exe 是 NSIS，静默安装要 UAC）。所以它只能被"检测到"，
 *     不能被插件静默装好。需要加密封包时，它是人工兜底。
 */
import {
  existsSync, readdirSync, statSync, openSync, readSync, closeSync, createReadStream, createWriteStream, mkdirSync,
} from 'node:fs';
import { basename } from 'node:path';

import { join } from './config.js';
import { PY_DIR } from './config.js';
import { runOnce } from './execution.js';
import { checkTools, toolsDir } from './toolchain.js';

/** 通用 xp3 插件，按"最可能是未加密"的顺序试 */
export const GENERIC_PLUGINS = ['noop', 'xor', 'xor-p1-neg', 'xor-mix', 'dieselmine'];
const AUDIO_EXT = /\.(ogg|wav|mp3|flac|opus|m4a)$/i;

/** KiriKiri xp3 的 11 字节签名 */
const XP3_SIG = Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]);

function ls(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function countFiles(dir, re = null, depth = 4) {
  let n = 0;
  const walk = (d, lv) => {
    if (lv > depth) return;
    for (const e of ls(d)) {
      if (e.isDirectory()) walk(join(d, e.name), lv + 1);
      else if (!re || re.test(e.name)) n += 1;
    }
  };
  walk(dir, 0);
  return n;
}

/** 找到解包后"真正装着文件"的那一层（arc_unpacker 会多套一层以封包名命名的目录） */
export function findContentRoot(dir) {
  if (!isDir(dir)) return '';
  let best = { path: '', count: countFiles(dir) };
  const walk = (d, lv) => {
    if (lv > 2) return;
    const n = countFiles(d);
    if (n > best.count) best = { path: d, count: n };
    for (const e of ls(d)) if (e.isDirectory()) walk(join(d, e.name), lv + 1);
  };
  walk(dir, 0);
  return best.path || dir;
}

export function scanArchives(dir, maxDepth = 2) {
  const out = [];
  const walk = (d, lv) => {
    if (lv > maxDepth) return;
    for (const e of ls(d)) {
      if (e.isDirectory()) walk(join(d, e.name), lv + 1);
      else if (/\.(xp3|pfs|arc|pak)$/i.test(e.name)) {
        let size = 0;
        try { size += statSync(join(d, e.name)).size; } catch { /* ignore */ }
        out.push({ name: e.name, path: join(d, e.name), size, role: roleOf(e.name) });
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.role - a.role);
}

/** 封包的角色：voice 优先（语料），scn/data 次之（说话人） */
function roleOf(name) {
  const n = name.toLowerCase();
  if (/voice|vox|ボイス/.test(n)) return 3;
  if (/scn|scene|script|text/.test(n)) return 2;
  if (/^data\.xp3$/.test(n)) return 2;
  return 1;
}

/**
 * 探测「数据内嵌在 exe 里」的单文件发行版。
 *
 * 真机上遇到的第一部 galgame（Vector 免费软件 SPARTOI 吉里吉里版）就是这种：
 * 解压出来只有一个 32MB 的 `spartoi.exe` + 一个 plugin/ 目录，**没有任何 .xp3**。
 * 早先的 scanArchives 于是判定「这里没有封包」，整条链在第一步就断了。
 *
 * 实际格式很简单：exe 尾部追加了一段标准 xp3（签名 + u64 index_offset，
 * index_offset 相对于**这段的起点**）。所以只要找到签名、校验索引落在文件内，
 * 就能把这段原样切出来，交给 arc_unpacker 正常解。
 *
 * 校验是必须的：签名可能在压缩资源里偶然出现，光找到签名不算数。
 */
export function probeEmbeddedXp3(exePath, { chunkSize = 8 * 1024 * 1024 } = {}) {
  let fd = -1;
  try {
    const fileSize = statSync(exePath).size;
    if (fileSize < 4096) return null;
    fd = openSync(exePath, 'r');
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = 0;
    while (pos < fileSize) {
      const n = readSync(fd, buf, 0, Math.min(chunkSize, fileSize - pos), pos);
      if (n <= 0) break;
      const win = buf.subarray(0, n);
      let at = win.indexOf(XP3_SIG);
      while (at >= 0) {
        const abs = pos + at;
        // 校验：u64 index_offset 必须落在文件内，且 index_size 也自洽
        if (abs + 27 <= fileSize) {
          const idxOff = Number(win.readBigUInt64LE(at + 11));
          const absIdx = abs + idxOff;
          if (idxOff > 0 && absIdx + 2 <= fileSize) {
            const szBuf = Buffer.allocUnsafe(2);
            readSync(fd, szBuf, 0, 2, absIdx);
            const indexSize = szBuf.readUInt16LE(0);
            const tail = fileSize - absIdx;
            if (indexSize > 0 && 2 + indexSize <= tail) {
              return { offset: abs, fileSize, indexOffset: idxOff, indexSize, carvedBytes: fileSize - abs };
            }
          }
        }
        at = win.indexOf(XP3_SIG, at + 1);
      }
      // 签名可能跨块，回退 11 字节
      pos += Math.max(1, n - (XP3_SIG.length - 1));
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** 把内嵌段原样切到 dest（从 offset 到文件末尾） */
export function carveEmbeddedXp3({ exePath, destPath, offset }) {
  return new Promise((resolve) => {
    try {
      const total = statSync(exePath).size - offset;
      const rs = createReadStream(exePath, { start: offset });
      const ws = createWriteStream(destPath);
      let failed = '';
      rs.on('error', (e) => { failed = String(e?.message ?? e); ws.destroy(); });
      ws.on('error', (e) => { failed = String(e?.message ?? e); rs.destroy(); });
      ws.on('finish', () => {
        let written = 0;
        try { written = statSync(destPath).size; } catch { /* ignore */ }
        resolve(failed || written !== total
          ? { ok: false, error: failed || `写出 ${written} 字节，应为 ${total}` }
          : { ok: true, bytes: written });
      });
      rs.pipe(ws);
    } catch (e) {
      resolve({ ok: false, error: String(e?.message ?? e) });
    }
  });
}

/** 在目录里找「可能是单文件发行版」的 exe（够大才值得扫，扫描要读全文件） */
export function scanExeDistributions(dir, maxDepth = 2, minBytes = 5 * 1024 * 1024) {
  const out = [];
  const walk = (d, lv) => {
    if (lv > maxDepth) return;
    for (const e of ls(d)) {
      if (e.isDirectory()) { walk(join(d, e.name), lv + 1); continue; }
      if (!/\.exe$/i.test(e.name)) continue;
      let size = 0;
      try { size = statSync(join(d, e.name)).size; } catch { continue; }
      if (size >= minBytes) out.push({ name: e.name, path: join(d, e.name), size });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.size - a.size);
}


/** 封包的名称/文件名像不像语音 —— 防止把 bgm/se 一起说成「语音」 */
const VOICEY_RE = /(voice|^v[_\-\d]|_v\d{2,3}$|vox|ボイス)/i;
const NOT_VOICE_RE = /(^|[_\-\s])(bgm|se|snd|sound|eff|effect|sys|click|bomb)/i;

export function looksLikeVoiceFile(name) {
  const base = String(name);
  if (NOT_VOICE_RE.test(base)) return false;
  return VOICEY_RE.test(base);
}

/** 数一个目录下的音频，并分出「像语音的」和「其余（BGM/音效）」 */
export function countAudioDetail(dir, depth = 4) {
  let total = 0;
  let voiceLike = 0;
  const walk = (d, lv) => {
    if (lv > depth) return;
    for (const e of ls(d)) {
      if (e.isDirectory()) { walk(join(d, e.name), lv + 1); continue; }
      if (!AUDIO_EXT.test(e.name)) continue;
      total += 1;
      if (looksLikeVoiceFile(e.name)) voiceLike += 1;
    }
  };
  walk(dir, 0);
  return { total, voiceLike };
}

/** 选哪个解包器：有 CLI 的优先，GUI 只作提示 */
export function pickUnpacker(cfg) {
  const chk = checkTools(cfg);
  const byId = Object.fromEntries(chk.tools.map((t) => [t.id, t]));
  if (byId['arc_unpacker']?.installed) return { tool: 'arc_unpacker', bin: byId['arc_unpacker'].bin, cli: true };
  if (byId.garbro?.installed) return { tool: 'garbro', bin: byId.garbro.bin, cli: byId.garbro.usable };
  return { tool: '', bin: '', cli: false };
}

/**
 * 柚子社 Cxdec 静态解密（py/xp3_yuzu.py）。
 *
 * 为什么值得单独一条路：柚子社的 xp3 索引和内容都过了一遍自定义加密，
 * arc_unpacker 的几个通用插件全打不开。历史上只能靠 KrkrExtract（GUI + 挂游戏
 * 进程），在无头/自动化环境里不可靠。这条路是纯静态的：不跑游戏、不点界面。
 *
 * 它需要一份 GARbro 的 Formats.dat —— 里面存着各代 CxScheme 的 mask/offset/
 * 顺序表/4KB 控制块。这个文件**不进插件**（既不随包分发密钥，也不依赖某台机器
 * 的目录结构），由 DSH_FORMATS_DAT 环境变量或 --formats 指定。
 *
 * ★ 方案不靠猜：py 侧会拿几个本该有已知文件头的条目去试解，解对了才认。
 */
async function tryYuzuUnlock({ cfg, archive, outDir, timeoutMs, log }) {
  const py = cfg.ddspEnv;
  if (!py || !existsSync(py)) {
    return { ok: false, skipped: 'python', error: '没有可用的 Python（柚子社解密脚本要用）' };
  }
  const script = join(PY_DIR, 'xp3_yuzu.py');
  if (!existsSync(script)) return { ok: false, skipped: 'script', error: `脚本缺失: ${script}` };

  const common = ['--archive', archive];
  // cfg.toolsDir 可能为空（工具装在 <songRoot>/tools）—— 用工具链的同一个解析函数
  const td = toolsDir(cfg);
  if (td) common.push('--tools-dir', td);

  log('通用插件都不行 → 试柚子社 Cxdec 静态解密');
  const pr = await runOnce({
    cmd: py, args: [script, 'probe', ...common], timeoutMs: 10 * 60_000,
  });
  const pj = lastJson(pr.stdout);
  if (!pj) {
    return { ok: false, skipped: 'probe', error: `探针无输出: ${(pr.stderr || '').slice(-300)}` };
  }
  if (!pj.ok) {
    return {
      ok: false, skipped: 'unsupported', probe: pj,
      needsFormats: /Formats\.dat/.test(pj.error || ''),
      error: pj.error || '这个封包不是 Cxdec 或参数不全',
    };
  }

  log(`识别为柚子社 Cxdec（${pj.scheme?.mask}/${pj.scheme?.offset}，${pj.scheme_pick || ''}），开始解`);
  const ex = await runOnce({
    cmd: py, args: [script, 'extract', ...common, '--out', outDir], timeoutMs,
  });
  const ej = lastJson(ex.stdout);
  if (!ej || !ej.ok) {
    return {
      ok: false, skipped: 'extract', probe: pj,
      error: `解密解包失败: ${ej?.error || (ex.stderr || '').slice(-300)}`,
    };
  }
  const root = findContentRoot(outDir);
  const files = isDir(root) ? countFiles(root) : 0;
  return {
    ok: files > 0,
    tool: 'yuzu-cxdec',
    plugin: 'cxdec',
    outDir,
    contentRoot: root,
    files,
    audio: countFiles(root, AUDIO_EXT),
    extracted: ej.extracted,
    failed: ej.failed,
    scheme: pj.scheme,
    probe: pj,
    detail: `${basename(archive)} → ${files} 个文件（柚子社 Cxdec 静态解密）`,
  };
}

/** 取 stdout 里最后一个 JSON 行 */
function lastJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* 继续往前找 */ }
  }
  return null;
}

/**
 * 解一个封包。
 * 多个插件依次尝试，**以"真的落了文件"为成功判据**，不看退出码。
 */
export async function extractArchive({
  cfg, archive, outDir, plugin = '', plugins = [], timeoutMs = 30 * 60_000, log = () => {},
}) {
  const pick = pickUnpacker(cfg);
  if (!pick.tool) {
    return {
      ok: false, stage: 'tool',
      error: '没有可用的命令行解包器：train_toolchain action=install id=arc_unpacker',
    };
  }
  if (pick.tool === 'garbro' && !pick.cli) {
    return {
      ok: false, stage: 'tool', gui: true,
      error: '只检测到 GARbro GUI（zip 发行版没有 Console）。需要人工解包，或用 KrkrExtract。',
      bin: pick.bin,
    };
  }

  const tries = [];
  const list = plugin ? [plugin] : (plugins.length ? plugins : GENERIC_PLUGINS);

  for (const p of list) {
    const target = list.length > 1 ? join(outDir, `try-${p}`) : outDir;
    const args = pick.tool === 'arc_unpacker'
      ? [`--dec=kirikiri/xp3`, `--plugin=${p}`, `--out=${target}`, '--no-color', archive]
      : ['x', '-o', target, archive];   // GARbro Console 语法（若用户自己装了）
    log(`解包 ${basename(archive)} ← 插件 ${p}`);
    const r = await runOnce({
      cmd: pick.bin, args, cwd: cfg.toolsDir || undefined, timeoutMs,
    });
    const root = findContentRoot(target);
    const files = isDir(root) ? countFiles(root) : 0;
    tries.push({ plugin: p, files, exitCode: r.exitCode, stderrTail: (r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' / ') });
    if (files > 0) {
      return {
        ok: true, tool: pick.tool, plugin: p, outDir: target, contentRoot: root,
        files, audio: countFiles(root, AUDIO_EXT), tries,
        detail: `${basename(archive)} → ${files} 个文件（插件 ${p}）`,
      };
    }
  }

  // ④ 通用插件全灭 → 柚子社 Cxdec（纯静态，不需要游戏进程）
  const yz = await tryYuzuUnlock({ cfg, archive, outDir, timeoutMs, log });
  if (yz.ok) return { ...yz, tries };

  return {
    ok: false, stage: 'extract', tries,
    yuzu: yz,
    error: `试了 ${list.length} 个插件都没解出文件`
      + (yz.error ? `；柚子社解密也没成（${yz.error}）` : '')
      + ' —— 大概率是加密封包，需要该游戏的专用插件/密钥，或改用 KrkrExtract 人工解',
    hint: yz.needsFormats
      ? '这套 Cxdec 需要一份 GARbro 的 Formats.dat：设 DSH_FORMATS_DAT=<.../GameData/Formats.dat> 再试'
      : '加密封包的 key 通常写在游戏 exe 或 startup.tjs 里；KrkrExtract 能以游戏 exe 为入口自动取 key',
  };
}

/**
 * 反编译 .psb/.scn → JSON。
 * 没有这一步，解出来的剧本只是二进制，拿不到 speaker 字段。
 */
export async function decompileScn({ cfg, scnDir, outDir = '', timeoutMs = 30 * 60_000, limit = 0, log = () => {} }) {
  const chk = checkTools(cfg);
  const fm = chk.tools.find((t) => t.id === 'freemote');
  if (!fm?.installed) {
    return { ok: false, stage: 'tool', error: 'FreeMote 未安装：train_toolchain action=install id=freemote' };
  }
  if (!isDir(scnDir)) return { ok: false, stage: 'input', error: `剧本目录不存在: ${scnDir}` };

  const targets = [];
  const walk = (d, lv) => {
    if (lv > 4) return;
    for (const e of ls(d)) {
      if (e.isDirectory()) walk(join(d, e.name), lv + 1);
      else if (/\.(psb|scn)$/i.test(e.name)) targets.push(join(d, e.name));
    }
  };
  walk(scnDir, 0);
  if (!targets.length) {
    // KAG3 的 .ks 本来就是明文，没有"反编译"这一步 —— 报错只会误导人去装 FreeMote
    const ks = countFiles(scnDir, /\.ks$/i);
    if (ks > 0) {
      return { ok: true, converted: 0, alreadyText: ks, detail: `无需反编译：${ks} 个 .ks 是明文剧本（KAG3）` };
    }
    // 已经是 JSON 了就不必反编译
    const jsons = countFiles(scnDir, /\.json$/i);
    return jsons > 0
      ? { ok: true, converted: 0, alreadyJson: jsons, detail: `无需反编译：已有 ${jsons} 个 JSON` }
      : { ok: false, stage: 'input', error: '目录里既没有 .psb/.scn，也没有 .json' };
  }

  const todo = limit > 0 ? targets.slice(0, limit) : targets;
  const batches = [];
  for (let i = 0; i < todo.length; i += 120) batches.push(todo.slice(i, i + 120));

  let failed = 0;
  let lastErr = '';
  for (const batch of batches) {
    const args = [...(outDir ? ['-o', outDir] : []), ...batch];
    log(`反编译 ${batch.length} 个剧本文件…`);
    const r = await runOnce({ cmd: fm.bin, args, cwd: scnDir, timeoutMs });
    if (!r.ok) {
      failed += batch.length;
      lastErr = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-3).join(' / ');
    }
  }

  // 产物自证：以 JSON 文件数说话
  const roots = [scnDir, outDir].filter((p) => p && isDir(p));
  const jsonCount = Math.max(0, ...roots.map((r) => countFiles(r, /\.json$/i)));
  return {
    ok: jsonCount > 0,
    converted: todo.length - failed,
    failed,
    jsonCount,
    scnDir,
    outDir: outDir || scnDir,
    detail: jsonCount > 0
      ? `反编译完成：${todo.length - failed}/${todo.length}，目录内 JSON 共 ${jsonCount} 个`
      : `反编译没有产出 JSON：${lastErr || 'PsbDecompile 无输出'}`,
    stderr: failed ? lastErr : '',
  };
}

/**
 * 一次解包一个游戏（含多封包 + 反编译）。
 * 只做「解」这一件事，不碰数据集 —— 切分与清洗在 build 阶段。
 */
export async function unpackGame({
  cfg, input, outDir, plugins = [], only = [], limit = 0, decompile = true, log = () => {},
}) {
  if (!isDir(input)) return { ok: false, stage: 'input', error: `目录不存在: ${input}` };
  let archives = scanArchives(input);

  // 单文件发行版：没有 .xp3，数据追加在 exe 尾部 —— 切出来再按普通封包解
  const embedded = [];
  if (!archives.length) {
    for (const exe of scanExeDistributions(input).slice(0, 4)) {
      const probe = probeEmbeddedXp3(exe.path);
      if (!probe) continue;
      mkdirSync(join(outDir, '_embedded'), { recursive: true });
      const carved = join(outDir, '_embedded', `${basename(exe.name).replace(/\.exe$/i, '')}.xp3`);
      log(`${exe.name} 里发现内嵌封包（偏移 ${probe.offset}，${(probe.carvedBytes / 1024 ** 2).toFixed(1)}MB），切出来`);
      const c = await carveEmbeddedXp3({ exePath: exe.path, destPath: carved, offset: probe.offset });
      if (!c.ok) { embedded.push({ exe: exe.name, ok: false, error: c.error }); continue; }
      embedded.push({ exe: exe.name, ok: true, offset: probe.offset, bytes: c.bytes, carved });
      archives.push({ name: `${basename(exe.name)}#embedded`, path: carved, size: c.bytes, role: 2 });
    }
  }

  if (!archives.length) {
    const jsons = countFiles(input, /\.(json|ks|psb)$/i, 3);
    const audio = countFiles(input, AUDIO_EXT, 3);
    return {
      ok: jsons > 0 || audio > 0, stage: 'detect', alreadyUnpacked: true, embedded,
      error: jsons || audio ? '' : '这里没有 xp3/pfs，没有内嵌封包的 exe，也没有已解包的内容',
      detail: jsons || audio ? '看起来已经解包过，跳过解包直接进 train_scan 即可' : '',
      scnDir: jsons ? input : '', voiceDir: audio ? input : '',
    };
  }

  const wanted = only.length ? archives.filter((a) => only.some((o) => a.name.toLowerCase().includes(o.toLowerCase()))) : archives;
  if (!wanted.length) {
    return {
      ok: false, stage: 'detect',
      error: `没有名字包含 ${only.join(' / ')} 的封包；实际有: ${archives.map((a) => a.name).join(', ')}`,
    };
  }
  const results = [];
  const roots = [];
  for (const a of wanted) {
    const r = await extractArchive({
      cfg, archive: a.path, outDir: join(outDir, a.name.replace(/\.[^.]+$/, '')), plugins, log,
    });
    results.push({ archive: a.name, ...r });
    if (r.ok) roots.push(r.contentRoot);
    // 一个成功就够继续；但 voice 与 scn 是两个封包，都要试
  }
  const anyOk = results.some((r) => r.ok);

  // 定位语音目录与剧本目录（老游戏的剧本是明文 .ks，新一些的是 .psb/.scn）
  const SCRIPT_RE = /\.(psb|scn|ks)$/i;
  const voiceDir = roots.find((r) => countFiles(r, AUDIO_EXT) > 0) || '';
  let scnDir = roots.find((r) => countFiles(r, SCRIPT_RE) > 0) || roots[0] || '';

  let decompiled = null;
  if (decompile && scnDir && existsSync(scnDir)) {
    decompiled = await decompileScn({ cfg, scnDir, limit, log });
    if (decompiled.ok) scnDir = decompiled.outDir;
  }

  const scriptFiles = scnDir ? countFiles(scnDir, new RegExp(`(?:${SCRIPT_RE.source}|\\.json)$`, 'i')) : 0;
  const audioDetail = voiceDir ? countAudioDetail(voiceDir) : { total: 0, voiceLike: 0 };
  return {
    ok: anyOk,
    outDir,
    embedded,
    archives: results.map((r) => ({
      archive: r.archive, ok: !!r.ok, files: r.files ?? 0, plugin: r.plugin ?? '',
      error: r.error ?? '', tries: r.tries ?? [],
    })),
    voiceDir: voiceDir || '',
    scnDir: scnDir || '',
    audioFiles: audioDetail.total,
    voiceLikeFiles: audioDetail.voiceLike,
    jsonFiles: scriptFiles,
    scriptFiles,
    decompiled,
    detail: anyOk
      ? `解出 ${results.filter((r) => r.ok).length}/${results.length} 个封包`
        + `${embedded.length ? `（含 ${embedded.filter((x) => x.ok).length} 个从 exe 内嵌段切出）` : ''}`
        + `；语音 ${voiceDir ? countFiles(voiceDir, AUDIO_EXT) : 0} 个，剧本 ${scriptFiles} 个`
      : '所有封包都没解开',
  };
}
