/**
 * 旗舰源：galgame 解包路线。
 *
 * 为什么它是旗舰（而不是"顺便支持一下"）：
 *   剧本脚本里 speaker 字段是**引擎级别的权威标注**，语音文件本身通常是无 BGM、
 *   无混响的独立 ogg。这意味着「角色归属」这一最耗人工的环节可以做到零人工。
 *   番剧/录屏永远做不到这一点 —— 它们只能靠声纹猜。
 *
 * 解包这一环现在**已经自动化**（见 src/unpack.js）：
 *   未加密封包 —— arc_unpacker 命令行直接解，工具由 train_toolchain 从官方 release 装好；
 *   加密封包   —— 通用插件打不开，需要 KrkrExtract（GUI，以游戏 exe 为入口）人工解一次。
 *   所以这里的 detect 仍然要把「这是封包，得先解」说清楚，只是下一步从"人来解"
 *   变成了"train_unpack 去解，解不开再叫人"。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { join } from '../config.js';

const AUDIO_EXT = /\.(ogg|wav|mp3|flac|opus|m4a)$/i;

// voice/ 下常混着「不是角色」的目录：系统音、音效、回想混音、路人。
// 它们不是某个 CV 的语料，混进数据集就是错标签 —— 直接排除。
const NON_ROLE_DIR = /^(system|sys|se|sound|bgm|back|other|etc|その他|回想|モブ|群衆|ザコ|エキストラ)/i;

/**
 * 「多角色语音目录」布局：voice/<角色>/ *.ogg
 *   galgame 解包后天然就是这样（千恋万花是 voice/０１・芳乃/ …），
 *   把每个一级子目录当一个角色，命名去掉序号前缀。
 * 返回 [{ dir, raw, name, files, bytes }]，按文件数降序。
 */
function splitVoiceDirs(root) {
  const out = [];
  for (const e of ls(root)) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const name = stripIndexPrefix(e.name);
    if (NON_ROLE_DIR.test(e.name) || NON_ROLE_DIR.test(name)) continue;
    const audio = countAudio(dir, 4);
    if (audio.files > 0) {
      out.push({ dir, raw: e.name, name, ...audio });
    }
  }
  return out.sort((a, b) => b.files - a.files);
}

/** 「０１・芳乃」→「芳乃」;「01_fangnai」→「fangnai」 */
function stripIndexPrefix(s) {
  const t = s.replace(/^[０-９0-9]{1,3}\s*[・･_.\-、，,．]\s*/, '').trim();
  return t || s;
}

/**
 * 找角色目录：先在 root 下找；找不到再下探两层找 voice/ 之类的子目录。
 * 下探两层是必要的 —— 解包产物常是 `<根>/data/voice/<角色>/`（千恋万花就是这样），
 * 只下探一层会停在 <根>/data/ 上，把「分角色布局」误判成「只有剧本」。
 */
function findRoleDirs(root) {
  const direct = splitVoiceDirs(root);
  if (direct.length >= 2) return direct;
  const VOICE_DIR = /^(voice|voices|ボイス|se|sound)$/i;
  const lookIn = (dir, lv) => {
    if (lv > 2) return direct;
    for (const e of ls(dir)) {
      if (!e.isDirectory()) continue;
      const sub = join(dir, e.name);
      if (VOICE_DIR.test(e.name)) {
        const inner = splitVoiceDirs(sub);
        if (inner.length >= 2) return inner;
      }
    }
    for (const e of ls(dir)) {
      if (!e.isDirectory() || VOICE_DIR.test(e.name)) continue;
      const got = lookIn(join(dir, e.name), lv + 1);
      if (got.length >= 2) return got;
    }
    return direct;
  };
  return lookIn(root, 1);
}

function ls(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function dirsOf(dir) {
  return ls(dir).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
}

function filesOf(dir, re = null) {
  return ls(dir).filter((d) => d.isFile() && (!re || re.test(d.name))).map((d) => join(dir, d.name));
}

/** 在目录里递归找某种文件，返回前 limit 个（避免大目录扫太久） */
function findSome(dir, re, limit = 50, depth = 3) {
  const out = [];
  const walk = (d, lv) => {
    if (lv > depth || out.length >= limit) return;
    for (const e of ls(d)) {
      if (out.length >= limit) return;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, lv + 1);
      else if (re.test(e.name)) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

/** 数一个目录下的音频文件（只数，不读内容） */
function countAudio(dir, depth = 2) {
  let n = 0;
  let bytes = 0;
  const walk = (d, lv) => {
    if (lv > depth) return;
    for (const e of ls(d)) {
      const full = join(d, e.name);
      if (e.isDirectory()) { walk(full, lv + 1); continue; }
      if (AUDIO_EXT.test(e.name)) {
        n += 1;
        try { bytes += statSync(full).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir, 0);
  return { files: n, bytes };
}

async function durations(ctx, dirs) {
  if (typeof ctx.runPy !== 'function') return new Map();
  const result = await ctx.runPy('probe_audio.py', ['--dirs', ...dirs], { timeoutMs: 30 * 60_000 });
  const parsed = result.ok ? ctx.lastJson(result.stdout) : null;
  const rows = parsed?.directories ?? [];
  return new Map(dirs.map((dir) => [dir, rows.find((r) => r.dir === dir) ?? {
    durationSeconds: null, durationComplete: false, measuredFiles: 0,
    durationError: result.stderr || parsed?.error || '时长探测不可用；请检查 ddspEnv 与 soundfile',
  }]));
}

/** 常见目录名：voice(语音) / scn(剧本) / data(未知) */
function guessSubtrees(root) {
  const subs = dirsOf(root).map((d) => ({ path: d, name: basename(d).toLowerCase() }));
  const pick = (re) => subs.filter((s) => re.test(s.name)).map((s) => s.path);
  return {
    voice: pick(/^(voice|voices|se|sound|audio|bgm_?voice|ボイス)$/),
    scn: pick(/^(scn|scene|scenes|script|scripts|text|texts|シナリオ|data)$/),
    all: subs.map((s) => s.path),
  };
}

const galgame = {
  id: 'galgame',
  name: 'galgame 解包',
  flagship: true,
  why: '剧本带权威 speaker 字段，语音无 BGM，角色归属零人工',
  need: 'arc_unpacker（自动装）+ FreeMote PsbDecompile；加密封包才需要 KrkrExtract 人工',
  capabilities: {
    implemented: ['detect', 'scan', 'build'],
    pending: [],
    /** 解包由 src/unpack.js 承担，不在适配器里 —— 它跟"认角色"是两件事 */
    external: ['unpack'],
  },

  /**
   * 三种形态都能接：
   *   packed      游戏本体目录（有 .xp3）→ 需要解包这一步
   *   scn         已解包的剧本目录（有 .json）→ 直接解析
   *   voice-only  只有语音目录（或别的源的成品 wav 目录）→ 整目录当单角色
   */
  async detect(ctx, { input }) {
    if (!input || !existsSync(input)) return { ok: false, detail: `路径不存在: ${input}` };
    let st;
    try { st = statSync(input); } catch { return { ok: false, detail: '无法读取路径' }; }
    if (!st.isDirectory()) return { ok: false, detail: '需要一个目录（游戏根目录 / 解包产物目录）' };

    const xp3 = findSome(input, /\.xp3$/i, 10, 2);
    if (xp3.length) {
      const subs = guessSubtrees(input);
      return {
        ok: true, kind: 'packed', input,
        detail: `发现 ${xp3.length} 个 .xp3 封包`,
        hint: subs.voice.length || subs.scn.length
          ? '看起来已经解包过一部分，可直接指向解包产物目录'
          : '需要先解包（见 unpackGuide）',
        unpackGuide: guideFor(input, xp3),
      };
    }

    // ★★ 必须先看「按角色分目录」的语音布局，再考虑剧本。
    //   目录名是引擎级权威标注（voice/０１・芳乃/ 里的东西一定是芳乃说的），
    //   比从剧本文本猜说话人可靠得多；而且有些引擎的剧本我们根本解析不了
    //   （柚子社 .scn 是命令数组 PSB，实测解析出 102 行、语音命中 0/102）。
    //   曾经把剧本判定放在前面，导致 voice-multi 永远轮不到，整部游戏被判成「0 句可用」。
    const roles = findRoleDirs(input);
    if (roles.length >= 2) {
      const total = roles.reduce((s, r) => s + r.files, 0);
      return {
        ok: true, kind: 'voice-multi', input,
        detail: `${roles.length} 个角色目录 / ${total} 个音频：`
          + roles.slice(0, 6).map((r) => `${r.name}(${r.files})`).join(' / ')
          + (roles.length > 6 ? ' …' : ''),
        roles: roles.map((r) => ({
          name: r.name, raw: r.raw, dir: r.dir, files: r.files, bytes: r.bytes,
        })),
        voiceDir: dirname(roles[0].dir),
        note: '语音已按角色分目录 —— 不需要解析剧本（音色训练只要 wav + 角色归属）',
      };
    }

    const jsonSome = findSome(input, /\.json$/i, 20, 3);
    const ksSome = findSome(input, /\.ks$/i, 20, 3);
    if (jsonSome.length || ksSome.length) {
      const scnGuess = guessSubtrees(input).scn[0] || input;
      const parts = [];
      if (ksSome.length) parts.push(`${ksSome.length}${ksSome.length >= 20 ? '+' : ''} 个 KAG3 明文 .ks`);
      if (jsonSome.length) parts.push(`${jsonSome.length}${jsonSome.length >= 20 ? '+' : ''} 个 JSON 剧本`);
      return {
        ok: true, kind: 'scn', input: scnGuess,
        scnDir: scnGuess,
        detail: `发现 ${parts.join(' / ')}`,
        voiceDirs: guessSubtrees(input).voice,
      };
    }

    // 单文件发行版：数据追加在 exe 尾部，没有独立 .xp3（真机上第一部游戏就是这样）
    const bigExe = findSome(input, /\.exe$/i, 6, 2).filter((p) => {
      try { return statSync(p).size >= 5 * 1024 * 1024; } catch { return false; }
    });
    if (bigExe.length) {
      return {
        ok: true, kind: 'packed-exe', input,
        detail: `没有独立 .xp3，但有 ${bigExe.length} 个较大的 exe —— 多半是单文件发行版（数据内嵌）`,
        hint: 'train_unpack 会自动从 exe 尾部切出内嵌封包再解，不需要人工',
        exe: bigExe.map((p) => basename(p)),
      };
    }

    const audio = countAudio(input);
    // 单角色布局（只有 1 个分角色目录）也认，只是优先级低于上面的多角色分支
    if (roles.length >= 1) {
      const total = roles.reduce((s, r) => s + r.files, 0);
      return {
        ok: true, kind: 'voice-multi', input,
        detail: `${roles.length} 个角色目录 / ${total} 个音频：`
          + roles.slice(0, 6).map((r) => `${r.name}(${r.files})`).join(' / ')
          + (roles.length > 6 ? ' …' : ''),
        roles: roles.map((r) => ({
          name: r.name, raw: r.raw, dir: r.dir, files: r.files, bytes: r.bytes,
        })),
        voiceDir: dirname(roles[0].dir),
      };
    }
    if (audio.files > 0) {
      return {
        ok: true, kind: 'voice-only', input,
        detail: `只有语音文件（${audio.files} 个），没有剧本；将按「整目录=单角色」处理`,
        voiceDir: input,
      };
    }
    return { ok: false, detail: '既没有 .xp3，也没有 .json 剧本，也没有音频文件' };
  },

  /** 盘点角色：走 krkr_parse.py，把「谁有多少句、多少句带语音」摊开 */
  async scan(ctx, { input, voiceDir, spriteSpeakers = false }) {
    const det = await this.detect(ctx, { input });
    if (!det.ok) return det;
    if (det.kind === 'voice-multi') {
      const measured = await durations(ctx, det.roles.map((r) => r.dir));
      const speakers = det.roles.map((r) => ({
        speaker: r.name,
        with_voice: r.files,
        voice_dir: r.dir,
        ...(measured.get(r.dir) ?? {}),
        estMinutes: null,
        note: '目录即角色（没有剧本可比对）',
      }));
      const total = speakers.reduce((s, x) => s + x.with_voice, 0);
      const complete = speakers.every((s) => s.durationComplete);
      const seconds = complete ? speakers.reduce((s, x) => s + x.durationSeconds, 0) : null;
      return {
        ok: speakers.length > 0,
        kind: 'voice-multi', input, voiceDir: det.voiceDir, speakers,
        voiceFiles: total, withVoice: total, durationSeconds: seconds, durationComplete: complete,
        detail: `${speakers.length} 个角色目录 / ${total} 个音频（${complete ? `实测 ${(seconds / 60).toFixed(2)} 分钟` : '部分时长未知，见探测错误'}）`,
        note: '没有剧本，角色归属靠目录名 —— galgame 解包后的常见布局，可信',
      };
    }
    if (det.kind === 'voice-only') {
      const audio = countAudio(det.voiceDir || input);
      const measured = (await durations(ctx, [det.voiceDir || input])).get(det.voiceDir || input);
      return {
        ok: true, kind: 'voice-only', input,
        speakers: [], note: '语音-only 源无法从内容判断角色，需要人工指定角色名',
        voiceFiles: audio.files, withVoice: audio.files, voiceDir: det.voiceDir || input,
        ...measured, estMinutes: null,
      };
    }
    if (det.kind === 'packed' || det.kind === 'packed-exe') {
      return { ...det, ok: false, scanBlocked: true, detail: '先解包再扫描：train_unpack input=<游戏根目录>' };
    }

    const out = join(ctx.ws.corpus, `${basename(det.scnDir) || 'corpus'}.lines.jsonl`);
    const rep = join(ctx.ws.reports, `${basename(det.scnDir) || 'corpus'}.parse.json`);
    const vd = voiceDir || det.voiceDirs?.[0] || '';
    const r = await ctx.runPy('krkr_parse.py', [
      '--scn-dir', det.scnDir, '--out', out, '--report', rep,
      ...(vd && existsSync(vd) ? ['--voice-dir', vd] : []),
      ...(spriteSpeakers ? ['--sprite-speakers'] : []),
    ], { timeoutMs: 30 * 60_000 });

    if (!r.ok) return { ok: false, detail: '解析失败', stderr: r.stderr, cmdline: r.cmdline };
    const parsed = ctx.lastJson(r.stdout);
    if (!parsed) return { ok: false, detail: '解析器没有返回可读结果', stdout: r.stdout.slice(-800) };

    const speakers = (parsed.speakers ?? []).map((s) => ({
      ...s,
      estMinutes: Number(((s.with_voice * 4.2) / 60).toFixed(1)),
      durationMethod: 'sentence-count estimate (4.2s/line), not measured',
    }));
    const usable = speakers.filter((s) => s.with_voice > 0);
    return {
      ok: usable.length > 0,
      kind: 'scn',
      scnDir: det.scnDir,
      voiceDir: vd,
      lines: parsed.lines,
      withVoice: parsed.with_voice,
      scnFiles: parsed.scn_files,
      ksFiles: parsed.ks_files ?? 0,
      encodings: parsed.encodings ?? {},
      textLines: parsed.text_lines ?? 0,
      soundRefs: parsed.sound_refs ?? 0,
      speakerSources: parsed.speaker_sources ?? {},
      badFiles: parsed.bad_files,
      voiceHit: parsed.voice_hit,
      speakers,
      linesPath: out,
      reportPath: rep,
      detail: usable.length
        ? `${usable.length} 个角色有语音台词，合计 ${parsed.with_voice} 句`
        : (parsed.text_lines > 0
          ? `读到 ${parsed.text_lines} 行文本，但没有一行能同时定位到「说话人」或「语音」`
            + `${parsed.speaker_sources && Object.keys(parsed.speaker_sources).length ? `（说话人来源: ${JSON.stringify(parsed.speaker_sources)}）` : '（剧本里没有 [name] 标注，也没有语音引用）'}`
          : (parsed.lines > 0
            ? `抽到 ${parsed.lines} 句台词，但没有一句带语音引用 —— 这个源可能本身没有配音`
            : '没有抽到任何台词 —— 可能剧本未反编译，或键名不在候选集内')),
    };
  },

  /** 出料：调用 build_dataset.py，落 dataset_raw/<角色> */
  async build(ctx, { input, linesPath, voiceDir, speakers, minSec, maxSec, sampleRate, limit }) {
    const det = await this.detect(ctx, { input });
    if (!det.ok) return det;

    if (det.kind === 'scn' || det.kind === 'packed') {
      if (!linesPath || !existsSync(linesPath)) {
        return { ok: false, detail: '缺少 lines.jsonl：请先跑 train_scan' };
      }
      if (!voiceDir || !existsSync(voiceDir)) {
        return { ok: false, detail: '缺少语音目录：解包 voice.xp3 后把路径传进来（voiceDir）' };
      }
    }
    const report = join(ctx.ws.reports, `build-${Date.now()}.json`);
    const args = ['--voice-dir', det.voiceDir || voiceDir,
      '--out-dir', ctx.ws.datasets,
      '--min-sec', String(minSec), '--max-sec', String(maxSec),
      '--sample-rate', String(sampleRate), '--report', report];

    if (det.kind === 'voice-only') {
      args.push('--voice-only', '--speaker', speakers?.[0] || '未命名角色');
    } else if (det.kind === 'voice-multi') {
      args.push('--voice-only', '--split-dirs');
      const want = (speakers ?? []).filter((s) => s && s.toLowerCase() !== 'all');
      if (want.length) args.push('--speaker', want.join(','));
    } else {
      args.push('--lines', linesPath, '--speaker', (speakers ?? []).join(',') || 'all');
    }
    if (limit) args.push('--limit', String(limit));

    const r = await ctx.runPy('build_dataset.py', args, { timeoutMs: 4 * 3600_000 });
    const parsed = ctx.lastJson(r.stdout);
    if (!r.ok || !parsed) {
      return { ok: false, detail: '构建失败', stderr: r.stderr?.slice(-1200), cmdline: r.cmdline };
    }
    return {
      ok: (parsed.built ?? 0) > 0,
      datasets: parsed.speakers ?? [],
      built: parsed.built,
      minutes: parsed.minutes,
      reportPath: report,
      detail: `产出 ${parsed.built} 个片段 / ${parsed.minutes} 分钟`,
    };
  },
};

/** 解包指引：先说"能自动解"，再说"什么情况下要人" */
function guideFor(root, xp3) {
  const names = xp3.map((p) => basename(p));
  const voice = names.find((n) => /voice|se|sound/i.test(n));
  const scn = names.find((n) => /scn|scene|script|data/i.test(n));
  return {
    steps: [
      '① 优先自动：train_unpack input=<这个目录>（会先装好 arc_unpacker/FreeMote，再按封包角色解 + 反编译）',
      '② 若报「需要专用插件/密钥」= 加密封包：train_toolchain action=install id=krkrextract，用 KrkrExtract 以**游戏 exe** 启动人工解',
      `③ 解 ${voice ?? 'voice.xp3'} → 语音目录（ogg）；解 ${scn ?? 'scn/data.xp3'} → 剧本目录`,
      '④ 反编译脚本 .psb/.scn → JSON（train_unpack 自动做；手工则是 FreeMote 的 PsbDecompile.exe）',
      '⑤ train_scan 指向解包产物目录，角色归属与清洗全自动',
    ],
    xp3: names,
    hint: '未加密封包全程无人值守；加密封包才需要人工用 KrkrExtract 介入一次',
    toolDirs: [join(root, 'tools'), join(dirname(root), 'tools')],
  };
}

export default galgame;
