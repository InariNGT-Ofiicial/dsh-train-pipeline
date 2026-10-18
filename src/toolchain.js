/**
 * 工具链：解包工具的「体检 / 自动获取 / 可用性判定」。
 *
 * ⚠️ 这张表里的结论**全部来自实测**，不是照 README 抄的：
 *
 *   arc_unpacker —— 官方 zip 里就是 arc_unpacker.exe，独立的 C++ 程序，无运行时依赖。
 *                  唯一坑：xp3 必须显式 --plugin（不给就报 "No plugin was selected."）。
 *                  ⇒ **能无人值守**，是插件的默认解包器。
 *
 *   FreeMote     —— zip 里 PsbDecompile.exe 在根目录，.NET 自包含。⇒ 能无人值守。
 *
 *   GARbro       —— v1.4.x 的 zip 里**只有 GARbro.GUI.exe，没有 Console**（实测 49 个文件）。
 *                  Console 工程在源码里，但没打进 zip；1.5.x 只发 setup.exe / rar。
 *                  ⇒ 只能当**人工兜底**：装好 GUI 后用鼠标解，或解压 zip 手动跑。
 *
 *   KrkrExtract  —— 只有 GUI 主程序 + Core.dll，加密封包专用，必须指定游戏 exe。
 *                  ⇒ 也是**人工兜底**，插件只负责把它准备好并指路。
 *
 * 因此 "installed" 与 "usable" 是两个不同的判断：装上 ≠ 插件能用。
 * 这个区分是刻意的 —— 否则会给出"工具就绪"的假象，然后在解包时莫名其妙失败。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { join, readJson } from './config.js';
import { download, findFile, fmtBytes, githubReleases, unzip } from './net.js';

export const TOOLCHAIN = [
  {
    id: 'arc_unpacker',
    name: 'arc_unpacker',
    repo: 'vn-tools/arc_unpacker',
    role: '命令行解包器（xp3 等 266 种封包），无人值守',
    why: '官方 zip 就是单 exe，无运行时依赖；xp3 需指定 --plugin',
    kind: 'zip',
    assetRe: /arc_unpacker.*\.zip$/i,
    binRe: /^arc_unpacker\.exe$/i,
    cli: true,
    installMode: 'auto',
    needs: '无',
    homepage: 'https://github.com/vn-tools/arc_unpacker',
  },
  {
    id: 'freemote',
    name: 'FreeMote Toolkit',
    repo: 'UlyssesWu/FreeMote',
    role: 'PsbDecompile：.psb/.scn → JSON（说话人字段的来源）',
    why: '没有它，解出来的剧本是二进制 PSB，拿不到 speaker',
    kind: 'zip',
    assetRe: /FreeMoteToolkit.*\.zip$/i,
    binRe: /^PsbDecompile\.exe$/i,
    cli: true,
    installMode: 'auto',
    needs: '.NET（发行版自包含）',
    homepage: 'https://github.com/UlyssesWu/FreeMote',
  },
  {
    id: 'garbro',
    name: 'GARbro',
    repo: 'morkt/GARbro',
    role: '图形界面解包器（格式覆盖最广，只能人工点）',
    why: 'zip 发行版只有 GUI，Console 版没打进包 —— 这是实测结论',
    kind: 'zip',
    assetRe: /GARbro.*\.zip$/i,
    binRe: /^GARbro\.(Console|GUI)\.exe$/i,
    cli: false,
    installMode: 'auto',
    needs: '.NET Framework 4.x',
    homepage: 'https://github.com/morkt/GARbro',
    note: '装上后需人工用 GUI 解包；插件不会去点鼠标',
  },
  {
    id: 'krkrextract',
    name: 'KrkrExtract',
    repo: 'xmoezzz/KrkrExtract',
    role: '加密封包专用（GUI，必须以游戏 exe 为入口）',
    why: '商业游戏的私有密钥只有它能取，arc_unpacker 解不开时就靠它',
    kind: 'files',
    assetRe: /^KrkrExtract.*\.(exe|dll)$/i,
    binRe: /^KrkrExtract.*\.exe$/i,
    cli: false,
    installMode: 'auto',
    needs: 'GUI',
    homepage: 'https://github.com/xmoezzz/KrkrExtract',
    note: '加密封包的最后手段：把游戏 exe 拖给它启动',
  },
];

export function toolsDir(cfg) {
  return cfg.toolsDir || join(cfg.songRoot || '', 'tools');
}

export function getTool(id) {
  return TOOLCHAIN.find((t) => t.id === id) || null;
}

function manifestPath(cfg) {
  return join(toolsDir(cfg), 'manifest.json');
}

export function readManifest(cfg) {
  const m = readJson(manifestPath(cfg));
  return m && typeof m === 'object' ? m : {};
}

function writeManifest(cfg, id, entry) {
  const all = { ...readManifest(cfg), [id]: entry };
  try {
    mkdirSync(toolsDir(cfg), { recursive: true });
    writeFileSync(manifestPath(cfg), JSON.stringify(all, null, 2), 'utf8');
  } catch { /* 记不上不影响使用 */ }
  return all;
}

/** .NET Framework 4.x 是否在位（GARbro 是 .NET 程序，缺了会静默起不来） */
export function dotnetOk() {
  let best = 0;
  try {
    for (const d of readdirSync('C:/Windows/Microsoft.NET/Framework64')) {
      const m = /^v4\.(\d+)\.(\d+)$/.exec(d);
      if (m) best = Math.max(best, Number(m[1]));
    }
  } catch { /* 目录不存在 = 没装 */ }
  return { ok: best > 0, version: best ? `4.${best}` : '' };
}

/** 在 PATH 里找同名 exe（用户可能自己全局装过） */
function onPath(re) {
  const dirs = String(process.env.PATH || '').split(';').filter(Boolean);
  for (const d of dirs) {
    let entries;
    try { entries = readdirSync(d); } catch { continue; }
    const hit = entries.find((n) => re.test(n));
    if (hit) return join(d.replace(/\\/g, '/'), hit);
  }
  return '';
}

/**
 * 体检。三个状态必须分清：
 *   installed  文件在
 *   usable     插件能无人值守调用（cli === true）
 *   manual     文件在但只能人用（GUI 类）
 */
export function checkTools(cfg) {
  const root = toolsDir(cfg);
  const manifest = readManifest(cfg);
  const rows = TOOLCHAIN.map((t) => {
    const dir = join(root, t.id);
    const bin = findFile(dir, t.binRe) || onPath(t.binRe);
    const man = manifest[t.id] ?? null;
    let sizeText = '';
    try { if (bin) sizeText = fmtBytes(statSync(bin).size); } catch { /* ignore */ }
    const installed = !!bin;
    const usable = installed && t.cli;
    return {
      id: t.id, name: t.name, role: t.role, why: t.why, homepage: t.homepage,
      needs: t.needs, cli: t.cli, dir, bin, installed, usable,
      manual: installed && !t.cli,
      version: man?.version ?? '',
      installedAt: man?.at ?? '',
      sizeText,
      note: installed
        ? (t.cli ? (t.note ?? '') : (t.note ?? '只有 GUI，需要人工操作'))
        : `未安装 → train_toolchain action=install id=${t.id}`,
    };
  });
  return {
    root,
    dotnet: dotnetOk(),
    tools: rows,
    ready: rows.filter((r) => r.usable).length,
    can: {
      // 「现在能不能真的跑一次解包」——只看 CLI 工具
      unpack: rows.find((r) => r.id === 'arc_unpacker')?.usable === true,
      decompile: rows.find((r) => r.id === 'freemote')?.usable === true,
    },
  };
}

function pickRelease(releases, assetRe) {
  const ordered = [...releases.filter((r) => !r.prerelease), ...releases.filter((r) => r.prerelease)];
  for (const rel of ordered) {
    const assets = rel.assets.filter((a) => assetRe.test(a.name));
    if (assets.length) return { rel, assets };
  }
  return null;
}

/**
 * 安装一个工具。
 * 失败必须说清卡在哪：查发布 / 没有合适资产 / 下载 / 解压 / 解压后找不到 exe。
 */
export async function installTool({ cfg, id, proxy = '', force = false }) {
  const t = getTool(id);
  if (!t) return { ok: false, error: `未知工具: ${id}（可选 ${TOOLCHAIN.map((x) => x.id).join(' / ')}）` };

  const root = toolsDir(cfg);
  const targetDir = join(root, t.id);
  const cacheDir = join(root, '_cache');
  const before = checkTools(cfg).tools.find((r) => r.id === id);
  if (before?.installed && !force) {
    return { ok: true, skipped: true, tool: before, detail: `${t.name} 已在位（${before.version || '本机已有'}），无需重装` };
  }

  const rel = await githubReleases({ repo: t.repo, proxy, limit: 15 });
  if (!rel.ok) {
    return { ok: false, id, stage: 'release', error: `查不到 ${t.repo} 的发布：${rel.error}`, manual: t.homepage };
  }
  const picked = pickRelease(rel.releases, t.assetRe);
  if (!picked) {
    return {
      ok: false, id, stage: 'asset',
      error: `${t.repo} 的 ${rel.releases.length} 个发布里没有匹配 ${t.assetRe} 的资产 —— 需要人工下载`,
      assetsSeen: rel.releases.slice(0, 3).flatMap((r) => r.assets.map((a) => a.name)).slice(0, 12),
      manual: t.homepage,
    };
  }

  mkdirSync(cacheDir, { recursive: true });
  const fetched = [];
  let primaryName = '';
  for (const a of picked.assets) {
    const dest = join(cacheDir, a.name);
    const r = await download({ url: a.url, dest, maxBytes: 512 * 1024 ** 2, proxy });
    if (!r.ok) return { ok: false, id, stage: 'download', error: `下载 ${a.name} 失败：${r.error}`, dest };
    fetched.push({ name: a.name, size: r.sizeBytes, sizeText: r.sizeText, sha256: r.sha256 });
    if (!primaryName) primaryName = a.name;
  }

  if (t.kind === 'zip') {
    const tmp = join(cacheDir, `_unzip_${id}`);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    const uz = await unzip({ zipPath: join(cacheDir, primaryName), destDir: tmp });
    if (!uz.ok) return { ok: false, id, stage: 'unzip', error: uz.error };
    try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(targetDir, { recursive: true });
    for (const e of readdirSync(tmp)) {
      try { renameSync(join(tmp, e), join(targetDir, e)); } catch { /* 占用/跨盘时跳过，下面自证会发现 */ }
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    mkdirSync(targetDir, { recursive: true });
    for (const a of picked.assets) {
      if (existsSync(join(cacheDir, a.name))) {
        try { renameSync(join(cacheDir, a.name), join(targetDir, a.name)); } catch { /* ignore */ }
      }
    }
  }

  // 产物自证：解压成功 ≠ 能用
  const bin = findFile(targetDir, t.binRe);
  if (!bin) {
    let top = [];
    try { top = readdirSync(targetDir).slice(0, 15); } catch { /* ignore */ }
    return {
      ok: false, id, stage: 'verify',
      error: `包已解压到 ${targetDir}，但里面没有 ${t.binRe} —— 包结构与预期不符`,
      sawTopLevel: top,
    };
  }

  writeManifest(cfg, id, {
    version: picked.rel.tag,
    asset: primaryName,
    assets: fetched,
    source: picked.rel.htmlUrl,
    at: new Date().toISOString(),
    // 只记「走没走代理」，不记代理地址 —— 产物要能跟着插件走，不能带某台机器的网络配置
    viaProxy: fetched.some((f) => f.proxyMode === 'proxy'),
    bin,
  });

  const after = checkTools(cfg).tools.find((r) => r.id === id);
  return {
    ok: true, id, tool: after, stage: 'done',
    detail: `${t.name} ${picked.rel.tag} 已就位：${bin}${t.cli ? '' : '（仅 GUI，需人工操作）'}`,
  };
}

export function renderToolchain(res) {
  if (res?.error && !res?.tools) return `❌ ${res.error}`;
  const dotnet = res.dotnet?.ok ? `.NET ${res.dotnet.version} ✅` : '.NET 4.x 未检出（GARbro 用得到）';
  const lines = [
    `【解包工具链】${res.root}`,
    `${dotnet} · 插件可自动调用 ${res.ready}/${res.tools.length}`,
    `可解包 ${res.can.unpack ? '✅' : '❌'} · 可反编译剧本 ${res.can.decompile ? '✅' : '❌'}`,
    '',
  ];
  for (const t of res.tools) {
    const icon = t.usable ? '✅' : t.manual ? '🖱️' : '⭕';
    lines.push(`${icon} ${t.name}${t.version ? ` ${t.version}` : ''} — ${t.role}`);
    if (t.installed) lines.push(`   ${t.bin}${t.sizeText ? ` · ${t.sizeText}` : ''}`);
    if (t.note) lines.push(`   ${t.note}`);
  }
  lines.push('', '✅=插件可自动调用  🖱️=装好了但只能人工点  ⭕=未安装');
  return lines.join('\n');
}
