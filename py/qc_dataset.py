#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qc_dataset.py —— 数据集质量门。

DDSP 训练不会因为坏样本报错，它只会**默默学坏**。所以坏样本必须在这里被拦下：
  · 采样率/声道不对 → 特征与配置错位
  · 削波（峰值贴 0dBFS）→ 模型学着发出嘶声
  · 静音占比过高 → 学出一堆空白
  · 太短（< duration）→ 预处理直接崩
  · 重复段 → 过拟合那几句话

默认只报告；--apply 才把不合格文件移到 _rejected/（不删）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys

import numpy as np

try:
    import soundfile as sf
except ImportError:
    print(json.dumps({"ok": False, "error": "缺少 soundfile"}, ensure_ascii=False))
    sys.exit(2)


def analyze(path: str):
    info = sf.info(path)
    sr, ch, frames = info.samplerate, info.channels, info.frames
    dur = frames / sr if sr else 0.0
    out = {"path": path, "file": os.path.basename(path), "sr": sr, "channels": ch,
           "seconds": round(dur, 2), "peak_dbfs": None, "silence_ratio": None,
           "clipped": False, "reasons": []}
    try:
        y, _ = sf.read(path, always_2d=True, dtype="float32")
        mono = y.mean(axis=1)
        peak = float(np.max(np.abs(mono))) if mono.size else 0.0
        out["peak_dbfs"] = round(20 * np.log10(peak + 1e-12), 1)
        if peak >= 0.9995:
            out["clipped"] = True
        frame = max(1, int(sr * 0.02))
        n = len(mono) // frame
        if n:
            rms = np.sqrt(np.mean(mono[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
            db = 20 * np.log10(rms + 1e-12)
            out["silence_ratio"] = round(float(np.mean(db < -45)), 3)
    except Exception as e:                                  # noqa: BLE001
        out["reasons"].append(f"读取失败: {type(e).__name__}")
    return out


def fingerprint(path: str):
    """粗指纹：时长 + 文件大小 + 前 64KB 的哈希，用来抓重复导入的同一句。"""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(65536)
        return f"{size}:{hashlib.md5(head).hexdigest()}"
    except Exception:                                        # noqa: BLE001
        return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="DDSP 数据集质量门")
    ap.add_argument("--dir", required=True, help="数据集目录（含 wav，可递归）")
    ap.add_argument("--sample-rate", type=int, default=44100)
    ap.add_argument("--min-sec", type=float, default=3.0)
    ap.add_argument("--max-sec", type=float, default=15.0)
    ap.add_argument("--silence-max", type=float, default=0.35, help="静音占比上限")
    ap.add_argument("--apply", action="store_true", help="把不合格文件移到 _rejected/")
    ap.add_argument("--report", default="")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.dir):
        print(json.dumps({"ok": False, "error": f"目录不存在: {args.dir}"}, ensure_ascii=False))
        return 2

    files = []
    for root, _dirs, fs in os.walk(args.dir):
        if os.path.basename(root) == "_rejected":
            continue
        for f in sorted(fs):
            if f.lower().endswith(".wav"):
                files.append(os.path.join(root, f))

    items = [analyze(p) for p in files]
    seen = {}
    dupes = []
    for it in items:
        fp = fingerprint(it["path"])
        if fp and fp in seen:
            dupes.append(it["path"])
            it["reasons"].append("重复片段")
        elif fp:
            seen[fp] = it["path"]

    for it in items:
        if it["sr"] != args.sample_rate:
            it["reasons"].append(f"采样率 {it['sr']}≠{args.sample_rate}")
        if it["channels"] != 1:
            it["reasons"].append(f"声道数 {it['channels']}≠1")
        if it["seconds"] < args.min_sec:
            it["reasons"].append(f"过短 {it['seconds']}s<{args.min_sec}s")
        if it["seconds"] > args.max_sec:
            it["reasons"].append(f"过长 {it['seconds']}s>{args.max_sec}s")
        if it["clipped"]:
            it["reasons"].append("削波")
        if it["silence_ratio"] is not None and it["silence_ratio"] > args.silence_max:
            it["reasons"].append(f"静音过多 {it['silence_ratio']}")

    bad = [it for it in items if it["reasons"]]
    good = [it for it in items if not it["reasons"]]
    total_sec = sum(it["seconds"] for it in items)
    good_sec = sum(it["seconds"] for it in good)

    buckets = {"<min": 0, "ok": 0, ">max": 0}
    for it in items:
        buckets["<min" if it["seconds"] < args.min_sec else ">max" if it["seconds"] > args.max_sec else "ok"] += 1

    moved = []
    if args.apply and bad:
        rej = os.path.join(args.dir, "_rejected")
        os.makedirs(rej, exist_ok=True)
        for it in bad:
            try:
                dst = os.path.join(rej, it["file"])
                shutil.move(it["path"], dst)
                moved.append(dst)
            except Exception:                                # noqa: BLE001
                pass

    report = {
        "ok": len(good) > 0,
        "dir": args.dir,
        "files": len(items),
        "good": len(good),
        "bad": len(bad),
        "duplicates": len(dupes),
        "total_minutes": round(total_sec / 60, 1),
        "good_minutes": round(good_sec / 60, 1),
        "duration_buckets": buckets,
        "reason_counts": dict((r, sum(1 for it in bad if r in " ".join(it["reasons"])))
                              for r in ["削波", "重复片段", "静音过多", "过短", "过长"]),
        "bad_samples": [{"file": it["file"], "reasons": it["reasons"]} for it in bad[:20]],
        "moved": len(moved),
    }
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        report["report"] = args.report
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["good"] else 1


if __name__ == "__main__":
    sys.exit(main())
