/**
 * dsh-train-pipeline —— 语音数据集构建 + DDSP 训练的 DSH 插件。
 *
 * Cordis 插件契约（与 dsh-cover-pipeline 同构，实证可用）：
 *   export const name   = '<插件 id>'
 *   export const inject = ['tools']
 *   export async function apply(ctx, config)
 *   tools.register({ name, description, parameters, output, execute })
 *
 * 与翻唱插件的关系：
 *   翻唱插件靠「03_xxx/<音色>_步数N/exp/reflow-test/model_N.pt」发现音色。
 *   本插件的 train_register 就产这个结构 —— 于是「训练 → 翻唱」闭环。
 */
import {
  existsSync, mkdirSync, readdirSync, writeFileSync, copyFileSync, renameSync, statSync,
} from 'node:fs';

import { basename, dirname, isAbsolute } from 'node:path';

import {
  resolveConfig, join, workspace, LOCAL_CONFIG, PY_DIR, listVoices, findVoice, readJson,
  toPosixPath, isDir,
} from './config.js';
import { runOnce, spawnJob, pythonEnv, artifactsOk, tailFile, parseProgress, scanCheckpoints, cmdlineOf } from './execution.js';
import { doctor, renderDoctor } from './checks.js';
import { STAGES, FLOW, DECISIONS, WORKFLOW_RULES, SOURCE_TYPES } from './stages.js';
import { listAdapters, getAdapter, detectAdapter } from './sources/index.js';
import { huntLocal, renderHunt } from './hunt.js';
import { checkTools, installTool, renderToolchain, TOOLCHAIN } from './toolchain.js';
import { download, unzip, recordProvenance } from './net.js';
import { unpackGame } from './unpack.js';

export const name = 'train-pipeline';
export const inject = ['tools'];

// ───────────────────────────────────────────────────────────────────────────
// 通用
// ───────────────────────────────────────────────────────────────────────────

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    rendered: { type: 'string' },
    stage: { type: 'string' },
  },
  required: ['ok', 'rendered'],
};

/**
 * 统一包装：Cordis 的 output 形状是 { schema, render }，不是裸 schema。
 * render 收到的 execute 返回值只要带 rendered 就能出文本。
 */
const wrap = (run) => ({
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, v) => [{ type: 'text', text: String(v?.rendered ?? '(无输出)') }],
  },
  execute: async (args = {}, ...rest) => {
    try { return await run(args, ...rest); }
    catch (error) {
      return { ok: false, error: String(error?.message ?? error),
        rendered: `❌ 操作失败: ${error?.message ?? error}` };
    }
  },
});

/** 从混合输出里取最后一段合法 JSON（脚本可能先打印日志） */
function lastJson(text) {
  if (!text) return null;
  const t = String(text).trim();
  try { return JSON.parse(t); } catch { /* 继续 */ }
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* 继续 */ }
  }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch { /* ignore */ }
  }
  return null;
}

function countWav(dir, depth = 2) {
  let n = 0;
  const walk = (d, lv) => {
    if (lv > depth) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(d, e.name), lv + 1);
      else if (/\.wav$/i.test(e.name)) n += 1;
    }
  };
  walk(dir, 0);
  return n;
}

function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

/**
 * 复制 wav 树。
 * 不用 fs.cpSync：它在「dest 已存在」时是合并还是套一层子目录，语义容易踩坑；
 * 而这里一旦合并出错，就会把上一个角色的残留混进训练集 —— 那是必须杜绝的事故。
 */
function copyWavTree(src, dest, depth = 0) {
  if (depth > 3) return 0;
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    if (e.isDirectory()) { n += copyWavTree(s, join(dest, e.name), depth + 1); continue; }
    if (!/\.wav$/i.test(e.name)) continue;
    let name = e.name;
    let t = join(dest, name);
    let i = 1;
    while (existsSync(t)) {
      name = e.name.replace(/\.wav$/i, '__' + i + '.wav');
      t = join(dest, name);
      i += 1;
    }
    copyFileSync(s, t);
    n += 1;
  }
  return n;
}

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length <= n ? t : `…\n${t.slice(-n)}`;
};

const durationLabel = (row) => row.durationComplete && Number.isFinite(row.durationSeconds)
  ? `实测 ${(row.durationSeconds / 60).toFixed(2)} 分钟`
  : row.estMinutes != null ? `按句数估计 ${row.estMinutes} 分钟（未实测）` : '时长未知';

/** 构造适配器运行上下文 */
function makeCtx(cfg) {
  const ws = workspace(cfg);
  const py = cfg.ddspEnv;
  return {
    cfg,
    ws,
    python: py,
    /** 跑 py/ 下的脚本 */
    async runPy(script, args, opts = {}) {
      if (!py || !existsSync(py)) {
        return { ok: false, stderr: `Python 不可用: ${py || '(未配置)'}，先跑 train_doctor`, exitCode: null, cmdline: '' };
      }
      const cmdArgs = [join(PY_DIR, script), ...args];
      const r = await runOnce({
        cmd: py,
        args: cmdArgs,
        cwd: opts.cwd ?? (cfg.ddspDir && existsSync(cfg.ddspDir) ? cfg.ddspDir : PY_DIR),
        env: pythonEnv(cfg.ddspDir, py),
        timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
      });
      return { ...r, cmdline: cmdlineOf(py, cmdArgs) };
    },
    /** 跑 DDSP 工程里的脚本（相对 ddspDir） */
    async runDdsp(script, args, opts = {}) {
      if (!cfg.ddspDir || !existsSync(cfg.ddspDir)) {
        return { ok: false, stderr: `DDSP 工程不存在: ${cfg.ddspDir || '(未配置)'}`, exitCode: null, cmdline: '' };
      }
      const r = await runOnce({
        cmd: py,
        args: [script, ...args],
        cwd: cfg.ddspDir,
        env: pythonEnv(cfg.ddspDir, py),
        timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
      });
      return { ...r, cmdline: cmdlineOf(py, [script, ...args]) };
    },
    lastJson,
  };
}

function ensurePython(cfg) {
  if (!cfg.ddspEnv || !existsSync(cfg.ddspEnv)) {
    return `Python 不可用（${cfg.ddspEnv || '未配置'}）。先跑 train_doctor / train_setup。`;
  }
  return '';
}

// ───────────────────────────────────────────────────────────────────────────
// 插件主体
// ───────────────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const logger = ctx.logger ?? console;
  const cfg = resolveConfig(config);
  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    logger.warn('[train-pipeline] tools 服务不可用，插件未注册任何工具');
    return;
  }

  const register = (def) => tools.register(def);

  // ── 0 · 源清单 ────────────────────────────────────────────────────────
  register({
    name: 'train_sources',
    description:
      '列出可用的素材源适配器及其**实现状态**：galgame 解包（旗舰，已实现）与 番剧/录屏/合集（接口已留，认人与分离未实现）。'
      + '开始任何抓取前先看这个，避免对未实现的路线抱幻想。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    ...wrap(async () => {
      const rows = listAdapters();
      const lines = ['【素材源】'];
      for (const r of rows) {
        lines.push(`${r.flagship ? '★' : ' '} ${r.id} · ${r.name}`);
        lines.push(`   已实现: ${r.implemented.join(', ') || '无'}`);
        if (r.pending.length) lines.push(`   未实现: ${r.pending.join(', ')}`);
        lines.push(`   为什么: ${r.why}`);
        lines.push(`   需要: ${r.need}`);
      }
      lines.push('', '★ galgame 解包是唯一能做到「角色归属零人工」的源，其余都是在猜。');
      return { ok: true, stage: 'sources', sources: rows, rendered: lines.join('\n') };
    }),
  });

  // ── 1 · 环境体检 ──────────────────────────────────────────────────────
  register({
    name: 'train_doctor',
    description:
      '训练环境体检：DDSP 工程与 6 个脚本、两套权重（HiFiGAN/ContentVec）、Python 与 CUDA、训练配置（duration/采样率/expdir）、'
      + 'ffmpeg、磁盘余量、音色库、解包工具链。★ 任何训练前先跑；每个失败项都带修复办法。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    ...wrap(async () => {
      const res = await doctor(cfg);
      const rendered = renderDoctor(res);
      logger.info(`[train-pipeline] doctor ok=${res.ok} errors=${res.errors.length}`);
      return {
        ok: res.ok, stage: 'doctor',
        errorCount: res.errors.length, warningCount: res.warnings.length,
        checks: res.checks, rendered,
      };
    }),
  });

  // ── 2 · 一句话接入 ────────────────────────────────────────────────────
  register({
    name: 'train_setup',
    description:
      '自动发现 DDSP 工程 / Python / 音色库 / ffmpeg，输出可直接粘的配置片段；writeConfig=true 时写 train.local.json'
      + '（git 忽略，优先级最高，**下次加载 DSH 生效**）。',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '音频工程根目录（省略使用 DSH_COVER_ROOT 或当前目录）' },
        ddspDir: { type: 'string', description: '手动指定 DDSP 工程目录（含 train_reflow.py）' },
        role: { type: 'string', description: '准备训练的角色名（仅回显，便于生成提示）' },
        writeConfig: { type: 'boolean', description: '写入 train.local.json（默认 false）' },
      },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const next = resolveConfig({
        ...cfg,
        ...(args.root ? { songRoot: args.root } : {}),
        ...(args.ddspDir ? { ddspDir: args.ddspDir } : {}),
      });
      const keys = ['songRoot', 'trainRoot', 'voiceLibDir', 'ddspDir', 'ddspEnv', 'ffmpeg',
        'configName', 'expName', 'minSec', 'maxSec', 'targetHours', 'sampleRate'];
      const yaml = (v) => (typeof v === 'number' ? String(v) : `'${String(v ?? '').replace(/'/g, "''")}'`);
      const patch = ['config:', ...keys.map((k) => `  ${k}: ${yaml(next[k])}`)].join('\n');

      const missing = [];
      if (!next.ddspDir || !existsSync(next.ddspDir)) missing.push(`DDSP 工程: ${next.ddspDir || '(空)'}`);
      if (!next.ddspEnv || !existsSync(next.ddspEnv)) missing.push(`Python: ${next.ddspEnv || '(空)'}`);
      if (!next.configPath || !existsSync(next.configPath)) missing.push(`训练配置: ${next.configPath || '(空)'}`);

      let wrote = '';
      if (args.writeConfig === true) {
        const out = {};
        for (const k of [...keys, 'configPath', 'expDir', 'trainAudioDir', 'valAudioDir']) {
          out[k] = next[k] ?? '';
        }
        writeFileSync(LOCAL_CONFIG, JSON.stringify(out, null, 2), 'utf8');
        wrote = LOCAL_CONFIG;
      }

      const lines = [
        `【接入｜${next.songRoot || '(未发现根目录)'}】`,
        `DDSP 工程: ${next.ddspDir || '(未发现)'}`,
        `Python:    ${next.ddspEnv || '(未发现)'}`,
        `训练配置:  ${next.configPath || '(未发现)'}`,
        `工作区:    ${next.trainRoot}`,
        `音色库:    ${next.voiceLibDir || '(未发现)'} → ${next.voices.length} 个权重`,
        '',
        missing.length ? '── 还缺 ──' : '── 依赖齐全 ──',
        ...missing.map((m) => `  ❌ ${m}`),
        '',
        '配置片段（粘到 profile 的 cordis.patch.yml 的 train-pipeline.config 下）：',
        patch,
        wrote ? `\n已写入: ${wrote}\n★ 需重启 DSH 或重新加载插件才生效。` : '\n（只读模式；落盘请加 writeConfig=true）',
        '',
        '下一步: train_doctor → train_scan（galgame 目录）→ train_build',
      ];
      return { ok: missing.length === 0, stage: 'setup', missing, patch, wrote, rendered: lines.join('\n') };
    }),
  });

  // ── 2.5 · 素材获取（找 → 装 → 拿 → 拆）────────────────────────────────
  //
  // 这一段是「插件替 agent 打开的手」：以前 agent 只能等用户手动解包，
  // 现在它可以自己在本机找、自己把工具装好、自己下载、自己解包。
  //
  // 边界是刻意画的：**插件不内置任何资源站爬虫**。素材要由 agent 用搜索找到链接，
  // 或由用户给出链接，再由 train_fetch 落地并留下可复核的凭据（URL + sha256 + 时间）。

  register({
    name: 'train_hunt',
    description:
      '在本机搜索可用的 galgame 素材：扫盘符 + Steam 库（含 appmanifest 里的官方游戏名），'
      + '判断每个目录是「有 xp3 待解包 / 已解包 / 只有语音」，并给候选打分。只读，不移动任何文件。'
      + '★ 用户说「我电脑里有这个游戏」时先跑这个，别让他手动翻目录。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '游戏名/角色名关键词（中/日/英皆可，模糊匹配）' },
        roots: { type: 'array', items: { type: 'string' }, description: '只在这些目录下找（绝对路径）' },
        maxDepth: { type: 'number', description: '最大递归深度，默认 5' },
        timeBudgetSec: { type: 'number', description: '时间预算（秒），默认 25；到点即停并如实标记未扫全' },
        limit: { type: 'number', description: '最多返回几个候选，默认 25' },
      },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const res = await huntLocal({
        cfg,
        query: args.query ?? '',
        roots: args.roots ?? null,
        maxDepth: Number(args.maxDepth) || 5,
        timeBudgetMs: (Number(args.timeBudgetSec) || 25) * 1000,
        limit: Number(args.limit) || 25,
      });
      return {
        ok: res.candidates.length > 0, stage: 'hunt',
        candidates: res.candidates, scanned: res.scanned,
        truncated: res.truncated, elapsedMs: res.elapsedMs,
        rendered: renderHunt(res),
      };
    }),
  });

  register({
    name: 'train_toolchain',
    description:
      '解包工具链的体检与自动获取。check 看现状；install 从 GitHub 官方 release 下载并解压到 tools/ 后自证 exe 存在。'
      + '★ 注意区分「装上了」和「插件能自动调用」：arc_unpacker / FreeMote 可无人值守，'
      + 'GARbro / KrkrExtract 只有 GUI，装好也要人点。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['check', 'install'], description: '默认 check' },
        id: { type: 'string', description: '只处理某个工具（arc_unpacker/freemote/garbro/krkrextract）' },
        force: { type: 'boolean', description: '已安装也重装' },
        proxy: { type: 'string', description: '临时指定代理；不填则用配置 proxy，再退到 HTTPS_PROXY 环境变量' },
      },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const action = args.action ?? 'check';
      if (action === 'check') {
        const res = checkTools(cfg);
        return {
          ok: res.can.unpack, stage: 'toolchain',
          root: res.root, dotnet: res.dotnet, tools: res.tools, can: res.can,
          rendered: renderToolchain(res),
        };
      }
      // install：默认只装「插件能自动调用」的那两个；GUI 类必须点名
      const targets = args.id ? [args.id] : TOOLCHAIN.filter((t) => t.cli).map((t) => t.id);
      const lines = [`【安装工具链｜${targets.join(', ')}】`];
      let allOk = true;
      for (const id of targets) {
        lines.push('', `── ${id} ──`);
        const r = await installTool({ cfg, id, proxy: args.proxy || cfg.proxy || '', force: !!args.force });
        if (r.skipped) { lines.push(`✅ ${r.detail}`); continue; }
        if (!r.ok) {
          allOk = false;
          lines.push(`❌ 卡在「${r.stage}」: ${r.error}`);
          if (r.sawTopLevel?.length) lines.push(`   解压后顶层: ${r.sawTopLevel.join(', ')}`);
          if (r.manual) lines.push(`   人工地址: ${r.manual}`);
          continue;
        }
        lines.push(`✅ ${r.detail}`);
      }
      const after = checkTools(cfg);
      lines.push('', renderToolchain(after));
      return {
        ok: allOk && after.can.unpack, stage: 'toolchain.install',
        tools: after.tools, can: after.can,
        rendered: lines.join('\n'),
      };
    }),
  });

  register({
    name: 'train_fetch',
    description:
      '把网络上的文件下到训练工作区（materials/），带大小上限、断点续传、sha256 校验与 provenance 记录，可顺带解压。'
      + '★ 只下载你/agent 明确给出的 URL —— 插件不内置任何资源站搜索引擎；'
      + '素材合法性由调用方负责（自己持有的游戏、官方工具、公共领域资源）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '直链（http/https）' },
        dest: { type: 'string', description: '保存目录；相对路径落在 materials/ 下' },
        filename: { type: 'string', description: '另存文件名（默认取 URL 末段）' },
        extract: { type: 'boolean', description: '下载后若是 zip 就解压到同名目录' },
        maxMB: { type: 'number', description: '大小上限，默认 2048' },
        sha256: { type: 'string', description: '期望摘要，不符即判失败' },
        attest: {
          type: 'string',
          enum: ['user-owned', 'official-tool', 'freeware', 'public-domain', 'unspecified'],
          description: '来源性质，写进 provenance。freeware=免费分发但仍有版权（如 Vector 免费软件库）；'
            + 'public-domain=无版权。unspecified 且超过 500MB 需 allowUnverified=true',
        },
        allowUnverified: { type: 'boolean', description: '明确承担「来源未注明」的风险' },
        headers: {
          type: 'object',
          description: '附加请求头（如 GitHub API 取裸字节要 {"Accept":"application/vnd.github.raw"}，私有源要 Authorization）',
        },
        proxy: { type: 'string', description: '临时代理' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const ws = workspace(cfg);
      const destDir = args.dest
        ? (isAbsolute(args.dest) ? args.dest : join(ws.base, 'materials', args.dest))
        : join(ws.base, 'materials');
      const name = args.filename || decodeURIComponent((args.url.split('/').pop() || '').split('?')[0]) || 'download.bin';
      const dest = join(destDir, name);
      const maxBytes = (Number(args.maxMB) || 2048) * 1024 * 1024;
      const attest = args.attest ?? 'unspecified';

      if (attest === 'unspecified' && maxBytes > 500 * 1024 * 1024 && args.allowUnverified !== true) {
        return {
          ok: false, stage: 'fetch',
          rendered: `⚠️ 未注明来源的 ${(maxBytes / 1024 ** 2).toFixed(0)}MB 级别下载被拦下。\n`
            + '如果确认是自有素材/官方资源/免费软件，请带 attest（user-owned/official-tool/freeware/public-domain）或 allowUnverified=true 重试。',
        };
      }

      const r = await download({
        url: args.url, dest, maxBytes, sha256: args.sha256 ?? '',
        proxy: args.proxy || cfg.proxy || '', resume: true,
        headers: args.headers ?? {},
      });
      const lines = [`【取材】${name}`];
      if (!r.ok) {
        lines.push(`❌ ${r.error}`, `   目标: ${dest}`);
        if (r.httpCode) lines.push(`   HTTP ${r.httpCode}`);
        if (r.proxyMode === 'direct-fallback') {
          lines.push(`   ⚠️ 配置的代理 ${r.proxyConfigured} 连不上，本次是直连失败的`);
        }
        return { ok: false, stage: 'fetch', error: r.error, dest, rendered: lines.join('\n') };
      }

      // 真实踩过的坑：GitHub API 的 contents 接口不带 Accept 会返回 JSON 元数据（还 200），
      // 存下来是个假封包，解包时才炸。这里当场拦下，别让它进流水线。
      if (/json|text\/html|text\/plain/i.test(r.contentType || '') && /\.(xp3|zip|rar|7z|ogg|wav|flac|psb)$/i.test(name)) {
        lines.push(
          `⚠️ 内容类型是 ${r.contentType}，但文件名是 ${name} —— 多半拿到的是 API 元数据/错误页，不是文件本体。`,
          '   GitHub 上取裸字节请加 headers={"Accept":"application/vnd.github.raw"}，或改用 releases 的直链。',
        );
        return { ok: false, stage: 'fetch', dest, contentType: r.contentType, rendered: lines.join('\n') };
      }
      lines.push(`✅ ${r.sizeText} · ${r.speedKbps} KB/s · sha256 ${String(r.sha256).slice(0, 16)}…`, `   ${dest}`);
      if (r.proxyMode === 'direct-fallback') {
        lines.push(`   ⚠️ 配置的代理 ${r.proxyConfigured} 连不上，本次已自动改为直连（不是站点的问题）`);
      }
      if (r.cached) lines.push('   ♻️ 本地已有完整副本，未重复下载');

      let unzipped = null;
      if (args.extract && /\.zip$/i.test(name)) {
        unzipped = join(destDir, name.replace(/\.zip$/i, ''));
        const uz = await unzip({ zipPath: dest, destDir: unzipped });
        lines.push(uz.ok ? `📦 已解压 → ${unzipped}` : `⚠️ 解压失败: ${uz.error}`);
      }

      recordProvenance(join(destDir, '_provenance.json'), {
        file: name, url: args.url, sizeBytes: r.sizeBytes, sha256: r.sha256, attest,
        unzipped: unzipped && existsSync(unzipped) ? unzipped : '',
      });
      lines.push('已写入 provenance: ' + join(destDir, '_provenance.json'));

      return {
        ok: true, stage: 'fetch', dest, unzipped: unzipped ?? '',
        sizeBytes: r.sizeBytes, sha256: r.sha256, rendered: lines.join('\n'),
      };
    }),
  });

  register({
    name: 'train_unpack',
    description:
      '解包 + 反编译：xp3 → 语音文件与剧本，.psb/.scn → JSON（说话人字段就在这里）。'
      + '自动按 voice/scn 角色挑封包，按 noop→xor→… 顺序试插件，以「真落了文件」为成功判据；'
      + '加密封包解不开时如实说明并指向 KrkrExtract（GUI）。',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '游戏根目录（含 xp3）' },
        outDir: { type: 'string', description: '解到哪（默认 <工作区>/corpus/<目录名>-unpacked）' },
        only: { type: 'array', items: { type: 'string' }, description: '只解名字含这些词的封包，如 ["voice","scn"]' },
        plugin: { type: 'string', description: '直接指定 xp3 插件（跳过探测），如 noop/xor/某游戏专用名' },
        plugins: { type: 'array', items: { type: 'string' }, description: '自定义探测顺序' },
        decompile: { type: 'boolean', description: '解完是否反编译剧本，默认 true' },
        limit: { type: 'number', description: '最多反编译多少个剧本文件（0=全部）' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const ws = workspace(cfg);
      const chk = checkTools(cfg);
      if (!chk.can.unpack) {
        return {
          ok: false, stage: 'toolchain',
          rendered: '❌ 还没有可用的命令行解包器。先跑 train_toolchain action=install（会装 arc_unpacker + FreeMote）。',
        };
      }
      const outDir = args.outDir || join(ws.corpus, `${basename(args.input)}-unpacked`);
      const r = await unpackGame({
        cfg, input: args.input, outDir,
        only: args.only ?? [], plugin: args.plugin ?? '', plugins: args.plugins ?? [],
        limit: Number(args.limit) || 0, decompile: args.decompile !== false,
      });

      const lines = [`【解包】${args.input}`, `输出: ${outDir}`, ''];
      if (r.alreadyUnpacked) {
        lines.push(`ℹ️ ${r.detail}`);
      } else {
        for (const e of r.embedded ?? []) {
          lines.push(e.ok
            ? `🧩 ${e.exe} 尾部有内嵌封包（偏移 ${e.offset}，${(e.bytes / 1024 ** 2).toFixed(1)}MB）→ 已切出`
            : `⚠️ ${e.exe} 的内嵌封包切出失败: ${e.error}`);
        }
        for (const a of r.archives ?? []) {
          lines.push(`${a.ok ? '✅' : '❌'} ${a.archive}${a.ok ? ` · ${a.files} 文件 · 插件 ${a.plugin}` : ''}`);
          if (!a.ok) {
            lines.push(`   ${a.error}`);
            for (const t of a.tries ?? []) lines.push(`   试过 ${t.plugin}: ${t.files} 文件`);
          }
        }
      }
      if (r.voiceDir) {
        lines.push('', `音频目录: ${r.voiceDir}（${r.audioFiles} 个音频`
          + `${r.audioFiles ? `，其中名字像语音的 ${r.voiceLikeFiles ?? 0} 个` : ''}）`);
        if (r.audioFiles > 0 && !(r.voiceLikeFiles > 0)) {
          lines.push('   ⚠️ 一个都不像语音 —— 这个封包里多半只有 BGM/音效');
        }
      }
      if (r.scnDir) lines.push(`剧本目录: ${r.scnDir}（${r.scriptFiles ?? r.jsonFiles ?? 0} 个剧本文件）`);
      if (r.decompiled && !r.decompiled.ok) lines.push(`⚠️ 反编译: ${r.decompiled.error ?? r.decompiled.detail}`);
      if (r.decompiled?.ok) lines.push(`反编译: ${r.decompiled.detail}`);

      if (!r.ok) {
        lines.push('', '── 没解开怎么办 ──',
          '1) 若提示「需要专用插件/密钥」：这是加密封包，arc_unpacker 的通用插件打不开；',
          '2) 装 KrkrExtract（train_toolchain action=install id=krkrextract），用它以**游戏 exe** 为入口解；',
          '3) 解完把产物目录交给 train_scan 即可，后续全自动。');
        return { ok: false, stage: 'unpack', archives: r.archives, rendered: lines.join('\n') };
      }

      lines.push('', '下一步: train_scan（input 指向剧本目录或语音目录）');
      return {
        ok: true, stage: 'unpack',
        outDir, voiceDir: r.voiceDir ?? '', scnDir: r.scnDir ?? '',
        archives: r.archives ?? [], decompiled: r.decompiled ?? null,
        rendered: lines.join('\n'),
      };
    }),
  });

  register({
    name: 'train_acquire',
    description:
      '一条命令跑完「找素材 → 备工具 → 解包 → 反编译 → 角色盘点」：'
      + '给 input 就直接解，不给就用 query 在本机搜（含 Steam）。'
      + '★ 这是 agent 自主取材的主入口；缺工具会自动装，解不开会明确告诉你卡在哪一步。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '游戏名（本机搜索用）' },
        input: { type: 'string', description: '已知的游戏目录（跳过搜索）' },
        role: { type: 'string', description: '想训的角色名（仅用于在结果里标注命中情况）' },
        noInstall: { type: 'boolean', description: '不要自动安装工具' },
        spriteSpeakers: { type: 'boolean', description: '盘点时用立绘文件名推测说话人（仅诊断，别据此建集）' },
        only: { type: 'array', items: { type: 'string' },
          description: '只解名字含这些词的封包（如 ["data"] 跳过几百 MB 的 video.xp3）' },
        timeBudgetSec: { type: 'number', description: '搜索时间预算，默认 20 秒' },
      },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const ws = workspace(cfg);
      const lines = ['【自主取材】'];
      let target = args.input || '';

      if (!target) {
        if (!args.query) {
          return { ok: false, stage: 'acquire', rendered: '❌ 需要 query（游戏名）或 input（目录）之一。' };
        }
        lines.push(`① 本机搜索「${args.query}」…`);
        const h = await huntLocal({ cfg, query: args.query, timeBudgetMs: (Number(args.timeBudgetSec) || 20) * 1000 });
        if (!h.candidates.length) {
          lines.push(`❌ 本机没找到（扫了 ${h.scanned.dirs} 个目录${h.truncated ? '，到时间预算上限' : ''}）。`,
            '',
            '下一步两条路：',
            '  A. 用户手上有这份素材 → 让他给出路径，再调 train_acquire input=<路径>',
            '  B. 需要从网上取 → 用搜索找到**合法来源**的直链后，train_fetch url=<直链> extract=true，',
            '     再把解出的目录交给本工具。插件本身不内置资源站搜索。');
          return { ok: false, stage: 'hunt', rendered: lines.join('\n') };
        }
        const top = h.candidates[0];
        target = top.path;
        lines.push(`   命中: ${top.name} (${top.kind}, 分数 ${top.score}) → ${top.path}`);
      } else {
        lines.push(`① 指定目录: ${target}`);
      }

      // ② 已解包素材不要求安装封包工具。
      const detected = await getAdapter('galgame').detect(makeCtx(cfg), { input: target });
      const alreadyExtracted = ['voice-multi', 'voice-only', 'scn'].includes(detected.kind);
      let chk = checkTools(cfg);
      if (!alreadyExtracted && (!chk.can.unpack || !chk.can.decompile) && args.noInstall !== true) {
        lines.push('② 工具链不全，自动安装…');
        for (const id of TOOLCHAIN.filter((t) => t.cli).map((t) => t.id)) {
          const need = id === 'arc_unpacker' ? !chk.can.unpack : !chk.can.decompile;
          if (!need) continue;
          const r = await installTool({ cfg, id, proxy: cfg.proxy || '' });
          lines.push(`   ${r.ok ? '✅' : '❌'} ${id}: ${r.ok ? (r.detail ?? '已就位') : `${r.stage} — ${r.error}`}`);
        }
        chk = checkTools(cfg);
      } else {
        lines.push(`② 工具链: 解包 ${chk.can.unpack ? '✅' : '❌'} · 反编译 ${chk.can.decompile ? '✅' : '❌'}`);
      }
      if (!chk.can.unpack && !alreadyExtracted) {
        lines.push('', '❌ 没有可用解包器，流程停在此。可人工用 GARbro/KrkrExtract 解包后把目录交给 train_scan。');
        return { ok: false, stage: 'toolchain', rendered: lines.join('\n') };
      }

      // ③ 解包（若已是解包目录，unpackGame 会自己跳过）
      const outDir = join(ws.corpus, `${basename(target)}-unpacked`);
      lines.push('③ 解包与反编译…');
      const up = await unpackGame({
        cfg, input: target, outDir, only: args.only ?? [], log: (m) => lines.push(`   ${m}`),
      });
      if (!up.ok) {
        lines.push(`   ❌ ${up.detail || '失败'}`);
        for (const a of up.archives ?? []) if (!a.ok) lines.push(`   · ${a.archive}: ${a.error}`);
        lines.push('', '加密封包需要 KrkrExtract（GUI，以游戏 exe 启动）。解完再跑 train_scan。');
        return { ok: false, stage: 'unpack', archives: up.archives ?? [], rendered: lines.join('\n') };
      }
      lines.push(`   ✅ ${up.detail}`);

      // ④ 角色盘点
      const scanInput = up.scnDir || up.voiceDir || target;
      lines.push(`④ 盘点角色（${scanInput}）…`);
      const c = makeCtx(cfg);
      const picked = await detectAdapter(c, scanInput);
      if (!picked.adapter) {
        lines.push(`   ⚠️ 没有适配器能接: ${scanInput}`);
        return { ok: false, stage: 'scan', voiceDir: up.voiceDir, scnDir: up.scnDir, rendered: lines.join('\n') };
      }
      // 已解包的目录里，voiceDir 常常就是根目录本身；这时交给适配器自己猜 voice/ 子目录，
      // 硬把根目录当语音目录会一个也匹配不上。
      const voiceHint = up.voiceDir && up.voiceDir !== scanInput ? up.voiceDir : undefined;
      const sc = await picked.adapter.scan(c, {
        input: scanInput, voiceDir: voiceHint, spriteSpeakers: args.spriteSpeakers === true,
      });
      if (sc.speakers?.length) {
        lines.push('', '── 角色盘点（带语音句数）──');
        for (const s of sc.speakers.slice(0, 15)) {
          const tag = s.source === 'sprite' ? ' ·立绘推测' : (s.source === 'inline' ? ' ·「」写法' : '');
          lines.push(`  ${s.speaker}${tag}: ${s.with_voice} 句 / ${durationLabel(s)}`);
        }
        if (args.role) {
          const hit = sc.speakers.find((s) => s.speaker.includes(args.role) || args.role.includes(s.speaker));
          lines.push('', hit
            ? `🎯 目标角色「${args.role}」命中: ${hit.with_voice} 句 / ${durationLabel(hit)}`
            : `⚠️ 角色列表里没有「${args.role}」—— 名字可能不同，或这个封包里没有她的语音`);
        }
        if (!(sc.withVoice > 0)) {
          lines.push('',
            '⛔ 这个源**没有任何一句带语音引用** —— 拿它训不出音色。',
            '   免费同人游戏整部没有配音很常见，这不是参数问题，只能换源。');
          return {
            ok: false, stage: 'acquire', reason: 'no-voice',
            input: target, outDir, voiceDir: up.voiceDir ?? '', scnDir: up.scnDir ?? '',
            speakers: sc.speakers ?? [], linesPath: sc.linesPath ?? '',
            rendered: lines.join('\n'),
          };
        }
        lines.push('', '下一步: train_build speakers=["角色名"] → train_qc → train_preprocess → train_run');
      } else {
        lines.push(`   ⚠️ ${sc.detail ?? '没抽到角色'}`);
      }

      return {
        ok: (sc.withVoice ?? 0) > 0, stage: 'acquire',
        input: target, outDir, voiceDir: up.voiceDir ?? '', scnDir: up.scnDir ?? '',
        speakers: sc.speakers ?? [], linesPath: sc.linesPath ?? '',
        rendered: lines.join('\n'),
      };
    }),
  });

  // ── 3 · 计划 ──────────────────────────────────────────────────────────
  register({
    name: 'train_plan',
    description:
      '把「训某个角色的声音」变成可执行计划：八段流程（S0–S7）、五个必须量而不能猜的决策点、六条流程红线、'
      + '以及**动手前必须先问用户的问题**。它不会替你猜角色和时长。',
    parameters: {
      type: 'object',
      properties: { goal: { type: 'string', description: '自然语言需求，如「用《千恋万花》里芳乃的声音训一个模型」' } },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const lines = [
        `【训练计划】${args.goal ? `目标: ${args.goal}` : ''}`,
        `流程: ${FLOW}`,
        '',
        '── 八段 ──',
        ...STAGES.map((s) => `${s.id} ${s.name}: ${s.does}${s.gate ? `\n     门: ${s.gate}` : ''}`),
        '',
        '── 必须量、不许猜（D1–D5）──',
        ...DECISIONS.map((d) => `${d.id} ${d.q}\n    为什么: ${d.why}\n    怎么量: ${d.how}`),
        '',
        '── 红线 ──',
        ...WORKFLOW_RULES.map((r) => `  · ${r}`),
        '',
        '── 动手前必须向用户确认 ──',
        '  1) 训哪个角色（说名字，不要「主角」这种指代）',
        '  2) 素材在哪：本机有游戏？→ train_hunt 自己找；只有封包？→ train_unpack 自己解；',
        '     需要从网上下？→ 先让用户给出**合法来源**的直链，再 train_fetch',
        '  3) 素材大概多长？<10 分钟就明说「可能不够」，别硬训',
        '  4) 训练完成后是否直接注册进翻唱音色库（影响能否立刻翻唱）',
        '',
        '源能力:',
        ...SOURCE_TYPES.map((s) => `  ${s.flagship ? '★' : ' '} ${s.id}: ${s.why}`),
      ];
      return { ok: true, stage: 'plan', stages: STAGES, decisions: DECISIONS, rendered: lines.join('\n') };
    }),
  });

  // ── 4 · 扫描源头（旗舰入口）────────────────────────────────────────────
  register({
    name: 'train_scan',
    description:
      '扫描素材源并盘点角色：自动判断是「游戏本体(有xp3)/已解包剧本(scn json)/只有语音目录」，'
      + '对 galgame 解析出每个角色多少句、多少句带语音、语音命中率与预估时长。'
      + '产出 lines.jsonl 供 train_build 使用。★ 旗舰路线的入口。',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '游戏根目录 / 解包产物目录 / 语音目录的绝对路径' },
        voiceDir: { type: 'string', description: '可选：解包出来的语音目录（不填则自动猜 voice/ 子目录）' },
        source: { type: 'string', description: '可选：强制指定适配器（galgame / media），默认自动' },
        spriteSpeakers: {
          type: 'boolean',
          description: '无 [name] 标签的剧本，用立绘文件名推测说话人。只能当参考：'
            + '真机实测会混进 CG 文件名（p17nomal / s12speak 之类），不要据此建训练集',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const c = makeCtx(cfg);
      const picked = args.source ? { adapter: getAdapter(args.source), result: null, tried: [] } : await detectAdapter(c, args.input);
      const adapter = picked.adapter;
      if (!adapter) {
        return {
          ok: false, stage: 'scan',
          rendered: `❌ 没有适配器能接这个路径: ${args.input}\n尝试过: ${picked.tried.map((t) => `${t.id}(${t.detail})`).join(' / ')}`,
        };
      }
      const r = await adapter.scan(c, {
        input: args.input, voiceDir: args.voiceDir, spriteSpeakers: args.spriteSpeakers === true,
      });
      const lines = [`【扫描｜${adapter.name}】${args.input}`];
      if (r.kind) lines.push(`识别为: ${r.kind} — ${r.detail ?? ''}`);

      if (r.kind === 'packed-exe') {
        lines.push('', '★ 这是**单文件发行版**（数据追加在 exe 尾部，没有独立 .xp3）：');
        lines.push(`   exe: ${(r.exe ?? []).join(', ')}`);
        lines.push('   直接调 train_unpack —— 会自动把内嵌封包切出来再解，不需要人工');
        return { ok: false, stage: 'scan', needUnpack: true, rendered: lines.join('\n') };
      }

      if (r.kind === 'packed' && r.unpackGuide) {
        lines.push('', '★ 这是**未解包**的游戏目录，先解包：');
        lines.push(`   直接调 train_unpack input="${args.input}"（自动装工具 → 解封包 → 反编译剧本）`);
        lines.push('   或者一条命令到位: train_acquire input="' + args.input + '"');
        lines.push('');
        lines.push('   解不开（加密封包）时的人工路径：');
        r.unpackGuide.steps.slice(1).forEach((s) => lines.push(`   ${s}`));
        lines.push(`   提示: ${r.unpackGuide.hint}`);
        if (r.unpackGuide.xp3?.length) lines.push(`   封包: ${r.unpackGuide.xp3.join(', ')}`);
        return { ok: false, stage: 'scan', needUnpack: true, guide: r.unpackGuide, rendered: lines.join('\n') };
      }

      if (r.speakers?.length) {
        const srcTag = (s) => ({ tag: '', inline: ' ·「」写法', sprite: ' ·立绘推测' }[s.source] ?? (s.source ? ` ·${s.source}` : ''));
        lines.push('', '── 角色盘点（按带语音句数排序）──');
        lines.push('  角色名\t句数\t带语音\t时长与测量方式');
        for (const s of r.speakers.slice(0, 30)) {
          lines.push(`  ${s.speaker}${srcTag(s)}\t${s.lines ?? '-'}\t${s.with_voice}\t${durationLabel(s)}`);
          if (s.durationError || s.failedFiles) lines.push(`    ⚠️ ${s.durationError || `${s.failedFiles} 个文件探测失败`}（不按字节数估时）`);
        }
        if (r.speakers.length > 30) lines.push(`  … 另有 ${r.speakers.length - 30} 个`);
        if (r.voiceHit) {
          lines.push('', `语音命中率: ${r.voiceHit.matched}/${r.voiceHit.checked}`
            + (r.voiceHit.missing_samples?.length ? `（未命中示例: ${r.voiceHit.missing_samples.slice(0, 3).join(', ')}）` : ''));
        }
      }
      if (r.kind === 'voice-only') lines.push(`${r.voiceFiles} 个音频 / ${durationLabel(r)}`);
      if (r.durationError) lines.push(`⚠️ ${r.durationError}`);
      if (r.ksFiles) {
        lines.push('', `剧本: ${r.ksFiles} 个 .ks（KAG3 明文）· 编码 ${Object.keys(r.encodings ?? {}).join('/') || '?'}`
          + ` · ${r.textLines ?? 0} 行文本 · playse 音效引用 ${r.soundRefs ?? 0} 处`);
      }
      const srcBreak = r.speakerSources ?? {};
      if (Object.keys(srcBreak).length) {
        const label = { tag: '剧本[name]标注', inline: '「名前「台词」」写法', sprite: '立绘文件名推测' };
        lines.push(`说话人来源: ${Object.entries(srcBreak).map(([k, v]) => `${label[k] ?? k} ${v}`).join(' · ')}`);
      }
      if ((r.lines > 0 || r.textLines > 0) && !r.withVoice) {
        lines.push('',
          '⚠️ 剧本读到了文本，但没有一句带语音引用。',
          '   常见原因：这个源本身没配音（免费同人游戏很常见）、语音命令名不在候选集内、或语音封包没解出来。',
          '   没有语音就没有训练语料 —— 换一个有配音的源，不要在这里硬往下走。');
      }
      if (r.voiceHit && (r.voiceHit.checked ?? 0) > 0 && (r.voiceHit.matched ?? 0) === 0) {
        lines.push('',
          '⚠️ 语音命中率 0：台词一条也没对上音频。这不是"少"，是"对不上"。',
          '   常见原因：',
          '   · 剧本格式不同（柚子社的 .scn 是命令数组 PSB，不是 KAG 的 [name]/[voice] 写法）',
          '   · 语音文件名与剧本里的引用规则不同（例如只写了角色代号）',
          '   若有解包产物 voice/<角色>/*.ogg 这种分角色目录，直接 '
          + 'train_scan input=<那个 voice 目录> 更可靠 —— 目录名就是角色名。');
      }
      if (r.linesPath && r.ok) {
        mkdirSync(c.ws.corpus, { recursive: true });
        writeFileSync(join(c.ws.corpus, '_latest.json'),
          JSON.stringify({ linesPath: r.linesPath, voiceDir: r.voiceDir ?? '', input: args.input, at: Date.now() }, null, 2));
        lines.push('', `台词清单: ${r.linesPath}`);
      }
      lines.push('', r.ok
        ? '下一步: train_build（用 --speakers 指定角色）'
        : '这条源到此为止：没有「说话人 + 语音」成对的台词，出不了数据集。');

      return {
        ok: !!r.ok, stage: 'scan', kind: r.kind, speakers: r.speakers ?? [],
        voiceFiles: r.voiceFiles, withVoice: r.withVoice,
        durationSeconds: r.durationSeconds, durationComplete: r.durationComplete,
        durationError: r.durationError, failedFiles: r.failedFiles,
        linesPath: r.linesPath ?? '', voiceDir: r.voiceDir ?? '', rendered: lines.join('\n'),
      };
    }),
  });

  // ── 5 · 出数据集 ──────────────────────────────────────────────────────
  register({
    name: 'train_build',
    description:
      '把扫描结果变成 DDSP 能吃的数据集：按角色挑句 → 匹配音频 → 重采样 44.1k/单声道/裁静音 → '
      + '超长按能量谷切分 → 落 dataset_raw/<角色>。规格由训练配置强制（minSec/maxSec/sampleRate）。',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '与 train_scan 相同的源路径' },
        speakers: { type: 'array', items: { type: 'string' }, description: '角色名数组；["all"] = 全部有语音的角色' },
        voiceDir: { type: 'string', description: '语音目录（可省略，从上次 scan 或自动猜）' },
        minSec: { type: 'number', description: '片段下限秒（默认取配置）' },
        maxSec: { type: 'number', description: '片段上限秒（默认取配置）' },
        limit: { type: 'integer', description: '每角色最多处理多少条（试跑用）' },
      },
      required: ['input', 'speakers'],
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const c = makeCtx(cfg);
      const bad = ensurePython(cfg);
      if (bad) return { ok: false, stage: 'build', rendered: `❌ ${bad}` };

      const latest = readJson(join(c.ws.corpus, '_latest.json')) ?? {};
      const same = latest.input === args.input ? latest : {};
      const voiceDir = args.voiceDir || same.voiceDir || '';

      const picked = await detectAdapter(c, args.input);
      if (!picked.adapter) {
        return { ok: false, stage: 'build', rendered: `❌ 无法识别源: ${args.input}` };
      }
      const det = picked.result ?? {};
      if (det.kind === 'packed') {
        return { ok: false, stage: 'build', rendered: '❌ 还没解包。先按 train_scan 给出的步骤解包。' };
      }

      // ★ minSec 默认 3.0 是按「歌曲干音」定的；galgame 台词普遍只有 2-3 秒，
      //   用 3.0 会把一半以上当成"过短"丢掉（实测千恋万花芳乃：895 个语音只出 411 段，54% 被丢）。
      //   台词类源自动降到 1.5s；用户显式传 minSec 或把配置改成非默认值时，以用户为准。
      const minSecAuto = /^galgame/i.test(picked.adapter.name) && args.minSec === undefined && cfg.minSec === 3.0 ? 1.5 : null;
      const effMinSec = args.minSec ?? minSecAuto ?? cfg.minSec;

      const r = await picked.adapter.build(c, {
        input: args.input,
        linesPath: det.kind === 'voice-only' ? '' : (same.linesPath || ''),
        voiceDir,
        speakers: args.speakers,
        minSec: effMinSec,
        maxSec: args.maxSec ?? cfg.maxSec,
        sampleRate: cfg.sampleRate,
        limit: args.limit ?? 0,
      });

      const lines = [`【出料｜${picked.adapter.name}】`];
      if (minSecAuto !== null) {
        lines.push(`ℹ️ 片段下限 3.0s → ${minSecAuto}s（台词普遍 2-3 秒，3.0 会丢掉一半以上；要改传 minSec）`);
      }
      if (!r.ok) {
        lines.push(`❌ ${r.detail ?? '失败'}`);
        if (r.stderr) lines.push(`stderr: ${clip(r.stderr, 900)}`);
        return { ok: false, stage: 'build', rendered: lines.join('\n') };
      }
      lines.push(`✅ ${r.detail}`);
      for (const d of r.datasets ?? []) {
        lines.push(`  ${d.speaker}: ${d.built} 段 / ${d.minutes} 分钟`);
        lines.push(`    缺音频 ${d.skipped_missing} · 过短 ${d.skipped_short} · 失败 ${d.skipped_error}`);
        if (d.errors?.length) lines.push(`    ${d.errors.slice(0, 3).join(' | ')}`);
        lines.push(`    ${d.out_dir}`);
      }
      lines.push('', '下一步: train_qc（不过质量门不要进训练）');
      // ★ 把「实际用的阈值」记下来给 train_qc 继承。不记的话，build 用 1.5s 产出、
      //   qc 用配置里的 3.0s 判废，两边打架，合格数原地不动（实测踩过）。
      try {
        mkdirSync(c.ws.datasets, { recursive: true });
        writeFileSync(join(c.ws.datasets, '.last-build.json'), JSON.stringify({
          minSec: effMinSec, maxSec: args.maxSec ?? cfg.maxSec,
          sampleRate: cfg.sampleRate, adapter: picked.adapter.name,
          built: r.built ?? 0, at: new Date().toISOString(),
        }, null, 2), 'utf8');
      } catch { /* 写元数据失败不影响出料 */ }
      return { ok: true, stage: 'build', datasets: r.datasets ?? [], rendered: lines.join('\n') };
    }),
  });

  // ── 6 · 质量门 ────────────────────────────────────────────────────────
  register({
    name: 'train_qc',
    description:
      '数据集质量门：采样率/声道/时长分布/削波/静音占比/重复段。默认只报告；apply=true 才把不合格项移到 _rejected/（不删）。'
      + '★ 坏样本不会让训练报错，只会让模型默默学坏。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '数据集目录；省略则扫整个 datasets 目录' },
        speaker: { type: 'string', description: '只检查某个角色（datasets 下的子目录名）' },
        apply: { type: 'boolean', description: '把不合格文件移入 _rejected/（默认 false）' },
        minSec: { type: 'number', description: '片段下限秒（默认取上次 train_build 实际用的值）' },
        maxSec: { type: 'number', description: '片段上限秒（默认取上次 train_build 实际用的值）' },
      },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const c = makeCtx(cfg);
      const bad = ensurePython(cfg);
      if (bad) return { ok: false, stage: 'qc', rendered: `❌ ${bad}` };

      const target = args.dir || (args.speaker ? join(c.ws.datasets, args.speaker) : c.ws.datasets);
      if (!existsSync(target)) {
        return { ok: false, stage: 'qc', rendered: `❌ 目录不存在: ${target}（先 train_build）` };
      }
      // ★ QC 的时长阈值必须跟「产出时实际用的阈值」一致，否则必然互相打架：
      //   train_build 对台词降到 1.5s 产出 462 段，QC 却按 3.0s 判掉 160 个，合格数原地不动 —— 放宽 build 等于白做。
      //   所以默认读 train_build 留下的 .last-build.json。
      const buildMeta = readJson(join(c.ws.datasets, '.last-build.json'));
      const qcMin = args.minSec ?? (buildMeta?.minSec ?? cfg.minSec);
      const qcMax = args.maxSec ?? (buildMeta?.maxSec ?? cfg.maxSec);

      const report = join(c.ws.reports, `qc-${Date.now()}.json`);
      const argv = ['--dir', target, '--sample-rate', String(cfg.sampleRate),
        '--min-sec', String(qcMin), '--max-sec', String(qcMax), '--report', report];
      if (args.apply) argv.push('--apply');
      const r = await c.runPy('qc_dataset.py', argv, { timeoutMs: 60 * 60_000 });
      const p = lastJson(r.stdout);
      if (!p) return { ok: false, stage: 'qc', rendered: `❌ 质量门执行失败\n${clip(r.stderr, 900)}` };

      const lines = [
        `【质量门】${target}`,
        `阈值 ${qcMin}–${qcMax}s${buildMeta?.minSec && args.minSec === undefined ? '（继承 train_build 的实际值）' : ''}`,
        `文件 ${p.files} · 合格 ${p.good} · 不合格 ${p.bad} · 重复 ${p.duplicates}`,
        `总时长 ${p.total_minutes} 分钟 · 合格 ${p.good_minutes} 分钟`,
        `时长分布: 过短 ${p.duration_buckets['<min']} / 正常 ${p.duration_buckets.ok} / 过长 ${p.duration_buckets['>max']}`,
      ];
      if (p.bad) {
        lines.push('', '── 问题样本（前 10）──');
        for (const b of p.bad_samples.slice(0, 10)) lines.push(`  ${b.file}: ${b.reasons.join(', ')}`);
        lines.push('', args.apply ? `已移入 _rejected/: ${p.moved} 个` : '（未移动；要清理请传 apply=true）');
      }
      const enough = p.good_minutes >= 20;
      lines.push('', enough ? '✅ 时长够训（>20 分钟）' : `⚠️ 合格素材只有 ${p.good_minutes} 分钟，训练效果会很勉强（建议 ≥30 分钟）`);
      return { ok: p.good > 0, stage: 'qc', ...p, rendered: lines.join('\n') };
    }),
  });

  // ── 7 · 预处理 ────────────────────────────────────────────────────────
  register({
    name: 'train_preprocess',
    description:
      '把数据集灌进 DDSP 工程并预处理：备份并清空旧的 data/train|val/audio → 复制新数据 → draw.py 划分验证集 → '
      + 'preprocess.py 提 f0 与特征。★ 不清空会混入上一个角色的残留，训出四不像。',
    parameters: {
      type: 'object',
      properties: {
        speaker: { type: 'string', description: '要灌入的角色（datasets 下的目录名）' },
        datasetDir: { type: 'string', description: '直接指定数据集目录（覆盖 speaker）' },
        device: { type: 'string', description: 'cuda 或 cpu（默认 cuda）' },
        skipPreprocess: { type: 'boolean', description: '只同步数据 + draw.py，不跑特征提取（调试用）' },
      },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const c = makeCtx(cfg);
      const bad = ensurePython(cfg);
      if (bad) return { ok: false, stage: 'preprocess', rendered: `❌ ${bad}` };
      const src = args.datasetDir || (args.speaker ? join(c.ws.datasets, args.speaker) : '');
      if (!src || !existsSync(src)) {
        return {
          ok: false, stage: 'preprocess',
          rendered: `❌ 数据集目录不存在: ${src || '(未指定)'}\n可用: ${subdirs(c.ws.datasets).join(', ') || '（空，先 train_build）'}`,
        };
      }
      const nWav = countWav(src, 1);
      if (nWav === 0) return { ok: false, stage: 'preprocess', rendered: `❌ ${src} 里没有 wav` };

      const lines = [`【预处理】源: ${src}（${nWav} 个片段）`];

      // ① 备份并清空旧数据
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = join(c.ws.base, 'backup', `train_audio_${stamp}`);
      const oldTrain = countWav(cfg.trainAudioDir, 1);
      const oldVal = countWav(cfg.valAudioDir, 1);
      if (oldTrain + oldVal > 0) {
        mkdirSync(backup, { recursive: true });
        let failed = '';
        for (const [dir, tag] of [[cfg.trainAudioDir, 'train'], [cfg.valAudioDir, 'val']]) {
          if (!existsSync(dir)) continue;
          try { renameSync(dir, join(backup, tag)); }
          catch (e) { failed = `${dir}: ${e?.message ?? e}`; break; }
        }
        if (failed) {
          return {
            ok: false, stage: 'preprocess',
            rendered: [
              ...lines,
              '❌ 旧数据移不走，已中止（没有覆盖任何东西，避免新旧混合）：',
              `   ${failed}`,
              '   请手动清空或移走 data/train/audio 与 data/val/audio 后重试。',
            ].join('\n'),
          };
        }
        lines.push(`已把旧数据(${oldTrain}+${oldVal} 个)移到: ${backup}`);
      }
      mkdirSync(cfg.trainAudioDir, { recursive: true });
      mkdirSync(cfg.valAudioDir, { recursive: true });

      // ② 复制新数据
      let copied = 0;
      let copyErr = '';
      try { copied = copyWavTree(src, cfg.trainAudioDir); } catch (e) { copyErr = String(e?.message ?? e); }
      if (copyErr) {
        return { ok: false, stage: 'preprocess', rendered: lines.concat(`❌ 复制失败: ${copyErr}`).join('\n') };
      }
      lines.push(`已复制 ${copied} 个片段 → ${cfg.trainAudioDir}`);
      if (copied === 0) return { ok: false, stage: 'preprocess', rendered: lines.concat('❌ 复制后仍为空').join('\n') };

      // ③ draw.py
      const dr = await c.runDdsp('draw.py', [], { timeoutMs: 10 * 60_000 });
      const valN = countWav(cfg.valAudioDir, 1);
      lines.push(`${dr.ok ? '✅' : '❌'} draw.py → 验证集 ${valN} 个${dr.ok ? '' : ` | ${clip(dr.stderr, 400)}`}`);
      if (!dr.ok || valN === 0) {
        return { ok: false, stage: 'preprocess', rendered: lines.concat('★ 验证集为空会让 interval_val 报错，停在这里。').join('\n') };
      }

      if (args.skipPreprocess) {
        lines.push('', '（跳过特征提取；下一步 train_run 前记得补跑 train_preprocess）');
        return { ok: true, stage: 'preprocess', copied, valN, rendered: lines.join('\n') };
      }

      // ④ preprocess.py
      const device = args.device || 'cuda';
      const pr = await c.runDdsp('preprocess.py', ['-c', `configs/${cfg.configName}`, '-d', device],
        { timeoutMs: 4 * 3600_000 });
      lines.push(`${pr.ok ? '✅' : '❌'} preprocess.py -c configs/${cfg.configName} -d ${device}`);
      if (!pr.ok) lines.push(`   ${clip(pr.stderr || pr.stdout, 1200)}`);
      else {
        const expFiles = existsSync(cfg.expDir) ? readdirSync(cfg.expDir).length : 0;
        lines.push(`   exp 目录条目: ${expFiles}`);
      }
      lines.push('', pr.ok ? '下一步: train_run' : '★ 预处理失败，不要开训');
      return { ok: pr.ok, stage: 'preprocess', copied, valN, rendered: lines.join('\n') };
    }),
  });

  // ── 8 · 训练（后台）────────────────────────────────────────────────────
  register({
    name: 'train_run',
    description:
      '后台启动 train_reflow.py（detach + 日志落盘，DSH 重载不影响）。启动前校验：数据集非空、配置存在、'
      + 'exp 里已有 checkpoint 时会先提醒覆盖风险。返回 jobId，用 train_status 看进度。',
    parameters: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: '只回显将要执行的命令（默认 false）' },
        confirmOverwrite: { type: 'boolean', description: 'exp 里已有 checkpoint 时确认覆盖' },
      },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const c = makeCtx(cfg);
      const bad = ensurePython(cfg);
      if (bad) return { ok: false, stage: 'train', rendered: `❌ ${bad}` };

      const nTrain = countWav(cfg.trainAudioDir, 1);
      const nVal = countWav(cfg.valAudioDir, 1);
      if (nTrain === 0 || nVal === 0) {
        return {
          ok: false, stage: 'train',
          rendered: `❌ 数据未就绪：train=${nTrain} / val=${nVal}。先把 train_preprocess 跑完。`,
        };
      }
      if (!existsSync(cfg.configPath)) {
        return { ok: false, stage: 'train', rendered: `❌ 训练配置不存在: ${cfg.configPath}` };
      }
      const ckpts = scanCheckpoints(cfg.expDir);
      if (ckpts.length && !args.confirmOverwrite) {
        return {
          ok: false, stage: 'train',
          rendered: [
            `⚠️ ${cfg.expDir} 里已有 ${ckpts.length} 个 checkpoint（最高 ${ckpts[ckpts.length - 1].steps} 步）。`,
            '新训练会覆盖同名文件。',
            '',
            '要么先 train_register 把现有模型备份进音色库，要么传 confirmOverwrite=true 继续。',
          ].join('\n'),
        };
      }

      const script = 'train_reflow.py';
      const scriptArgs = ['-c', `configs/${cfg.configName}`];
      const cmdline = cmdlineOf(cfg.ddspEnv, [script, ...scriptArgs]);
      if (args.dryRun) {
        return {
          ok: true, stage: 'train',
          rendered: `【预演】\n命令: ${cmdline}\n目录: ${cfg.ddspDir}\n数据: train=${nTrain} val=${nVal}\n产物: ${cfg.expDir}/model_<步数>.pt`,
        };
      }

      mkdirSync(c.ws.jobs, { recursive: true });
      mkdirSync(c.ws.logs, { recursive: true });
      const jobId = `train-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const logPath = join(c.ws.logs, `${jobId}.log`);
      const { pid, pidValid } = await spawnJob({
        cmd: cfg.ddspEnv,
        args: [script, ...scriptArgs],
        cwd: cfg.ddspDir,
        env: pythonEnv(cfg.ddspDir, cfg.ddspEnv),
        logPath,
      });
      if (!pidValid) return { ok: false, stage: 'train', logPath,
        rendered: `❌ 训练进程启动失败。检查 Python 路径、工程目录与日志: ${logPath}\n${tailFile(logPath, 5)}` };
      writeFileSync(join(c.ws.jobs, `${jobId}.json`), JSON.stringify({
        jobId, pid, cmd: cmdline, cwd: cfg.ddspDir, logPath,
        startedAt: Date.now(), status: 'running', train: nTrain, val: nVal,
      }, null, 2), 'utf8');

      return {
        ok: true, stage: 'train', jobId, pid, logPath,
        rendered: [
          '✅ 训练已在后台启动',
          `jobId: ${jobId}`,
          `pid:   ${pid}`,
          `日志:  ${logPath}`,
          '',
          `数据: train=${nTrain} val=${nVal}`,
          `产物: ${cfg.expDir}/model_<步数>.pt（每 interval_force_save 步落一个）`,
          '',
          '用 train_status 看进度；要停用 train_stop。',
          '★ 后台进程独立于 DSH，关窗口不会中断训练。',
        ].join('\n'),
      };
    }),
  });

  // ── 9 · 状态 ──────────────────────────────────────────────────────────
  register({
    name: 'train_status',
    description:
      '读训练进度：最新 job 状态、exp 里已落盘的 checkpoint 步数、日志尾部的 step/loss。'
      + '★ 判断「训到多少步可以停」靠这个，别靠感觉。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '指定 job（省略取最新一个）' },
        tail: { type: 'integer', description: '日志尾部行数（默认 15）' },
      },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const c = makeCtx(cfg);
      const ckpts = scanCheckpoints(cfg.expDir);
      let job = null;
      try {
        const files = readdirSync(c.ws.jobs).filter((f) => f.endsWith('.json')).sort();
        const pick = args.jobId ? `${args.jobId}.json` : files[files.length - 1];
        if (pick) job = readJson(join(c.ws.jobs, pick));
      } catch { /* 没有 job 也正常 */ }

      const logText = job?.logPath ? tailFile(job.logPath, args.tail ?? 15) : '';
      const prog = parseProgress(logText);
      const alive = job?.pid ? (() => { try { process.kill(job.pid, 0); return true; } catch { return false; } })() : false;

      // ★ 「job 里的进程已结束」≠「没人在训练」。手工/外部启动的训练没有 job 记录，
      //   光看进程状态会把正在跑的训练报成「已结束」——这是最容易误导人的假阴性。
      //   用 exp 目录的写入时间兜底：DDSP 训练会持续写 log_info.txt。
      const marks = [join(cfg.expDir, 'log_info.txt'), join(cfg.expDir, 'train.log')]
        .filter((p) => existsSync(p))
        .map((p) => { try { return statSync(p).mtimeMs; } catch { return 0; } });
      const idleSec = marks.length ? Math.round((Date.now() - Math.max(...marks)) / 1000) : null;
      const writing = idleSec !== null && idleSec < 120;

      const lines = ['【训练状态】'];
      if (job) {
        lines.push(`任务: ${job.jobId}`);
        lines.push(`进程: ${job.pid} ${alive ? '（运行中）' : '（已结束）'}`);
        lines.push(`启动: ${new Date(job.startedAt).toLocaleString()}`);
      } else {
        lines.push('任务: 无记录（可能没通过本插件启动）');
      }
      if (writing && !job) {
        lines.push(`✅ exp 在 ${idleSec}s 前仍在写入 ⇒ 训练正在跑（但不是本插件启动的，没有 job 记录）`);
      } else if (writing && !alive) {
        lines.push(
          `⚠️ 但 exp 在 ${idleSec}s 前仍在写入 ⇒ **有训练正在跑，只是不是这个 job 起的**`
          + '（手工/外部启动）。`train_stop` 管不到它，要停请自行确认 PID。',
        );
      } else if (!writing && idleSec !== null && alive) {
        lines.push(`⚠️ 进程在，但 exp 已有 ${idleSec}s 没写入 —— 可能卡住，或在跑验证/特征提取`);
      }
      lines.push(`checkpoint: ${ckpts.length ? ckpts.map((x) => x.steps).join(', ') : '（还没有）'}`);
      if (prog.step || prog.loss) lines.push(`日志进度: step=${prog.step ?? '?'} loss=${prog.loss ?? '?'} epoch=${prog.epoch ?? '?'}`);
      if (logText) lines.push('', '── 日志尾部 ──', logText);
      if (ckpts.length) {
        lines.push('', `最新模型: ${join(cfg.expDir, `model_${ckpts[ckpts.length - 1].steps}.pt`)}`);
        lines.push('试听: train_infer；满意后 train_register');
      }
      return {
        ok: true, stage: 'status',
        jobId: job?.jobId ?? '', alive,
        checkpoints: ckpts, progress: prog, rendered: lines.join('\n'),
      };
    }),
  });

  // ── 10 · 停止 ─────────────────────────────────────────────────────────
  register({
    name: 'train_stop',
    description: '停止后台训练进程（taskkill /T /F，连同子进程）。用于「loss 已经稳定，不训了」。',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: '省略则停最新一个' } },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const c = makeCtx(cfg);
      let job = null;
      try {
        const files = readdirSync(c.ws.jobs).filter((f) => f.endsWith('.json')).sort();
        const pick = args.jobId ? `${args.jobId}.json` : files[files.length - 1];
        if (pick) job = readJson(join(c.ws.jobs, pick));
      } catch { /* ignore */ }
      if (!job?.pid) return { ok: false, stage: 'stop', rendered: '❌ 没有可停的 job 记录' };

      const r = await runOnce({ cmd: 'taskkill', args: ['/PID', String(job.pid), '/T', '/F'], timeoutMs: 30_000 });
      const ckpts = scanCheckpoints(cfg.expDir);
      const lines = [
        r.ok ? `✅ 已停止 pid ${job.pid}` : `⚠️ taskkill 返回 ${r.exitCode}（进程可能已自行结束）`,
        `现有 checkpoint: ${ckpts.length ? ckpts.map((x) => x.steps).join(', ') : '无'}`,
      ];
      if (!r.ok && r.stderr) lines.push(clip(r.stderr, 300));
      return { ok: true, stage: 'stop', rendered: lines.join('\n') };
    }),
  });

  // ── 11 · 冒烟推理 ──────────────────────────────────────────────────────
  register({
    name: 'train_infer',
    description:
      '用训练好的 checkpoint 做一次冒烟推理，产出可直接听的 wav。不给 inputWav 时自动从数据集里挑一条。'
      + '★ 这是「模型到底成不成」的唯一证据，别只看 loss。',
    parameters: {
      type: 'object',
      properties: {
        steps: { type: 'integer', description: '用第几步的模型（省略取 exp 里最大步数）' },
        inputWav: { type: 'string', description: '输入干声 wav；省略则从数据集自动挑' },
        key: { type: 'integer', description: '变调半音（默认 0）' },
        tStart: { type: 'number', description: 'reflow 起始（默认 0.7）' },
        inferStep: { type: 'integer', description: '采样步数（默认 50）' },
        method: { type: 'string', description: 'euler 或 rk4（默认 euler）' },
      },
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const c = makeCtx(cfg);
      const bad = ensurePython(cfg);
      if (bad) return { ok: false, stage: 'infer', rendered: `❌ ${bad}` };

      const ckpts = scanCheckpoints(cfg.expDir);
      if (!ckpts.length) return { ok: false, stage: 'infer', rendered: '❌ 还没有 checkpoint，先训练' };
      const steps = args.steps ?? ckpts[ckpts.length - 1].steps;
      const model = join(cfg.expDir, `model_${steps}.pt`);
      if (!existsSync(model)) {
        return { ok: false, stage: 'infer', rendered: `❌ 没有 model_${steps}.pt。可用: ${ckpts.map((x) => x.steps).join(', ')}` };
      }

      // 输入：给了就用；否则从数据集挑第一句
      let input = args.inputWav || '';
      if (!input) {
        const pool = [];
        for (const sp of subdirs(c.ws.datasets)) {
          for (const f of readdirSync(join(c.ws.datasets, sp)).filter((x) => /\.wav$/i.test(x)).slice(0, 1)) {
            pool.push(join(c.ws.datasets, sp, f));
          }
        }
        input = pool[0] || '';
      }
      if (!input || !existsSync(input)) {
        return { ok: false, stage: 'infer', rendered: '❌ 找不到输入 wav；请传 inputWav' };
      }

      // ★ 训练集内的句子做冒烟，本质是「过拟合自测」：SVC 会跟着输入的音高/内容重建，
      //   即使模型没学到音色，输出也会「听着挺像、时长静音比全对」。这条标志决定怎么读结果。
      const flat = (p) => String(p).replace(/\\/g, '/').toLowerCase();
      const inDataset = flat(input).startsWith(flat(c.ws.datasets));

      // DDSP 的 main_reflow 需要 raw/ 下的文件
      const rawDir = join(cfg.ddspDir, 'raw');
      mkdirSync(rawDir, { recursive: true });
      const rawName = `probe_${Date.now()}`;
      copyFileSync(input, join(rawDir, `${rawName}.wav`));

      const outDir = join(c.ws.base, '试听');
      mkdirSync(outDir, { recursive: true });
      const outWav = join(outDir, `${rawName}_${steps}.wav`);
      const argv = ['-i', `raw/${rawName}.wav`, '-m', `exp/${cfg.expName}/model_${steps}.pt`, '-o', outWav,
        '-k', String(args.key ?? 0), '-id', '1', '-method', args.method || 'euler',
        '-step', String(args.inferStep ?? 50), '-pe', 'rmvpe', '-ts', String(args.tStart ?? 0.7), '-v', '0'];

      const r = await c.runDdsp('main_reflow.py', argv, { timeoutMs: 60 * 60_000 });
      const art = artifactsOk([outWav], 8192);
      const lines = [
        `【冒烟推理】model_${steps}.pt`,
        `${art.ok ? '✅' : '❌'} ${outWav} ${art.ok ? `${(art.arts[0].sizeBytes / 1024).toFixed(0)} KB` : '（未生成或过小）'}`,
        `输入: ${input}`,
      ];
      if (!r.ok || !art.ok) {
        lines.push('', clip(r.stderr || r.stdout, 1200));
        lines.push('★ 失败常见原因: 模型步数与配置 n_spk 不符 / raw 下文件名带空格 / 显存不足');
      } else {
        lines.push('', '★ 听一遍：像不像本人、有没有金属感/断续。loss 低不等于好听。');
        if (inDataset) {
          lines.push(
            '⚠️ 这条输入取自**训练集内部** ⇒ 本次属于「过拟合自测」，只能证明通路通、音高/时长/静音比正常，'
            + '**不能证明学到了音色**（SVC 会跟着输入重建，没学到也会像）。',
            '   要验音色：传 inputWav 指向训练集**外**的干声（另一部作品/另一个人的干净人声）再听一遍。',
          );
        }
      }
      return { ok: r.ok && art.ok, stage: 'infer', outWav, input, inDataset, rendered: lines.join('\n') };
    }),
  });

  // ── 12 · 注册进音色库（闭环）───────────────────────────────────────────
  register({
    name: 'train_register',
    description:
      '把训练产物注册进音色库，``03_*/<角色>_步数N/exp/<expName>/model_N.pt + config.yaml``。'
      + '★ 这一步做完，dsh-cover-pipeline 下次加载就能直接「用 XX 的声音翻唱」。不注册 = 闭环没完成。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '角色名（决定音色库目录名，翻唱时就用这个名字叫人）' },
        steps: { type: 'integer', description: '要注册的 checkpoint 步数（省略取最大）' },
        libDir: { type: 'string', description: '音色库目录（省略用自动发现的 03_*）' },
        overwrite: { type: 'boolean', description: '同名目录已存在时是否覆盖（默认 false）' },
      },
      required: ['role'],
      additionalProperties: false,
    },
    ...wrap(async (args) => {
      const c = makeCtx(cfg);
      const role = String(args.role || '').trim();
      if (!role) return { ok: false, stage: 'register', rendered: '❌ 必须给角色名（翻唱时就用它叫人）' };

      const ckpts = scanCheckpoints(cfg.expDir);
      if (!ckpts.length) return { ok: false, stage: 'register', rendered: '❌ 还没有 checkpoint' };
      const steps = args.steps ?? ckpts[ckpts.length - 1].steps;
      const model = join(cfg.expDir, `model_${steps}.pt`);
      if (!existsSync(model)) {
        return { ok: false, stage: 'register', rendered: `❌ 没有 model_${steps}.pt（可用: ${ckpts.map((x) => x.steps).join(', ')}）` };
      }

      const cfgSrc = join(cfg.expDir, 'config.yaml');
      if (!existsSync(cfgSrc) || statSync(cfgSrc).size === 0 || statSync(model).size === 0) {
        return { ok: false, stage: 'register', rendered: `❌ 注册需要非空的 model_${steps}.pt 和同一实验的 config.yaml: ${cfg.expDir}` };
      }
      const safeRole = role.replace(/[\\/:*?"<>|_]/g, '').trim() || 'voice';

      // ★ 本机可能有多个语义库（03_音色模型_MYGO-AveMujica / 03_音色模型_SenrenBanka …）。
      //   cfg.voiceLibDir 只取「第一个」03_*，跨库重注册时会跑错库（芳乃 2000 步在 SenrenBanka，
      //   2 万步却写回 MYGO）。所以：显式 libDir > 同名角色当前所在的库 > 自动发现的库。
      const allLibs = (() => {
        try {
          return readdirSync(cfg.songRoot)
            .filter((d) => /^03[_-]/.test(d) && isDir(join(cfg.songRoot, d)))
            .map((d) => toPosixPath(join(cfg.songRoot, d)));
        } catch { return []; }
      })();
      const homeLib = allLibs.find((l) => {
        try {
          return readdirSync(l).some((d) => d === safeRole || d.startsWith(`${safeRole}_步数`));
        } catch { return false; }
      });
      const lib = toPosixPath(args.libDir || homeLib || cfg.voiceLibDir || join(cfg.songRoot, '03_音色模型_local'));
      const libWhy = args.libDir ? '显式指定' : homeLib ? `「${safeRole}」已在此库，跟着它走` : '自动发现';

      // ★ 翻唱插件的发现规则（与 config.js listVoices 逐字一致）要求：
      //     exp/<目录名匹配 /reflow/i>/model_N.pt
      //   所以注册目录名必须含 reflow。expName 不含时先改名，否则模型写进去也永远看不见。
      const expTag = /reflow/i.test(cfg.expName) ? cfg.expName : `reflow-${cfg.expName}`;
      const renamed = expTag !== cfg.expName;
      const targetDir = join(lib, `${safeRole}_步数${steps}`, 'exp', expTag);
      if (existsSync(targetDir) && !args.overwrite) {
        return {
          ok: false, stage: 'register',
          rendered: `⚠️ 已存在: ${targetDir}\n换个角色名，或传 overwrite=true 覆盖。`,
        };
      }
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(model, join(targetDir, `model_${steps}.pt`));

      let configCopied = false;
      if (existsSync(cfgSrc)) {
        copyFileSync(cfgSrc, join(targetDir, 'config.yaml'));
        configCopied = true;
      }

      // 显式标记「这个目录是谁注册的」。
      // 不能靠猜：同一架构下 model_20000.pt 的字节大小是固定的，
      // 别的角色停在 20000 步时大小完全一样，比大小会把 A 的模型认成 B 的。
      let modelSize = 0;
      try { modelSize = statSync(model).size; } catch { /* ignore */ }
      writeFileSync(join(targetDir, '.train-manifest.json'), JSON.stringify({
        tool: 'dsh-train-pipeline',
        role, steps, sourceExp: cfg.expDir, expTag, modelSize,
        registeredAt: new Date().toISOString(),
      }, null, 2), 'utf8');

      // 回读校验：只认「我刚写的这个文件」，不能用同名音色冒充
      const targetModel = join(targetDir, `model_${steps}.pt`);
      const after = resolveConfig({ ...cfg, voiceLibDir: lib });
      const hit = (after.voices ?? []).find((v) => v.model === targetModel) ?? null;
      const visible = !!hit;

      const lines = [
        `【注册】${role} · ${steps} 步`,
        allLibs.length > 1 ? `ℹ️ 本机有 ${allLibs.length} 个音色库，写入「${basename(lib)}」（${libWhy}）；要换传 libDir` : '',
        renamed ? `ℹ️ exp 目录名 ${cfg.expName} → ${expTag}（翻唱插件只认含 reflow 的目录）` : '',
        `✅ 模型 → ${targetModel}`,
        configCopied ? '✅ config.yaml 已随附' : '⚠️ exp 里没有 config.yaml（翻唱插件一般仍能用，但建议确认）',
        '',
        visible
          ? `✅ 翻唱插件可见：「${hit.name}」${hit.steps} 步`
          : '⚠️ 回读没匹配到：目录名需为「角色_步数N」，且 exp 下的子目录名必须含 reflow',
        '',
        visible ? `现在可以直接说：「用${role}的声音翻唱《歌名》」—— 需先重启/重载 DSH 让翻唱插件重新扫描。` : '',
      ];
      return {
        ok: visible, stage: 'register',
        voiceDir: join(lib, `${safeRole}_步数${steps}`), targetDir, visible, rendered: lines.filter(Boolean).join('\n'),
      };
    }),
  });

  // ── 13 · 总览 ─────────────────────────────────────────────────────────
  register({
    name: 'train_overview',
    description:
      '一屏看全：数据集里有哪些角色各多少段、exp 里有哪些 checkpoint、音色库里有哪些可翻唱的音色。'
      + '收工前用它确认「训练产出确实进了音色库」。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    ...wrap(async () => {
      const c = makeCtx(cfg);
      const sets = [];
      for (const sp of subdirs(c.ws.datasets)) {
        const dir = join(c.ws.datasets, sp);
        const n = countWav(dir, 1);
        if (n) sets.push({ speaker: sp, wavs: n, dir });
      }
      const ckpts = scanCheckpoints(cfg.expDir);
      const voices = listVoices(cfg);

      const lines = [
        '【总览】',
        `工作区: ${c.ws.base}`,
        `DDSP:   ${cfg.ddspDir || '(未发现)'}`,
        '',
        `── 数据集（${sets.length} 个角色）──`,
        ...(sets.length ? sets.map((s) => `  ${s.speaker}: ${s.wavs} 段`) : ['  （空）']),
        '',
        `── checkpoint（exp/${cfg.expName}）──`,
        ckpts.length ? `  ${ckpts.map((x) => x.steps).join(', ')}` : '  （无）',
        '',
        `── 可翻唱音色（${voices.length}）──`,
        ...(voices.length
          ? voices.slice(0, 20).map((v) => `  ${v.name} @ ${v.steps} 步`)
          : ['  （无）']),
      ];
      if (ckpts.length) {
        const top = ckpts[ckpts.length - 1];
        // 只认自己写过的 manifest：同步数的不同角色模型大小完全一致，比大小会误判
        const marked = voices
          .filter((v) => v.steps === top.steps)
          .map((v) => ({ v, m: readJson(join(v.exp, '.train-manifest.json')) }))
          .find(({ m }) => m && m.sourceExp === cfg.expDir && m.steps === top.steps);
        const sameStepOthers = voices.filter((v) => v.steps === top.steps && v !== marked?.v);

        if (marked) {
          lines.push('', `✅ 最新 checkpoint(${top.steps} 步) 已注册为「${marked.v.name}」`);
        } else {
          lines.push('', `⚠️ 最新 checkpoint(${top.steps} 步) 还没注册 → train_register`);
          if (sameStepOthers.length) {
            lines.push(`   （音色库里另有 ${sameStepOthers.length} 个同步骤音色：`
              + `${sameStepOthers.map((v) => v.name).join('/')}——是别人的模型，不能算已注册）`);
          }
        }
      }
      return { ok: true, stage: 'overview', datasets: sets, checkpoints: ckpts, voices, rendered: lines.join('\n') };
    }),
  });

  logger.info(`[train-pipeline] 已注册 ${13} 个工具 · DDSP=${cfg.ddspDir || '(未发现)'}`);
}

export default { name, inject, apply };
