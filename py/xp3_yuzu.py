"""柚子社 Cxdec 加密封包的**静态**解包（不需要跑游戏、不需要 GUI）。

适用范围：千恋＊万花（SenrenCxCrypt）这一代 KrKrZ + 自定义 xp3 加密。
它解决的是通用解包器（arc_unpacker 的 noop/xor/dieselmine）打不开的那类封包：

    索引 = 0x80 间接指针 → zlib 压缩 → 文件名是 32 位 hex 哈希（真名在 'sen:' 段）
    内容 = CxProgram 字节码虚拟机生成的异或流（每文件用自己的 adlr hash）
          + 两段分割（分界 = (hash & mask) + offset）

两个外部依赖（都不是"本机配置"，而是可指定的输入）：
    1. 一份 GARbro 的 Formats.dat（里面有该游戏的 mask/offset/顺序表/4KB 控制块）
    2. Python 标准库即可，无需装包

用法：
    python xp3_yuzu.py probe   --archive <data.xp3>
    python xp3_yuzu.py extract --archive <data.xp3> --out <dir> [--only 正则] [--all] [--dry]

输出：最后一行是 JSON（给上层解析），其余是进度。
"""
import argparse
import glob
import json
import os
import re
import struct
import sys
import zlib

XP3_MAGIC = b'XP3\r\n \n\x1a\x8bg\x01'
AUDIO_EXT = ('.ogg', '.opus', '.wav', '.mp3', '.flac', '.m4a')


# ── xp3 索引 ──────────────────────────────────────────────────────────
def read_index(path):
    """返回 (entries, name_ptr, meta)。entries 里带 real（还原后的文件名，可能为空）。"""
    with open(path, 'rb') as f:
        head = f.read(0x30)
        if head[:11] != XP3_MAGIC:
            raise ValueError('不是 xp3（magic 不符）')
        ptr = struct.unpack_from('<q', head, 0x0b)[0]
        indirect = struct.unpack_from('<I', head, ptr)[0] == 0x80
        if indirect:
            ptr = struct.unpack_from('<q', head, ptr + 9)[0]
        f.seek(ptr)
        h = f.read(32)
        typ = h[0]
        if typ == 0:
            size = struct.unpack_from('<q', h, 1)[0]
            f.seek(ptr + 9)
            blob = f.read(size)
        elif typ == 1:
            packed = struct.unpack_from('<q', h, 1)[0]
            f.seek(ptr + 17)
            blob = zlib.decompress(f.read(packed))
        else:
            raise ValueError('未知的索引类型 %r（可能不是 KrKrZ 封包）' % typ)

        entries = []
        names_ptr = None
        pos = 0
        while pos + 12 <= len(blob):
            sig, size = struct.unpack_from('<Iq', blob, pos)
            pos += 12
            if size < 0 or pos + size > len(blob):
                break
            body = blob[pos:pos + size]
            pos += size
            if sig == 0x656C6946:                       # 'File'
                e = {'hash': None, 'name': '', 'enc': False, 'size': 0,
                     'packed': 0, 'off': 0, 'compressed': False}
                p = 0
                while p + 12 <= len(body):
                    tag, ssz = struct.unpack_from('<Iq', body, p)
                    p += 12
                    sec = body[p:p + ssz]
                    p += ssz
                    if tag == 0x6f666e69:               # 'info'
                        e['enc'] = struct.unpack_from('<I', sec, 0)[0] != 0
                        e['size'] = struct.unpack_from('<q', sec, 4)[0]
                        e['packed'] = struct.unpack_from('<q', sec, 12)[0]
                        nlen = struct.unpack_from('<H', sec, 20)[0]
                        e['name'] = sec[22:22 + nlen * 2].decode('utf-16-le', 'replace')
                    elif tag == 0x6d676573:             # 'segm'
                        comp, off, sz, psz = struct.unpack_from('<iqqq', sec, 0)
                        e['compressed'] = comp != 0
                        e['off'], e['size'], e['packed'] = off, sz, psz
                    elif tag == 0x726c6461 and ssz == 4:  # 'adlr'
                        e['hash'] = struct.unpack_from('<I', sec, 0)[0]
                entries.append(e)
            elif (sig >> 24) == 0x3A:                   # 'sen:' / 'yuz:' / 'dls:'
                names_ptr = struct.unpack_from('<qII', body, 0)
            # 其它段（Hxv4 的 'Hxv4' 等）本模块不处理

        lut = {}
        if names_ptr:
            off, _unpacked, size = names_ptr
            f.seek(off)
            raw = zlib.decompress(f.read(size))
            p = 0
            while p + 12 <= len(raw):
                _sig, esz = struct.unpack_from('<Iq', raw, p)
                if esz < 0:
                    break
                hv, nsz = struct.unpack_from('<Ih', raw, p + 12)
                if nsz > 0:
                    lut[hv] = raw[p + 18:p + 18 + nsz * 2].decode('utf-16-le', 'replace')
                p += 12 + esz

        for e in entries:
            e['real'] = lut.get(e['hash']) or (e['name'] if e['name'] and not re.fullmatch(r'[0-9a-fA-F]{32}', e['name']) else '')

    meta = {'indirect_index': indirect, 'header_type': typ,
            'index_ptr': ptr, 'entries': len(entries),
            'named': sum(1 for e in entries if e['real']),
            'name_table': len(lut)}
    return entries, meta


# ── 方案参数（mask/offset/顺序表/控制块）──────────────────────────────
def formats_candidates(explicit='', tools_dir=''):
    out = []
    if explicit:
        out.append(explicit)
    for env in ('DSH_FORMATS_DAT', 'GARBRO_FORMATS_DAT'):
        v = os.environ.get(env)
        if v:
            out.append(v)
    root = os.environ.get('GARBRO_ROOT', '')
    if root:
        out.append(os.path.join(root, 'GameData', 'Formats.dat'))
    if tools_dir:
        for pat in ('*/GameData/Formats.dat', '*/garbro*/GameData/Formats.dat',
                    'garbro*/GameData/Formats.dat'):
            out.extend(sorted(glob.glob(os.path.join(tools_dir, pat))))
    return [p for p in out if p and os.path.isfile(p)]


def load_formats(path):
    d = open(path, 'rb').read()
    if not d[:8] == b'GARbroDB':
        raise ValueError('不是 GARbro 的 Formats.dat（GARbroDB 头不符）')
    return zlib.decompress(d[12:])


# ── 用「解出来得像那么回事」来选方案 ─────────────────────────────────
# ★ 这一步不能省：Formats.dat 里有十几个 CxScheme，随便挑一个也能"解密"，
#   只是解出来全是乱码 —— 静默错误比报错危险得多。
MAGIC = {
    '.ogg': b'OggS', '.opus': b'OggS', '.wav': b'RIFF',
    '.png': b'\x89PNG', '.jpg': b'\xff\xd8\xff',
    '.tlg': b'TLG', '.psb': b'PSB', '.scn': b'PSB',
    '.mtn': b'MTN', '.asd': b'ASD',
}


_BAD_CHARS = re.compile(r'[<>:"|?*\x00-\x1f]')
_RESERVED = {'CON', 'PRN', 'AUX', 'NUL'} | {f'COM{i}' for i in range(1, 10)} | {f'LPT{i}' for i in range(1, 10)}


def safe_rel(name):
    """把封包里的路径变成 Windows 能落盘的相对路径。

    ★ 真机踩到过：柚子社在封包里塞了名字形如
      `data\\$$$ This is a protected archive. $$$ 著作者は…（长）.txt`
      的**诱饵条目** —— 名字里带反斜杠、冒号、超长日文，直接 open 会抛 WinError 123。
      一个坏名字不该让整包解包失败。
    """
    if re.search(r'protected archive|\$\$\$', name):
        return ''
    parts = []
    for seg in re.split(r'[\\/]+', name):
        seg = _BAD_CHARS.sub('_', seg).strip().rstrip('. ')
        if not seg or seg in ('.', '..'):
            continue
        if seg.split('.')[0].upper() in _RESERVED:
            seg = '_' + seg
        parts.append(seg)
    if not parts:
        return ''
    rel = os.path.join(*parts)
    if len(rel) > 180:
        stem, ext = os.path.splitext(rel)
        rel = stem[:150] + '_%06d' % (abs(hash(name)) % 1000000) + ext[:10]
    return rel


def iter_schemes(formats_raw):
    """枚举 Formats.dat 里所有结构完整的 CxScheme。"""
    for i in range(0, len(formats_raw) - 40, 4):
        if formats_raw[i + 8] != 0x09 or formats_raw[i + 13] != 0x09:
            continue
        ids = []
        p = i + 8
        try:
            for _ in range(4):
                if formats_raw[p] != 0x09:
                    raise ValueError
                ids.append(struct.unpack_from('<i', formats_raw, p + 1)[0])
                p += 5
        except Exception:
            continue
        arrs, ok = [], True
        for oid in ids:
            j = formats_raw.find(b'\x0f' + struct.pack('<i', oid))
            if j < 0:
                ok = False
                break
            ln, pt = struct.unpack_from('<iB', formats_raw, j + 5)
            unit = {2: 1, 15: 4}.get(pt, 4)
            arrs.append(formats_raw[j + 10:j + 10 + ln * unit])
        if not ok or len(arrs) != 4 or len(arrs[3]) != 4096:
            continue
        yield {
            'mask': struct.unpack_from('<I', formats_raw, i)[0],
            'offset': struct.unpack_from('<I', formats_raw, i + 4)[0],
            'prolog_order': list(arrs[0]), 'odd_order': list(arrs[1]),
            'even_order': list(arrs[2]),
            'control_block': list(struct.unpack('<1024I', arrs[3])),
            'at': i,
        }


CX_KEYS = ('mask', 'offset', 'prolog_order', 'odd_order', 'even_order', 'control_block')


def to_crypt(sch):
    """scheme dict 里带调试用的 'at' 键，构造 CxCrypt 前要滤掉。"""
    from cxdec import CxCrypt
    return CxCrypt(**{k: sch[k] for k in CX_KEYS})


def verify_scheme(sch, archive, entries, want=3):
    """拿几个「本该有已知文件头」的条目试解，返回 (命中数, 试了几次)。"""
    crypt = to_crypt(sch)
    probes = []
    for e in entries:
        if not e['enc'] or not e['real']:
            continue
        ext = os.path.splitext(e['real'])[1].lower()
        mg = MAGIC.get(ext)
        if mg and 64 <= e['packed'] <= 4 * 1024 * 1024:
            probes.append((e, mg))
        if len(probes) >= want * 4:
            break
    hit = tried = 0
    with open(archive, 'rb') as f:
        for e, mg in probes:
            if tried >= want:
                break
            f.seek(e['off'])
            raw = crypt.decrypt(e['hash'], f.read(min(e['packed'], 64)))
            tried += 1
            if raw.startswith(mg):
                hit += 1
    return hit, tried


def pick_scheme(formats_raw, archive, entries, explicit_mask=None, explicit_offset=None):
    """返回 (scheme, 说明)。给定了 mask/offset 就只验那一个；否则全试一遍。"""
    cands = []
    if explicit_mask is not None and explicit_offset is not None:
        pat = struct.pack('<II', explicit_mask, explicit_offset)
        for i in iter_schemes(formats_raw):
            if i['mask'] == explicit_mask and i['offset'] == explicit_offset:
                cands.append(i)
        if not cands:
            return None, 'Formats.dat 里没有 mask=%#x offset=%#x 的方案' % (explicit_mask, explicit_offset)
    else:
        cands = list(iter_schemes(formats_raw))
    seen = set()
    best = None
    for sch in cands:
        key = (sch['mask'], sch['offset'])
        if key in seen:
            continue
        seen.add(key)
        hit, tried = verify_scheme(sch, archive, entries)
        if hit >= max(1, min(2, tried)):
            return sch, '命中 %d/%d 个样本的文件头' % (hit, tried)
        if best is None or hit > best[1]:
            best = (sch, hit, tried)
    if best:
        return None, '试了 %d 个方案都不对（最好的是 mask=%#x offset=%#x，命中 %d/%d）' % (
            len(seen), best[0]['mask'], best[0]['offset'], best[1], best[2])
    return None, 'Formats.dat 里没有结构完整的 CxScheme'


# ── 主流程 ────────────────────────────────────────────────────────────
def cmd_probe(args):
    out = {'ok': False}
    try:
        entries, meta = read_index(args.archive)
    except Exception as e:
        out['error'] = '索引解析失败: %s' % e
        return out
    out.update(meta)
    out['encrypted'] = sum(1 for e in entries if e['enc'])
    audio = [e for e in entries if (e['real'] or '').lower().endswith(AUDIO_EXT)]
    out['audio'] = len(audio)
    out['audio_bytes'] = sum(e['packed'] for e in audio)

    fmts = formats_candidates(args.formats, args.tools_dir)
    out['formats_candidates'] = fmts[:3]
    if not fmts:
        out['error'] = ('索引能读，但缺一份 GARbro 的 Formats.dat —— 柚子社 Cxdec 的'
                        'mask/offset/控制块在里面。用 --formats 指定，或设 DSH_FORMATS_DAT。')
        return out
    raw = load_formats(fmts[0])
    sch, why = pick_scheme(raw, args.archive, entries, args.mask, args.offset)
    out['scheme_pick'] = why
    if not sch:
        out['error'] = '没有可用的 CxScheme：%s' % why
        return out
    out['scheme'] = {'mask': hex(sch['mask']), 'offset': hex(sch['offset'])}
    out['ok'] = True
    return out


def cmd_extract(args):
    from cxdec import CxCrypt

    entries, meta = read_index(args.archive)
    fmts = formats_candidates(args.formats, args.tools_dir)
    if not fmts:
        return {'ok': False, 'error': '缺 Formats.dat（见 probe 的说明）'}
    sch, why = pick_scheme(load_formats(fmts[0]), args.archive, entries, args.mask, args.offset)
    if not sch:
        return {'ok': False, 'error': '没有可用的 CxScheme：%s' % why}
    crypt = to_crypt(sch)

    rx = re.compile(args.only) if args.only else None
    picked = [e for e in entries if e['real'] and (rx is None or rx.search(e['real']))]
    if not picked:
        return {'ok': False, 'error': '没有条目匹配 %r' % args.only,
                'available_sample': [e['real'] for e in entries[:20]]}
    total = sum(e['packed'] for e in picked)
    if args.dry:
        return {'ok': True, 'dry': True, 'picked': len(picked), 'bytes': total,
                'sample': [e['real'] for e in picked[:10]]}

    done = 0
    failed = []
    decoy = []
    skipped = 0
    with open(args.archive, 'rb') as f:
        for e in picked:
            f.seek(e['off'])
            raw = f.read(e['packed'])
            if e['enc']:
                raw = crypt.decrypt(e['hash'], raw)
            if e['compressed'] and e['packed'] != e['size']:
                try:
                    raw = zlib.decompress(raw)
                except Exception as ex:
                    failed.append([e['real'], 'zlib: %s' % ex])
                    continue
            if e['size'] and len(raw) != e['size']:
                failed.append([e['real'], '尺寸 %d != %d' % (len(raw), e['size'])])
                continue
            rel = safe_rel(e['real'])
            if not rel:
                decoy.append(e['real'][:60])
                continue
            dst = os.path.join(args.out, rel)
            try:
                os.makedirs(os.path.dirname(dst) or args.out, exist_ok=True)
                with open(dst, 'wb') as g:
                    g.write(raw)
            except OSError as ex:
                failed.append([e['real'][:80], 'write: %s' % ex])
                continue
            done += 1
            if done % 500 == 0:
                print('  %d/%d' % (done, len(picked)), file=sys.stderr, flush=True)
    return {'ok': done > 0, 'extracted': done, 'failed': len(failed),
            'failed_sample': failed[:8], 'decoys': decoy[:5], 'out': args.out,
            'bytes': total}


def main():
    ap = argparse.ArgumentParser(description='柚子社 Cxdec 静态解包')
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('probe', 'extract'):
        p = sub.add_parser(name)
        p.add_argument('--archive', required=True)
        p.add_argument('--formats', default='', help='GARbro 的 Formats.dat')
        p.add_argument('--tools-dir', default='', help='在这些目录下找 *garbro*/GameData/Formats.dat')
        p.add_argument('--mask', type=lambda x: int(x, 0), default=None)
        p.add_argument('--offset', type=lambda x: int(x, 0), default=None)
        if name == 'extract':
            p.add_argument('--out', required=True)
            p.add_argument('--only', default='', help='只解匹配这个正则的路径，如 "^voice/"')
            p.add_argument('--dry', action='store_true')
    args = ap.parse_args()

    try:
        res = cmd_probe(args) if args.cmd == 'probe' else cmd_extract(args)
    except Exception as e:                              # noqa: BLE001
        import traceback
        res = {'ok': False, 'error': '%s: %s' % (type(e).__name__, e),
               'trace': traceback.format_exc(limit=3)}
    print(json.dumps(res, ensure_ascii=False))
    return 0 if res.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
