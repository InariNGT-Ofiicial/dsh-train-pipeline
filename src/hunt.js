/**
 * 本机素材搜猎：把「机器里到底有没有可用的 galgame」这件事，从人工翻盘变成一次扫描。
 *
 * 目标不是「找到所有 .xp3」（那太容易误报），而是**判断一个目录值不值得解包**：
 *   packed  —— 有 xp3 封包，解出来就有语料
 *   corpus  —— 已经解包过（有 scn/json + voice 音频），可以直接进 train_scan
 *   voice   —— 只有语音目录，能当「整目录=单角色」用
 *
 * 两个提高命中率的技巧：
 *   1. 读 Steam 的 appmanifest_*.acf 里的 name —— 目录名常是 ASCII（"SenrenBanka"），
 *      而用户记得的是中文名/日文名，只靠目录名匹配会漏。acf 里有官方标题。
 *   2. 语音目录用「音频文件数量」而不是「有没有 voice 目录名」来判 ——
 *      不同厂商的叫法五花八门（voice / se / ボイス / sound），数量不会骗人。
 *
 * 硬约束：只读、不跟随符号链接、时间预算到点就停并**如实报告 truncated**，
 * 不允许为了"扫得全"把用户磁盘读半小时。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { join } from './config.js';

const AUDIO_EXT = /\.(ogg|wav|mp3|flac|opus|m4a|wma)$/i;
const ARCHIVE_EXT = /\.(xp3|pfs|arc|pak|bin5)$/i;

/** 绝不进入的目录：系统区、回收站、依赖、缓存。它们是噪声，而且很大。 */
const SKIP = new Set([
  'windows', 'windows.old', '$recycle.bin', 'system volume information', 'recovery',
  'node_modules', '.git', '.svn', 'appdata', '__pycache__', 'site-packages',
  'temp', 'tmp', '.cache', '.npm', '.conda', 'programdata',
  'microsoft', 'windowsapps', 'driverstore', 'winsxs',
]);

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-·・.,()[\]{}]/g, '');

function ls(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function countBy(dir, re, cap = 2000) {
  let n = 0;
  for (const e of ls(dir)) {
    if (n >= cap) break;
    if (e.isFile() && re.test(e.name)) n += 1;
  }
  return n;
}

/** 递归计数（用于 scn 这种多层目录），带 cap 防止大目录拖死 */
function countDeep(dir, re, cap = 2000, depth = 3) {
  let n = 0;
  const walk = (d, lv) => {
    if (lv > depth || n >= cap) return;
    for (const e of ls(d)) {
      if (n >= cap) return;
      if (e.isDirectory()) walk(join(d, e.name), lv + 1);
      else if (re.test(e.name)) n += 1;
    }
  };
  walk(dir, 0);
  return n;
}

/** 读 Steam 库根目录（libraryfolders.vdf 里的 path） */
export function steamLibraries() {
  const vdfRoots = [
    'C:/Program Files (x86)/Steam', 'C:/Program Files/Steam',
    'D:/Steam', 'D:/SteamLibrary', 'E:/Steam', 'E:/SteamLibrary',
  ];
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const v = String(p).replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!v || seen.has(v.toLowerCase())) return;
    if (!isDir(v)) return;
    seen.add(v.toLowerCase());
    out.push(v);
  };
  for (const r of vdfRoots) push(r);
  // vdf 里的其它盘
  for (const r of vdfRoots) {
    const vdf = join(r, 'steamapps/libraryfolders.vdf');
    if (!existsSync(vdf)) continue;
    let text = '';
    try { text = readFileSync(vdf, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) push(m[1]);
  }
  return out;
}

/** 从 appmanifest_*.acf 里读游戏名 + 安装目录，用于「按用户记得的名字」匹配 */
function steamApps(libRoot) {
  const apps = [];
  const sa = join(libRoot, 'steamapps');
  for (const e of ls(sa)) {
    if (!e.isFile() || !/^appmanifest_\d+\.acf$/i.test(e.name)) continue;
    let text = '';
    try { text = readFileSync(join(sa, e.name), 'utf8'); } catch { continue; }
    const pick = (k) => {
      const m = new RegExp(`"${k}"\\s+"([^"]*)"`).exec(text);
      return m ? m[1] : '';
    };
    const name = pick('name');
    const dir = pick('installdir');
    if (!name || !dir) continue;
    const path = join(sa, 'common', dir);
    if (!isDir(path)) continue;
    apps.push({ name, path, appid: (/appmanifest_(\d+)/.exec(e.name) ?? [])[1] ?? '' });
  }
  return apps;
}

/** 判定单个目录是什么（只看这一层 + 一层子目录，够快也够准） */
function classify(dir, depth) {
  const entries = ls(dir);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const archives = files.filter((n) => ARCHIVE_EXT.test(n));
  const xp3 = archives.filter((n) => /\.xp3$/i.test(n));
  const hasStartup = files.some((n) => /^startup\.tjs$/i.test(n));
  const hasGameExe = files.some((n) => /\.exe$/i.test(n));

  // 已经解包的形态：scn 目录里有成规模 JSON + 某处有成规模音频
  //
  // ⚠️ 这里踩过坑：早先把「整目录里任意 .json 的数量」也当作剧本数，结果
  //   D:/WorkData/.../mygo-ost（音乐工程）和 Program Files/ASUS/TX Mascot（工具）
  //   都被判成「已解包 galgame」。普通工程目录里 .json 太多了，这个判据不成立。
  //   现在只认**真正的剧本形态**：.ks / .scn / .psb，或 scn 目录下的 json（PsbDecompile 产物）。
  const scnDir = dirs.find((d) => /^(scn|scene|scenes|script|scripts|text|texts|シナリオ)$/i.test(d));
  const SCRIPT_RE = /\.(ks|scn|psb)$/i;
  const rawScripts = countDeep(dir, SCRIPT_RE, 500, 3);
  const jsonCount = scnDir
    ? countDeep(join(dir, scnDir), /\.(json|ks|scn|psb)$/i, 500)
    : rawScripts;

  const voiceDir = dirs.find((d) => /^(voice|voices|se|sound|audio|ボイス|vox)$/i.test(d));
  const voiceAudio = voiceDir ? countDeep(join(dir, voiceDir), AUDIO_EXT, 500, 2) : 0;

  if (xp3.length && depth <= 6) {
    return {
      kind: 'packed',
      archives,
      engine: hasStartup || xp3.some((n) => /^data\.xp3$/i.test(n)) ? 'kirikiri' : 'unknown',
      detail: `${xp3.length} 个 xp3${hasGameExe ? ' + 游戏 exe' : ''}`,
      voiceDir: voiceDir ? join(dir, voiceDir) : '',
      voiceAudio,
      scnDir: '',
      jsonCount,
    };
  }
  if (jsonCount >= 10 && voiceAudio >= 20) {
    return {
      kind: 'corpus', archives: [], engine: 'kirikiri',
      detail: `已解包：${jsonCount} 个剧本 + ${voiceAudio} 个语音`,
      voiceDir: voiceDir ? join(dir, voiceDir) : '',
      voiceAudio,
      scnDir: scnDir ? join(dir, scnDir) : dir,
      jsonCount,
    };
  }
  if (voiceAudio >= 50) {
    return {
      kind: 'voice', archives: [], engine: 'unknown',
      detail: `只有语音（${voiceAudio}+ 个音频），可当「整目录=单角色」`,
      voiceDir: join(dir, voiceDir), voiceAudio, scnDir: '', jsonCount,
    };
  }
  if (archives.length && !xp3.length) {
    return {
      kind: 'packed-other', archives, engine: 'unknown',
      detail: `非 xp3 封包：${archives.slice(0, 3).join(', ')}`,
      voiceDir: '', voiceAudio: 0, scnDir: '', jsonCount,
    };
  }
  return null;
}

/** 打分：名字命中权重最高，因为用户多半是按名字找的 */
function scoreOf(c, query) {
  let s = 0;
  const q = norm(query);
  const name = norm(basename(c.path));
  if (q) {
    if (name === q) s += 60;
    else if (name.includes(q) || q.includes(name)) s += 45;
    else if (norm(c.steamName).includes(q)) s += 40;
    else if (q.length >= 3 && (name.includes(q.slice(0, 3)) || norm(c.steamName).includes(q.slice(0, 3)))) s += 12;
  }
  if (c.kind === 'corpus') s += 30;
  if (c.kind === 'packed') s += 22;
  if (c.kind === 'voice') s += 14;
  if (c.voiceAudio >= 100) s += 12;
  if (c.jsonCount >= 50) s += 8;
  if (c.steamName) s += 6;
  s += Math.max(0, 6 - c.depth);
  return s;
}

/**
 * 扫描。
 * @param {object} o
 * @param {string} [o.query]        游戏名/角色名（模糊）
 * @param {string[]} [o.roots]      指定扫描根（不传则用默认盘符 + Steam 库）
 * @param {number} [o.timeBudgetMs] 时间预算，到点即停
 */
export async function huntLocal({
  cfg, query = '', roots = null, maxDepth = 5, timeBudgetMs = 25_000, limit = 25,
} = {}) {
  const started = Date.now();
  const deadline = started + Math.max(3000, timeBudgetMs);
  const scanned = { dirs: 0, archives: 0 };
  let truncated = false;

  const steamRoots = steamLibraries().flatMap((lib) => steamApps(lib));
  const steamByPath = new Map(steamRoots.map((a) => [a.path.toLowerCase(), a.name]));

  let scanRoots = roots?.filter(Boolean) ?? [];
  if (!scanRoots.length) {
    scanRoots = [...steamByPath.keys()];
    for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
      const p = `${drive}:/`;
      if (!isDir(p)) continue;
      for (const e of ls(p)) {
        if (!e.isDirectory()) continue;
        const lower = e.name.toLowerCase();
        if (SKIP.has(lower)) continue;
        scanRoots.push(join(p, e.name));
      }
    }
  }

  const found = [];
  const walk = (dir, depth) => {
    if (Date.now() > deadline) { truncated = true; return; }
    if (depth > maxDepth) return;
    scanned.dirs += 1;

    const c = classify(dir, depth);
    if (c) {
      scanned.archives += c.archives.length;
      const steamName = steamByPath.get(dir.toLowerCase()) ?? '';
      const item = {
        path: dir,
        kind: c.kind,
        engine: c.engine,
        name: steamName || basename(dir),
        steamName,
        detail: c.detail,
        depth,
        archives: c.archives.slice(0, 8),
        archiveCount: c.archives.length,
        voiceDir: c.voiceDir,
        voiceAudio: c.voiceAudio,
        scnDir: c.scnDir,
        jsonCount: c.jsonCount,
        source: steamName ? 'steam' : 'disk',
      };
      item.score = scoreOf(item, query);
      found.push(item);
      // 已经识别为 packed/corpus 的目录，不再往里钻（里面全是噪声）
      if (c.kind === 'packed' || c.kind === 'corpus') return;
    }

    for (const e of ls(dir)) {
      if (Date.now() > deadline) { truncated = true; return; }
      if (!e.isDirectory()) continue;
      if (SKIP.has(e.name.toLowerCase())) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };

  for (const r of scanRoots) {
    if (Date.now() > deadline) { truncated = true; break; }
    walk(r, 1);
  }

  const q = norm(query);
  const ranked = found
    .filter((x) => (q ? x.score >= 10 : true))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    query,
    roots: scanRoots.slice(0, 20),
    rootCount: scanRoots.length,
    scanned,
    elapsedMs: Date.now() - started,
    truncated,
    steamLibs: steamLibraries().length,
    steamApps: steamRoots.length,
    candidates: ranked,
    raw: found.length,
  };
}

export function renderHunt(res) {
  if (!res) return '（无结果）';
  const head = `【本机搜猎】${res.query ? `关键词「${res.query}」· ` : ''}`
    + `扫了 ${res.scanned.dirs} 个目录 / ${res.elapsedMs}ms`
    + `${res.truncated ? '（到时间预算上限，未扫全）' : ''}`;
  if (!res.candidates.length) {
    return [
      head,
      '',
      '❌ 没有找到可用的 galgame 目录。',
      `扫描根：${res.roots.slice(0, 6).join(' | ')}${res.rootCount > 6 ? ` …共 ${res.rootCount} 个` : ''}`,
      res.steamApps ? `Steam 库 ${res.steamLibs} 个，已安装游戏 ${res.steamApps} 个` : '未发现 Steam 库',
      '',
      '下一步：用 train_fetch 把素材放进 materials/，或手动指一个路径给 train_unpack。',
    ].join('\n');
  }
  const lines = [head, ''];
  res.candidates.forEach((c, i) => {
    const kindText = { packed: '封包待解', corpus: '已解包', voice: '仅语音', 'packed-other': '非 xp3 封包' }[c.kind] ?? c.kind;
    lines.push(`${i + 1}. [${kindText}] ${c.name}  (分数 ${c.score}${c.source === 'steam' ? ' · Steam' : ''})`);
    lines.push(`   ${c.path}`);
    lines.push(`   ${c.detail}`);
    if (c.archives.length) lines.push(`   封包：${c.archives.join(', ')}${c.archiveCount > c.archives.length ? ` …+${c.archiveCount - c.archives.length}` : ''}`);
    if (c.voiceAudio) lines.push(`   语音：${c.voiceAudio}${c.voiceAudio >= 500 ? '+' : ''} 个${c.scnDir ? ` · 剧本：${c.scnDir}` : ''}`);
  });
  lines.push('', '可直接把第 1 条的 path 交给 train_unpack（若已解包则直接 train_scan）。');
  return lines.join('\n');
}
