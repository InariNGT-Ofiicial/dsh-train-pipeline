#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_dataset.py —— 把「台词清单 + 语音文件」变成 DDSP-SVC 能直接吃的数据集。

两种输入模式：
    1) 台词驱动（galgame 旗舰路线）
       --lines lines.jsonl --voice-dir X:/unpack/voice --speaker 芳乃
       按 lines.jsonl 里的 speaker 字段精确挑句子，voice 字段模糊匹配音频文件。

    2) 整目录（给 media adapter / 现成语音包用）
       --voice-only --voice-dir X:/some/wavs --speaker 某角色
       整个目录当成同一个角色，只做清洗与规格化。这是「番剧/录屏/合集」路线的复用入口。

统一规格（来自 configs/reflow-barbara.yaml）：44100Hz / 单声道 / PCM16，片段 [min_sec, max_sec]。
超长片段按能量谷切分，不硬切，避免把字切碎。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

import numpy as np

try:
    import soundfile as sf
except ImportError:
    print(json.dumps({"ok": False, "error": "缺少 soundfile：请在 DDSP 的 env 里运行本脚本"}, ensure_ascii=False))
    sys.exit(2)

try:
    import librosa
    _HAS_LIBROSA = True
except ImportError:
    _HAS_LIBROSA = False

AUDIO_EXT = (".wav", ".ogg", ".mp3", ".flac", ".opus", ".m4a")


# ── 音频基础 ──────────────────────────────────────────────────────────────

def resample(y: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return y
    if _HAS_LIBROSA:
        return librosa.resample(y.astype(np.float32), orig_sr=sr, target_sr=target)
    n = int(round(len(y) * target / sr))
    x_old = np.linspace(0, 1, len(y), endpoint=False)
    x_new = np.linspace(0, 1, n, endpoint=False)
    return np.interp(x_new, x_old, y).astype(np.float32)


def trim_silence(y: np.ndarray, sr: int, thresh_db: float = -40.0, pad_sec: float = 0.05) -> np.ndarray:
    if y.size == 0:
        return y
    frame = max(1, int(sr * 0.02))
    n = len(y) // frame
    if n < 3:
        return y
    rms = np.sqrt(np.mean(y[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-12)
    voiced = np.where(db > thresh_db)[0]
    if voiced.size == 0:
        return y
    pad = int(pad_sec * sr)
    a = max(0, voiced[0] * frame - pad)
    b = min(len(y), (voiced[-1] + 1) * frame + pad)
    return y[a:b]


def dc_remove(y: np.ndarray) -> np.ndarray:
    return y - float(np.mean(y))


def split_by_energy(y: np.ndarray, sr: int, max_sec: float, min_sec: float):
    """超长音频按能量谷切成若干段，每段尽量接近 max_sec 且不短于 min_sec。"""
    if len(y) <= max_sec * sr:
        return [y]
    frame = int(sr * 0.05)
    n = len(y) // frame
    rms = np.sqrt(np.mean(y[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-12)
    thr = np.percentile(db, 20)
    valleys = [i for i in range(1, n - 1) if db[i] <= thr and db[i] <= db[i - 1] and db[i] <= db[i + 1]]
    cuts = [0]
    target = int(max_sec * sr / frame)
    lo = int(min_sec * sr / frame)
    while cuts[-1] + target < n:
        start = cuts[-1]
        window = [v for v in valleys if start + lo <= v <= start + target]
        cuts.append(window[-1] if window else start + target)
    cuts.append(n)
    out = []
    for a, b in zip(cuts[:-1], cuts[1:]):
        seg = y[a * frame: min(len(y), b * frame)]
        if len(seg) >= min_sec * sr * 0.8:
            out.append(seg)
    return out


# ── 匹配 ──────────────────────────────────────────────────────────────────

def build_index(voice_dir: str):
    """文件名 → 完整路径，键做小写去扩展名处理。"""
    idx = {}
    for root, _dirs, files in os.walk(voice_dir):
        for f in files:
            if not f.lower().endswith(AUDIO_EXT):
                continue
            stem = re.sub(r"\.[^.]+$", "", f).lower()
            full = os.path.join(root, f)
            idx.setdefault(stem, full)
            idx.setdefault(f.lower(), full)
            idx.setdefault(os.path.basename(root).lower() + "/" + stem, full)
    return idx


def read_lines(path: str):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return rows


def safe_name(s: str) -> str:
    s = re.sub(r"[\\/:*?\"<>|]", "_", s).strip()
    return s[:80] or "unnamed"


def strip_index_prefix(s: str) -> str:
    """「０１・芳乃」→「芳乃」;「01_fangnai」→「fangnai」。前缀是序号，不是名字。"""
    t = re.sub(r"^[０-９0-9]{1,3}\s*[・･_.\-、，,．]\s*", "", s).strip()
    return t or s


def audio_files_under(d: str):
    out = []
    for root, _dirs, files in os.walk(d):
        for f in files:
            if f.lower().endswith(AUDIO_EXT):
                out.append(os.path.join(root, f))
    return sorted(out)


# ── 主流程 ────────────────────────────────────────────────────────────────

def convert_one(src: str, dst: str, target_sr: int, min_sec: float, max_sec: float):
    """返回 (段数, 总秒数)；失败抛异常。"""
    y, sr = sf.read(src, always_2d=True, dtype="float32")
    y = y.mean(axis=1)
    y = dc_remove(y)
    y = resample(y, sr, target_sr)
    y = trim_silence(y, target_sr)
    if y.size == 0:
        raise ValueError("空音频")
    segs = []
    for seg in split_by_energy(y, target_sr, max_sec, min_sec):
        seg = trim_silence(seg, target_sr)
        if len(seg) / target_sr >= min_sec:
            segs.append(seg)
    if not segs:
        raise ValueError("裁剪后短于下限")
    base = os.path.splitext(dst)[0]
    for i, seg in enumerate(segs):
        out = f"{base}.wav" if len(segs) == 1 else f"{base}_{i:02d}.wav"
        peak = float(np.max(np.abs(seg))) or 1.0
        if peak > 0.999:                      # 只压掉真的爆掉的，不做整体归一化
            seg = seg / peak * 0.99
        sf.write(out, seg, target_sr, subtype="PCM_16")
    return len(segs), sum(len(s) for s in segs) / target_sr


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="构造 DDSP-SVC 数据集")
    ap.add_argument("--lines", default="", help="lines.jsonl（台词驱动模式）")
    ap.add_argument("--voice-dir", required=True, help="语音文件目录")
    ap.add_argument("--out-dir", required=True, help="输出根目录（下面按角色建子目录）")
    ap.add_argument("--speaker", default="", help="角色名，逗号分隔；all=全部有语音的角色")
    ap.add_argument("--voice-only", action="store_true", help="整目录当单角色（忽略 lines）")
    ap.add_argument("--split-dirs", action="store_true",
                    help="配合 --voice-only：把每个一级子目录当成一个角色"
                         "（galgame 解包后 voice/<角色>/ 的常见布局，如 voice/０１・芳乃/）")
    ap.add_argument("--min-sec", type=float, default=3.0)
    ap.add_argument("--max-sec", type=float, default=15.0)
    ap.add_argument("--sample-rate", type=int, default=44100)
    ap.add_argument("--limit", type=int, default=0, help="每个角色最多处理多少条（0=不限）")
    ap.add_argument("--report", default="")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.voice_dir):
        print(json.dumps({"ok": False, "error": f"语音目录不存在: {args.voice_dir}"}, ensure_ascii=False))
        return 2

    os.makedirs(args.out_dir, exist_ok=True)
    idx = build_index(args.voice_dir)
    stats = {"ok": True, "voice_files_indexed": len(idx), "speakers": [], "built": 0, "seconds": 0.0}

    if args.voice_only and args.split_dirs:
        jobs = []
        for d in sorted(os.listdir(args.voice_dir)):
            full = os.path.join(args.voice_dir, d)
            if not os.path.isdir(full):
                continue
            files = audio_files_under(full)
            if files:
                jobs.append((strip_index_prefix(d), files))
        if not jobs:
            print(json.dumps({"ok": False,
                              "error": f"{args.voice_dir} 下没有含音频的子目录（--split-dirs 需要 voice/<角色>/ 布局）"},
                             ensure_ascii=False))
            return 3
        want = [s.strip() for s in args.speaker.split(",") if s.strip()] if args.speaker else []
        if want and "all" not in [w.lower() for w in want]:
            keep = [j for j in jobs if any(w in j[0] for w in want)]
            if not keep:
                print(json.dumps({"ok": False, "error": "没有子目录匹配 --speaker",
                                  "available": [j[0] for j in jobs]}, ensure_ascii=False))
                return 3
            jobs = keep
        jobs.sort(key=lambda kv: -len(kv[1]))
    elif args.voice_only:
        if not args.speaker:
            print(json.dumps({"ok": False, "error": "voice-only 模式必须给 --speaker 指定角色名"}, ensure_ascii=False))
            return 2
        jobs = [(args.speaker, sorted(set(idx.values())))]
    else:
        if not args.lines or not os.path.isfile(args.lines):
            print(json.dumps({"ok": False, "error": "台词驱动模式需要有效的 --lines"}, ensure_ascii=False))
            return 2
        rows = read_lines(args.lines)
        want = [s.strip() for s in args.speaker.split(",") if s.strip()] if args.speaker else []
        buckets = {}
        for r in rows:
            sp = (r.get("speaker") or "").strip()
            if not sp or not (r.get("voice") or r.get("voice_id") is not None):
                continue
            if want and "all" not in [w.lower() for w in want] and sp not in want:
                continue
            buckets.setdefault(sp, []).append(r)
        if not buckets:
            print(json.dumps({"ok": False, "error": "没有匹配到任何有语音的台词；检查 --speaker 拼写",
                              "available": sorted({(r.get('speaker') or '') for r in rows})[:60]}, ensure_ascii=False))
            return 3
        jobs = sorted(buckets.items(), key=lambda kv: -len(kv[1]))

    for sp_name, payload in jobs:
        if args.voice_only:
            targets = sorted(set(payload))
            rows_used = [{"_src": p, "voice": os.path.splitext(os.path.basename(p))[0]} for p in targets]
        else:
            rows_used = payload
        out_sub = os.path.join(args.out_dir, safe_name(sp_name))
        os.makedirs(out_sub, exist_ok=True)

        st = {"speaker": sp_name, "lines": len(rows_used), "built": 0, "seconds": 0.0,
              "skipped_missing": 0, "skipped_short": 0, "skipped_error": 0, "errors": []}
        used = set()
        n_done = 0
        for r in rows_used:
            if args.limit and n_done >= args.limit:
                break
            v = r.get("voice")
            src = r.get("_src") or (idx.get(str(v).lower()) if v else None)
            if not src:
                st["skipped_missing"] += 1
                continue
            if src in used:
                continue
            used.add(src)
            stem = safe_name(f"{r.get('scene', 'x')}_{os.path.splitext(os.path.basename(src))[0]}")
            dst = os.path.join(out_sub, stem)
            try:
                segs, secs = convert_one(src, dst, args.sample_rate, args.min_sec, args.max_sec)
                st["built"] += segs
                st["seconds"] = round(st["seconds"] + secs, 2)
                n_done += 1
            except ValueError as e:
                if "短于下限" in str(e):
                    st["skipped_short"] += 1
                else:
                    st["skipped_error"] += 1
                    if len(st["errors"]) < 5:
                        st["errors"].append(f"{os.path.basename(src)}: {e}")
            except Exception as e:                      # noqa: BLE001
                st["skipped_error"] += 1
                if len(st["errors"]) < 5:
                    st["errors"].append(f"{os.path.basename(src)}: {type(e).__name__}: {e}")
        st["out_dir"] = out_sub
        st["minutes"] = round(st["seconds"] / 60, 1)
        stats["speakers"].append(st)
        stats["built"] += st["built"]
        stats["seconds"] = round(stats["seconds"] + st["seconds"], 2)

    stats["minutes"] = round(stats["seconds"] / 60, 1)
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
        stats["report"] = args.report
    print(json.dumps(stats, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
