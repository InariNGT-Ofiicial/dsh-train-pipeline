#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
krkr_parse.py —— 从 KiriKiri(krkr) 引擎的剧本 JSON 里抽出「说话人 / 台词 / 语音」三元组。

为什么要有这个脚本：
    解包本身只能拿到「一堆 .ogg + 一堆加密 .scn」，真正费人工的是把
    「哪一句是哪个角色说的、对应哪个 ogg」对上。这个脚本把这一步做成启发式全自动。

输入：
    --scn-dir    FreeMote(PsbDecompile) 反编译后的目录，里面有若干 .json
    --voice-dir  可选。解包出来的语音目录，用于统计命中率

输出：
    --out       lines.jsonl，每行 {"speaker","text","voice","scene","src"}
    --report    统计报告 JSON（角色 × 句数 × 有语音句数 + 语音命中率）

设计取舍：
    不同游戏的 PSB 结构差别很大，写死某个游戏的键名只能覆盖一款。
    所以这里用「键名候选集 + 结构启发」，宁可多抓也不要漏；抓错的样本会在
    报告里以 speaker 为空/异常值暴露出来，交给人工或后续规则修。

用法：
    python krkr_parse.py --scn-dir X:/unpack/scn --out lines.jsonl --report report.json
    python krkr_parse.py --scn-dir X:/unpack/scn --list-speakers
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

TEXT_KEYS = (
    "text", "Text", "TEXT", "message", "Message", "msg", "serif", "Serif",
    "dialogue", "body", "Body", "content",
)
SPEAK_KEYS = (
    "name", "Name", "speaker", "Speaker", "chara", "Chara", "character",
    "Character", "who", "Who", "npc", "actor",
)
VOICE_KEYS = (
    "voice", "Voice", "vofile", "vofileName", "voicefile", "voiceFile",
    "vo", "Vo", "sound", "Sound", "storage", "Storage",
)
VOICE_INNER = ("file", "File", "name", "Name", "storage", "Storage", "path", "Path", "id", "Id")

# 文本里常见的控制符/装饰符：不影响人工核对，但会污染后续按文本去重
CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\u200b\ufeff]")
DECO_RE = re.compile(r"[~～♪★☆♡♥…・]+")


def load_json(path: str):
    for enc in ("utf-8-sig", "utf-8", "gbk", "cp932"):
        try:
            with open(path, "r", encoding=enc) as f:
                return json.load(f)
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    return None


def iter_dicts(node, depth=0, max_depth=40):
    """深度优先遍历出所有 dict（带深度上限，防止异常结构爆栈）。"""
    if depth > max_depth:
        return
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from iter_dicts(v, depth + 1, max_depth)
    elif isinstance(node, list):
        for v in node:
            yield from iter_dicts(v, depth + 1, max_depth)


def norm_speaker(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (int, float)):
        return ""
    s = str(v).strip()
    s = re.sub(r"\s+", " ", s)
    # 明显不是人名的：纯数字、过长、含路径分隔符
    if not s or len(s) > 24 or "/" in s or "\\" in s:
        return ""
    return s


def norm_voice(v):
    """语音字段可能是 str / int / dict，统一成可匹配的字符串或 id 标记。"""
    if v is None or isinstance(v, bool):
        return None, None
    if isinstance(v, (int, float)):
        return None, int(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None, None
        s = s.replace("\\", "/").split("/")[-1]
        s = re.sub(r"\.(ogg|wav|mp3|flac|opus)$", "", s, flags=re.I)
        if re.fullmatch(r"\d+", s):
            return None, int(s)
        return s, None
    if isinstance(v, dict):
        for k in VOICE_INNER:
            if k in v:
                got, vid = norm_voice(v[k])
                if got or vid is not None:
                    return got, vid
    return None, None


def clean_text(v) -> str:
    if v is None or isinstance(v, (int, float, dict, list)):
        return ""
    s = str(v)
    s = CTRL_RE.sub("", s)
    s = s.replace("\r\n", "\n").replace("\r", "\n").replace("\n", " ")
    s = re.sub(r"[ \t]{2,}", " ", s).strip()
    return s


def first_present(d: dict, keys):
    for k in keys:
        if k in d and d[k] not in (None, "", [], {}):
            return d[k], k
    return None, None


def extract_from_node(d: dict):
    """从一个 dict 里抽三元组；不是台词节点就返回 None。"""
    text_v, _ = first_present(d, TEXT_KEYS)
    text = clean_text(text_v)
    if not text:
        return None
    name_v, _ = first_present(d, SPEAK_KEYS)
    voice_v, _ = first_present(d, VOICE_KEYS)
    voice, voice_id = norm_voice(voice_v)
    speaker = norm_speaker(name_v)
    # 有文本但既没说话人也没语音 → 大概率是旁白/系统文本/UI 文案，丢掉
    if not speaker and not voice and voice_id is None:
        return None
    return {
        "speaker": speaker,
        "text": text,
        "voice": voice,
        "voice_id": voice_id,
    }


def scene_name_from_path(path: str) -> str:
    base = os.path.basename(path)
    base = re.sub(r"\.(json|resx\.json|ks|ksd)$", "", base, flags=re.I)
    base = re.sub(r"\.json$", "", base, flags=re.I)
    return base


# ══════════════════════════════════════════════════════════════════════════
# KAG3 明文剧本（.ks）解析
#
# 为什么必须有这一支：KiriKiri 2 / KAG3（2000 年代绝大多数 galgame）的剧本
# 是**明文文本**，没有 .psb 要反编译，也没有 JSON。只有新一些的 KiriKiri Z
# 才是 .scn/.psb。之前只认 JSON，等于把一整个时代的游戏全部漏掉 ——
# 这是拿真游戏跑出来的结论，不是推测。
#
# 编码：KAG3 时代几乎全是 Shift_JIS（CP932）。我们的测试样本第一部游戏就是。
# ══════════════════════════════════════════════════════════════════════════

# 只有 .ks 是剧本。.ksd 看着像，其实是 savedata/ 下的**存档**（真机样本里就有 3 个），
# 当文本读会解出一堆控制字符，还会让编码探测误判成 utf-16。
KS_EXT = (".ks",)
KS_ENCODINGS = ("utf-8-sig", "utf-8", "cp932", "euc-jp", "gbk", "utf-16")

# 标签/属性：KAG3 的标签是 [cmd attr=值 ...]，值可能带引号也可能不带
TAG_RE = re.compile(r"\[([^\[\]]*)\]")
ATTR_RE = re.compile(r"([A-Za-z_][\w]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\]]+))")
CMD_RE = re.compile(r"^([A-Za-z_][\w\-]*)")

VOICE_CMDS = {"voice", "playvoice", "wvoice", "voiceplay", "vo"}
SOUND_CMDS = {"playse", "se", "playseonce", "wse"}
SPRITE_CMDS = {"image", "pimage", "ch_crossfade", "charset", "graphload", "gf_crossfade", "fg", "chara"}
# 明显的「非角色」立绘/遮罩命名：见到就清掉推测出的说话人
NON_CHARACTER_RE = re.compile(r"^(stc|bg|bgimage|window|frame|mask|non)", re.I)
CHAR_FILE_RE = re.compile(r"^(?:char|chr|ch)_([A-Za-z0-9]+)", re.I)


def decode_text(path: str):
    """按 KAG3 时代真实出现的编码顺序试，返回 (文本, 命中编码)。"""
    try:
        raw = open(path, "rb").read()
    except OSError:
        return None, ""
    for enc in KS_ENCODINGS:
        try:
            return raw.decode(enc), enc
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("cp932", "replace"), "cp932(replace)"


def parse_tag(body: str):
    """[cmd a="b" c=1] → ('cmd', {'a': 'b', 'c': '1'})"""
    body = body.strip()
    if not body.startswith("@"):
        m = CMD_RE.match(body)
        if not m:
            return "", {}
        cmd = m.group(1)
        rest = body[m.end():]
    else:
        m = CMD_RE.match(body[1:].strip())
        if not m:
            return "", {}
        cmd = m.group(1)
        rest = body[1:].strip()[m.end():]
    attrs = {}
    for am in ATTR_RE.finditer(rest):
        val = am.group(2)
        if val is None:
            val = am.group(3)
        if val is None:
            val = am.group(4)
        attrs[am.group(1).lower()] = val
    return cmd.lower(), attrs


def clean_ks_text(s: str) -> str:
    """去掉正文里的残留控制符。行内标签已在切分时移除。"""
    s = s.replace("\u3000", " ").replace("\t", " ")
    s = re.sub(r"\[[^\[\]]*\]", "", s)          # 兜底：残留标签
    s = s.replace("[", "").replace("]", "")
    s = s.replace("\r", " ").replace("\n", " ")
    s = re.sub(r"[ \u00a0]{2,}", " ", s).strip()
    # 去掉首尾的连字符/标记符
    s = s.strip("|>＜ ")
    return s


INLINE_NAME_RE = re.compile(r"^([^\s「」『』]{1,10})[「『](.+)[」』]$")

# 菜单/逻辑行：选项、跳转、求值。它们里面也有「」，但绝不是台词。
MENU_LINE_RE = re.compile(r"\[(link\d*|endlink\d*|select|endselect|emb|eval|jump|macro)", re.I)


def is_plausible_name(s: str) -> bool:
    """判断「引号前面那一段」到底像不像人名。
    真机样本里出现过两种误判：
      「ネイアー艦隊第13小隊「アーギュス」」← 菜单项，带数字
      「兵士の間ではWWUは「ウォーニット」」← 旁白，以助词结尾
    宁可漏掉几个奇怪的昵称，也不能把旁白挂到一个假人名上 ——
    说错人比没人更糟，错标签会直接污染训练集。
    """
    if not s or len(s) > 10:
        return False
    if re.search(r"\d", s):
        return False
    if s[-1] in "はがをにでとものへや、。！？!?」』：:":
        return False
    if re.search(r"(では|には|のは|って|という|という|から|まで|より)", s):
        return False
    return True


def parse_ks(path: str, scene: str, stats: dict, sprite_speakers: bool = False):
    text, enc = decode_text(path)
    if text is None:
        stats["bad_files"] += 1
        stats["bad_samples"].append(os.path.basename(path))
        return []
    # 二进制护栏：utf-16 之类几乎不会解码失败，二进制文件会「成功」解出一堆控制字符。
    # 与其把它当文本抽出满屏垃圾，不如当场认出来跳过。
    head = text[:4000]
    if head:
        ctrl = sum(1 for c in head if ord(c) < 32 and c not in "\r\n\t")
        if ctrl / len(head) > 0.05:
            stats["binary_skipped"] += 1
            stats["binary_samples"].append(os.path.basename(path))
            return []

    stats["encodings"][enc] = stats["encodings"].get(enc, 0) + 1

    rows = []
    cur_speaker = ""
    inferred = ""
    pending_voice = None
    pending_source = ""
    for raw in text.splitlines():
        line = raw.lstrip("\ufeff").rstrip()
        if not line.strip():
            continue
        s = line.strip()
        if s.startswith(";") or s.startswith("*") or s.startswith("#"):
            continue   # 注释 / 标签 / 顶层指令

        if MENU_LINE_RE.search(line):
            stats["menu_lines"] += 1
            continue   # 选项/跳转/求值：不是台词

        for body in TAG_RE.findall(line):
            cmd, attrs = parse_tag(body)
            if not cmd:
                continue
            if cmd in ("name",):
                nm = attrs.get("name") or attrs.get("text") or ""
                if not nm:
                    # [name 芳乃] 这种裸写法
                    m = re.match(r"^name\s+(\S+)$", body.strip(), re.I)
                    nm = m.group(1) if m else ""
                if nm:
                    cur_speaker = norm_speaker(nm)
            elif cmd in VOICE_CMDS or cmd in SOUND_CMDS:
                storage = attrs.get("storage") or attrs.get("filename") or ""
                if storage:
                    got, vid = norm_voice(storage)
                    if cmd in VOICE_CMDS:
                        pending_voice, pending_source = (got, vid), "tag"
                        stats["voice_refs"] += 1
                    else:
                        stats["sound_refs"] += 1
                        # playse 也可能被某些游戏拿来播语音：只在文件名像语音时采纳
                        if looks_like_voice_name(storage):
                            pending_voice, pending_source = (got, vid), "playse"
                            stats["voice_refs_from_playse"] += 1
            elif cmd in SPRITE_CMDS and sprite_speakers:
                fn = attrs.get("filename") or attrs.get("storage") or ""
                base = os.path.basename(fn.replace("\\", "/"))
                if not base:
                    continue
                if NON_CHARACTER_RE.match(base):
                    inferred = ""
                else:
                    m = CHAR_FILE_RE.match(base)
                    if m:
                        inferred = m.group(1)

        body = clean_ks_text(TAG_RE.sub("", line))
        if not body:
            continue
        # 明显不是台词：纯符号/纯数字/UI 占位
        if not re.search(r"[^\W\d_]", body, re.UNICODE):
            continue
        stats["text_lines"] += 1

        speaker = cur_speaker
        source = "tag" if speaker else ""
        m = INLINE_NAME_RE.match(body)
        if m:
            prefix, quoted = m.group(1), m.group(2).strip()
            ok_name = is_plausible_name(prefix)
            # 术语表也会写成「用語集「ミーミアー」」，和「名前「台词」」长得一模一样。
            # 区别只剩内容：台词通常够长、或带句读。宁可漏掉极短的一句（那种句子
            # 太短，本来也会被 build 阶段的 min_sec 过滤掉），也不要写错人。
            ok_body = len(quoted) >= 6 or bool(re.search(r"[。、！？…!?]", quoted))
            if ok_name and ok_body:
                speaker = norm_speaker(prefix)
                body = quoted
                source = "inline" if speaker else ""
            else:
                # 形如 X「Y」但 X 不像人名 → 这是标签/术语/说明文字，不是台词。
                # 绝不能退回 cur_speaker：那会把上一句的说话人硬安到它头上。
                stats["inline_rejected"] += 1
                pending_voice, pending_source = None, ""
                continue
        if not speaker and inferred:
            speaker = norm_speaker(inferred)
            source = "sprite" if speaker else ""
        if not speaker:
            source = ""

        voice, voice_id = pending_voice if pending_voice else (None, None)
        vsource = pending_source if pending_voice else ""
        pending_voice, pending_source = None, ""

        # 既没说话人也没语音 → 旁白/系统文本/菜单项，语音数据集用不上
        if not speaker and not voice and voice_id is None:
            continue

        row = {
            "speaker": speaker,
            "text": body,
            "voice": voice,
            "voice_id": voice_id,
            "scene": scene,
            "src": os.path.basename(path),
            "speaker_source": source,
            "voice_source": vsource,
        }
        if speaker:
            stats["with_speaker"] += 1
        if voice or voice_id is not None:
            stats["with_voice"] += 1
        rows.append(row)
    return rows


def looks_like_voice_name(name: str) -> bool:
    """playse 里哪些名字更像语音而不是音效。
    宁可漏判也不要误判：误判会把 BGM/SE 当成「这句台词的语音」写进数据集。
    """
    n = os.path.basename(str(name).replace("\\", "/")).lower()
    n = re.sub(r"\.[a-z0-9]+$", "", n)
    if re.search(r"(^|[_\-\s])(bgm|se|snd|sound|eff|efect|effect|sys|click|bomb)", n):
        return False
    return bool(re.search(r"(voice|^v[_\-\d]|[_\-\]v\d{2,3}$|_v[0-9]{3}$)", n))


def parse_file(path: str, scene: str, stats: dict):
    data = load_json(path)
    if data is None:
        stats["bad_files"] += 1
        stats["bad_samples"].append(os.path.basename(path))
        return []
    rows = []
    seen = set()
    for d in iter_dicts(data):
        row = extract_from_node(d)
        if not row:
            continue
        # 同一节点被父子遍历重复命中的情况：用 (speaker, text, voice) 去重
        key = (row["speaker"], row["text"][:120], row["voice"], row["voice_id"])
        if key in seen:
            continue
        seen.add(key)
        row["scene"] = scene
        row["src"] = os.path.basename(path)
        rows.append(row)
    stats["nodes"] += len(rows)
    return rows


def build_voice_index(voice_dir: str):
    idx = {}
    for root, _dirs, files in os.walk(voice_dir):
        for f in files:
            stem = re.sub(r"\.[^.]+$", "", f).lower()
            idx.setdefault(stem, os.path.join(root, f))
            idx.setdefault(os.path.basename(root).lower() + "/" + stem, os.path.join(root, f))
    return idx


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="KiriKiri 剧本文本/语音三元组抽取")
    ap.add_argument("--scn-dir", required=True, help="剧本目录：反编译后的 JSON，或 KAG3 明文 .ks（两者可混放）")
    ap.add_argument("--voice-dir", default="", help="可选：语音目录，用于统计命中率")
    ap.add_argument("--out", default="", help="lines.jsonl 输出路径")
    ap.add_argument("--report", default="", help="统计报告 JSON 输出路径")
    ap.add_argument("--list-speakers", action="store_true", help="只打印角色列表")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出到 stdout（供插件解析）")
    ap.add_argument(
        "--sprite-speakers", action="store_true",
        help="无 [name] 标签时，用立绘文件名（char_XXX）推测说话人。推测项会标 speaker_source=sprite，"
             "数据集默认不该采用它",
    )
    args = ap.parse_args(argv)

    if not os.path.isdir(args.scn_dir):
        print(json.dumps({"ok": False, "error": f"scn 目录不存在: {args.scn_dir}"}, ensure_ascii=False))
        return 2

    stats = {
        "scn_files": 0, "bad_files": 0, "bad_samples": [], "nodes": 0,
        "ks_files": 0, "encodings": {}, "text_lines": 0, "menu_lines": 0,
        "with_speaker": 0, "with_voice": 0, "inline_rejected": 0,
        "binary_skipped": 0, "binary_samples": [],
        "voice_refs": 0, "sound_refs": 0, "voice_refs_from_playse": 0,
    }
    all_rows = []
    for root, _dirs, files in os.walk(args.scn_dir):
        for f in sorted(files):
            low = f.lower()
            p = os.path.join(root, f)
            if low.endswith(KS_EXT):
                stats["ks_files"] += 1
                all_rows.extend(parse_ks(p, scene_name_from_path(p), stats, args.sprite_speakers))
                continue
            if not low.endswith(".json") or ".resx" in low:
                continue
            stats["scn_files"] += 1
            all_rows.extend(parse_file(p, scene_name_from_path(p), stats))

    by_speaker = defaultdict(lambda: {"lines": 0, "with_voice": 0, "sources": Counter()})
    for r in all_rows:
        sp = r["speaker"] or "(无说话人)"
        by_speaker[sp]["lines"] += 1
        if r["voice"] or r["voice_id"] is not None:
            by_speaker[sp]["with_voice"] += 1
        src = r.get("speaker_source") or ""
        if src:
            by_speaker[sp]["sources"][src] += 1

    hit = {"checked": 0, "matched": 0, "missing_samples": []}
    if args.voice_dir and os.path.isdir(args.voice_dir):
        idx = build_voice_index(args.voice_dir)
        for r in all_rows:
            if not r["voice"]:
                continue
            hit["checked"] += 1
            if r["voice"].lower() in idx:
                hit["matched"] += 1
            elif len(hit["missing_samples"]) < 20:
                hit["missing_samples"].append(r["voice"])

    speakers = [
        {
            "speaker": k, "lines": v["lines"], "with_voice": v["with_voice"],
            # 这个角色的名字是「剧本明确写的」还是「推测的」，必须分开显示
            "source": (v["sources"].most_common(1)[0][0] if v["sources"] else ""),
        }
        for k, v in sorted(by_speaker.items(), key=lambda kv: -kv[1]["with_voice"])
    ]

    by_source = Counter(r.get("speaker_source", "") for r in all_rows if r.get("speaker"))

    report = {
        "ok": True,
        "scn_dir": args.scn_dir,
        "scn_files": stats["scn_files"],
        "ks_files": stats["ks_files"],
        "encodings": stats["encodings"],
        "text_lines": stats["text_lines"],
        "menu_lines": stats["menu_lines"],
        "inline_rejected": stats["inline_rejected"],
        "binary_skipped": stats["binary_skipped"],
        "binary_samples": stats["binary_samples"][:10],
        "sound_refs": stats["sound_refs"],
        "voice_refs": stats["voice_refs"],
        "voice_refs_from_playse": stats["voice_refs_from_playse"],
        "bad_files": stats["bad_files"],
        "bad_samples": stats["bad_samples"][:10],
        "lines": len(all_rows),
        "with_voice": sum(1 for r in all_rows if r["voice"] or r["voice_id"] is not None),
        "speakers": speakers,
        # 说话人推断来源：tag=剧本明确写了名字；inline=「名前「台词」」写法；sprite=靠立绘文件名猜
        "speaker_sources": dict(by_source),
        "voice_hit": hit,
    }

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            for r in all_rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        report["out"] = args.out
    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        report["report"] = args.report

    if args.list_speakers:
        for s in speakers:
            print(f"{s['speaker']}\t{s['lines']}\t{s['with_voice']}")
        return 0

    if args.json or args.out:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
