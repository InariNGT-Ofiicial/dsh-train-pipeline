/**
 * 预留源：番剧 / 录屏 / B 站语音合集。
 *
 * ★ 这个适配器**故意不假装能跑**。
 *   它的 implemented 只有 detect 和 build（对"已经处理好的 wav 目录"），
 *   scan（认人）与 separate（分离）明确列在 pending 里。
 *   原因是：番剧路线没有权威 speaker 字段，只能靠字幕 Name 或声纹聚类，
 *   误差不可忽略。给一个"看起来能跑"的实现，比不给更糟。
 *
 * 但接口是**定死的**，后续接入不用改调用方：
 *   detect   → 判断这是视频 / 视频目录 / 音频目录
 *   scan     → 出角色清单（当前仅对 wav 目录返回单角色）
 *   separate → ffmpeg 抽音轨 → UVR5/MSST 分离人声（未实现）
 *   diarize  → whisperX/pyannote 角色归属（未实现）
 *   build    → 复用 build_dataset.py --voice-only（已实现）
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { join } from '../config.js';

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|flv|webm|ts)$/i;
const AUDIO_EXT = /\.(wav|mp3|flac|m4a|ogg|opus)$/i;

function ls(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function countBy(dir, re, depth = 1) {
  let n = 0;
  const walk = (d, lv) => {
    if (lv > depth) return;
    for (const e of ls(d)) {
      if (e.isDirectory()) { walk(join(d, e.name), lv + 1); continue; }
      if (re.test(e.name)) n += 1;
    }
  };
  walk(dir, 0);
  return n;
}

const media = {
  id: 'media',
  name: '番剧 / 录屏 / 合集',
  flagship: false,
  why: '没有权威 speaker 字段，必须靠字幕 Name 或声纹聚类，误差不可忽略',
  need: 'ffmpeg 抽音轨 → 人声分离 → VAD 切片 → 角色归属（后两步未实现）',
  capabilities: {
    implemented: ['detect'],
    pending: ['scan', 'separate', 'diarize', 'build-video'],
  },

  async detect(ctx, { input }) {
    if (!input || !existsSync(input)) return { ok: false, detail: `路径不存在: ${input}` };
    let st;
    try { st = statSync(input); } catch { return { ok: false, detail: '无法读取路径' }; }

    if (st.isFile()) {
      if (VIDEO_EXT.test(input)) {
        return {
          ok: true, kind: 'video', input,
          detail: `单个视频文件：${basename(input)}`,
          blocked: true,
          roadmap: this.roadmap(),
        };
      }
      return { ok: false, detail: '单个音频文件请放进目录后作为 voice-only 源处理' };
    }

    const videos = countBy(input, VIDEO_EXT, 1);
    if (videos > 0) {
      return {
        ok: true, kind: 'video-dir', input,
        detail: `目录里有 ${videos} 个视频文件`,
        blocked: true,
        roadmap: this.roadmap(),
      };
    }
    const audios = countBy(input, AUDIO_EXT, 1);
    if (audios > 0) {
      return {
        ok: true, kind: 'audio-dir', input, voiceDir: input,
        detail: `目录里有 ${audios} 个音频文件（视为已处理好的干声）`,
        blocked: false,
      };
    }
    return { ok: false, detail: '没找到视频或音频文件' };
  },

  /** 认人：当前只对 audio-dir 给单角色结论；视频源直接如实拒绝 */
  async scan(ctx, { input }) {
    const det = await this.detect(ctx, { input });
    if (!det.ok) return det;
    if (det.kind === 'audio-dir') {
      return {
        ok: true, kind: 'audio-dir', input,
        speakers: [], pseudo: true,
        note: '音频目录默认单角色；多角色请分别放不同目录',
        detail: '需要你指定这个目录对应哪个角色（speaker 参数）',
      };
    }
    return {
      ok: false,
      notImplemented: true,
      kind: det.kind,
      detail: '视频源的「分离 + 认人」尚未接入。当前请先自行导出去 BGM 的干声 wav 目录。',
      roadmap: this.roadmap(),
    };
  },

  async build(ctx, { input, speakers, minSec, maxSec, sampleRate, limit }) {
    const det = await this.detect(ctx, { input });
    if (!det.ok) return det;
    if (det.kind !== 'audio-dir') {
      return {
        ok: false, notImplemented: true,
        detail: '视频源不能直接出料：请先导出干声 wav 目录（见 roadmap）',
        roadmap: this.roadmap(),
      };
    }
    const speaker = speakers?.[0] || basename(input);
    const report = join(ctx.ws.reports, `build-media-${Date.now()}.json`);
    const args = ['--voice-dir', input, '--out-dir', ctx.ws.datasets,
      '--voice-only', '--speaker', speaker,
      '--min-sec', String(minSec), '--max-sec', String(maxSec),
      '--sample-rate', String(sampleRate), '--report', report];
    if (limit) args.push('--limit', String(limit));
    const r = await ctx.runPy('build_dataset.py', args, { timeoutMs: 4 * 3600_000 });
    const parsed = ctx.lastJson(r.stdout);
    if (!r.ok || !parsed) return { ok: false, detail: '构建失败', stderr: r.stderr?.slice(-1200) };
    return {
      ok: (parsed.built ?? 0) > 0,
      datasets: parsed.speakers ?? [],
      built: parsed.built, minutes: parsed.minutes, reportPath: report,
      detail: `产出 ${parsed.built} 个片段 / ${parsed.minutes} 分钟`,
    };
  },

  /** 后续接入点：写清楚要补什么，而不是留一个 TODO 空壳 */
  roadmap() {
    return {
      steps: [
        { step: 'separate', tool: 'ffmpeg + UVR5/MSST', note: '抽音轨 → 分离人声；MSST 已在 01_* 里，可直接复用 cover 插件的分离能力' },
        { step: 'vad', tool: 'silero-vad 或能量门', note: '按静音切成 3–15s，掐掉首尾静音（build_dataset.py 已内含裁静音）' },
        { step: 'diarize', tool: 'whisperX + pyannote', note: '说话人分离；有 ASS/SRT 时优先读字幕 Name 字段，比聚类准得多' },
        { step: 'anchor', tool: '声纹 embedding', note: '把聚类 id 锚定到角色名；需要每个角色至少 3 条已知样本' },
      ],
      contract: '接入后 scan 返回 { speakers:[{speaker,lines,withVoice}] } 即可，build 完全复用现有实现',
    };
  },
};

export default media;
