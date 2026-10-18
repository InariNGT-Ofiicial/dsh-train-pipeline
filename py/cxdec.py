"""柚子社 CxDec 解密（Python 移植）。

算法源自 GARbro（morkt / crskycode fork）的 ArcFormats/KiriKiri/KiriKiriCx.cs，
MIT 许可，Copyright (C) 2014-2016 by morkt。此处为独立 Python 重写：

  * 文件内容 = 一个由 4KB「控制块」喂出来的小字节码虚拟机（CxProgram）生成的
    异或流；每个文件用自己 adlr 段的 hash 作为参数，分两段（分界点
    `(hash & mask) + offset`）。
  * 每段再叠加 2 个「修补字节」和 1 个主异或字节。

关键点：所有运算都是 uint32 环绕；右移是逻辑移位；`get_random` 的 LCG 状态
跨 `EmitCode` 的 5 次重试**不重置**（写错会静默生成错误的字节码）。
"""

MASK32 = 0xFFFFFFFF

# ── 字节码 ───────────────────────────────────────────────────────────
(NOP, RETN, MOV_EDI_ARG, PUSH_EBX, POP_EBX, PUSH_ECX, POP_ECX,
 MOV_EAX_EBX, MOV_EBX_EAX, MOV_ECX_EBX, MOV_EAX_CONTROL_BLOCK, MOV_EAX_EDI,
 MOV_EAX_INDIRECT, ADD_EAX_EBX, SUB_EAX_EBX, IMUL_EAX_EBX, AND_ECX_0F,
 SHR_EBX_1, SHL_EAX_1, SHR_EAX_CL, SHL_EAX_CL, OR_EAX_EBX, NOT_EAX,
 NEG_EAX, DEC_EAX, INC_EAX) = range(26)

IMMED = 0x100
MOV_EAX_IMMED = 0x101
AND_EBX_IMMED = 0x102
AND_EAX_IMMED = 0x103
XOR_EAX_IMMED = 0x104
ADD_EAX_IMMED = 0x105
SUB_EAX_IMMED = 0x106

LENGTH_LIMIT = 0x80


class CxProgram:
    def __init__(self, seed, control_block):
        self.seed = seed & MASK32
        self.cb = control_block
        self.code = []
        self.length = 0

    # ── 发射 ──
    def clear(self):
        self.length = 0
        self.code.clear()

    def emit_nop(self, count):
        if self.length + count > LENGTH_LIMIT:
            return False
        self.length += count
        return True

    def emit(self, code, length=1):
        if self.length + length > LENGTH_LIMIT:
            return False
        self.length += length
        self.code.append(code)
        return True

    def emit_u32(self, x):
        if self.length + 4 > LENGTH_LIMIT:
            return False
        self.length += 4
        self.code.append(x & MASK32)
        return True

    def emit_random(self):
        return self.emit_u32(self.get_random())

    def get_random(self):
        seed = self.seed
        self.seed = (1103515245 * seed + 12345) & MASK32
        return (self.seed ^ ((seed << 16) & MASK32) ^ (seed >> 16)) & MASK32

    # ── 执行 ──
    def execute(self, hash_):
        eax = ebx = ecx = 0
        edi = 0
        stack = []
        immed = 0
        code = self.code
        i = 0
        n = len(code)
        while i < n:
            bc = code[i]
            i += 1
            if bc & IMMED:
                immed = code[i]
                i += 1
            if bc == NOP or bc == IMMED:
                continue
            elif bc == MOV_EDI_ARG:
                edi = hash_ & MASK32
            elif bc == PUSH_EBX:
                stack.append(ebx)
            elif bc == POP_EBX:
                ebx = stack.pop()
            elif bc == PUSH_ECX:
                stack.append(ecx)
            elif bc == POP_ECX:
                ecx = stack.pop()
            elif bc == MOV_EBX_EAX:
                ebx = eax
            elif bc == MOV_EAX_EDI:
                eax = edi
            elif bc == MOV_ECX_EBX:
                ecx = ebx
            elif bc == MOV_EAX_EBX:
                eax = ebx
            elif bc == AND_ECX_0F:
                ecx &= 0x0F
            elif bc == SHR_EBX_1:
                ebx >>= 1
            elif bc == SHL_EAX_1:
                eax = (eax << 1) & MASK32
            elif bc == SHR_EAX_CL:
                eax >>= (ecx & 31)
            elif bc == SHL_EAX_CL:
                eax = (eax << (ecx & 31)) & MASK32
            elif bc == OR_EAX_EBX:
                eax |= ebx
            elif bc == NOT_EAX:
                eax = (~eax) & MASK32
            elif bc == NEG_EAX:
                eax = (-eax) & MASK32
            elif bc == DEC_EAX:
                eax = (eax - 1) & MASK32
            elif bc == INC_EAX:
                eax = (eax + 1) & MASK32
            elif bc == ADD_EAX_EBX:
                eax = (eax + ebx) & MASK32
            elif bc == SUB_EAX_EBX:
                eax = (eax - ebx) & MASK32
            elif bc == IMUL_EAX_EBX:
                eax = (eax * ebx) & MASK32
            elif bc == ADD_EAX_IMMED:
                eax = (eax + immed) & MASK32
            elif bc == SUB_EAX_IMMED:
                eax = (eax - immed) & MASK32
            elif bc == AND_EBX_IMMED:
                ebx &= immed
            elif bc == AND_EAX_IMMED:
                eax &= immed
            elif bc == XOR_EAX_IMMED:
                eax ^= immed
            elif bc == MOV_EAX_IMMED:
                eax = immed
            elif bc == MOV_EAX_INDIRECT:
                if eax >= len(self.cb):
                    raise ValueError('CxProgram: 控制块越界 %d' % eax)
                eax = (~self.cb[eax]) & MASK32
            elif bc == RETN:
                if stack:
                    raise ValueError('CxProgram: 栈不平衡')
                return eax
            else:
                raise ValueError('CxProgram: 非法字节码 %r' % (bc,))
        raise ValueError('CxProgram: 缺少 RETN')


class CxCrypt:
    """一个游戏的 Cx 方案：mask/offset + 三个顺序表 + 控制块。"""

    def __init__(self, mask, offset, prolog_order, odd_order, even_order, control_block):
        self.mask = mask
        self.offset = offset
        self.prolog_order = bytes(prolog_order)
        self.odd_order = bytes(odd_order)
        self.even_order = bytes(even_order)
        self.cb = control_block
        self._programs = [None] * 0x80

    # ── 程序生成 ──
    def _emit_prolog(self, p):
        sel = self.prolog_order[p.get_random() % 3]
        if sel == 2:
            return (p.emit_nop(5) and p.emit(MOV_EAX_IMMED, 2)
                    and p.emit_u32(p.get_random() & 0x3FF)
                    and p.emit(MOV_EAX_INDIRECT, 0))
        if sel == 1:
            return p.emit(MOV_EAX_EDI, 2)
        return p.emit(MOV_EAX_IMMED) and p.emit_random()

    def _emit_even(self, p):
        sel = self.even_order[p.get_random() & 7]
        if sel == 0:
            return p.emit(NOT_EAX, 2)
        if sel == 1:
            return p.emit(DEC_EAX)
        if sel == 2:
            return p.emit(NEG_EAX, 2)
        if sel == 3:
            return p.emit(INC_EAX)
        if sel == 4:
            return (p.emit_nop(5) and p.emit(AND_EAX_IMMED) and p.emit_u32(0x3FF)
                    and p.emit(MOV_EAX_INDIRECT, 3))
        if sel == 5:
            return (p.emit(PUSH_EBX) and p.emit(MOV_EBX_EAX, 2)
                    and p.emit(AND_EBX_IMMED, 2) and p.emit_u32(0xAAAAAAAA)
                    and p.emit(AND_EAX_IMMED) and p.emit_u32(0x55555555)
                    and p.emit(SHR_EBX_1, 2) and p.emit(SHL_EAX_1, 2)
                    and p.emit(OR_EAX_EBX, 2) and p.emit(POP_EBX))
        if sel == 6:
            return p.emit(XOR_EAX_IMMED) and p.emit_random()
        rc = p.emit(ADD_EAX_IMMED) if (p.get_random() & 1) else p.emit(SUB_EAX_IMMED)
        return rc and p.emit_random()

    def _emit_odd(self, p):
        sel = self.odd_order[p.get_random() % 6]
        if sel in (0, 1):
            op = SHR_EAX_CL if sel == 0 else SHL_EAX_CL
            return (p.emit(PUSH_ECX) and p.emit(MOV_ECX_EBX, 2)
                    and p.emit(AND_ECX_0F, 3) and p.emit(op, 2) and p.emit(POP_ECX))
        if sel == 2:
            return p.emit(ADD_EAX_EBX, 2)
        if sel == 3:
            return p.emit(NEG_EAX, 2) and p.emit(ADD_EAX_EBX, 2)
        if sel == 4:
            return p.emit(IMUL_EAX_EBX, 3)
        return p.emit(SUB_EAX_EBX, 2)

    def _emit_body2(self, p, stage):
        if stage == 1:
            return self._emit_prolog(p)
        if p.get_random() & 1:
            rc = self._emit_body(p, stage - 1)
        else:
            rc = self._emit_body2(p, stage - 1)
        return rc and self._emit_even(p)

    def _emit_body(self, p, stage):
        if stage == 1:
            return self._emit_prolog(p)
        if not p.emit(PUSH_EBX):
            return False
        ok = self._emit_body(p, stage - 1) if (p.get_random() & 1) else self._emit_body2(p, stage - 1)
        if not ok:
            return False
        if not p.emit(MOV_EBX_EAX, 2):
            return False
        ok = self._emit_body(p, stage - 1) if (p.get_random() & 1) else self._emit_body2(p, stage - 1)
        if not ok:
            return False
        return self._emit_odd(p) and p.emit(POP_EBX)

    def _generate(self, seed):
        prog = CxProgram(seed, self.cb)
        for stage in range(5, 0, -1):
            if (prog.emit_nop(5)
                    and prog.emit(MOV_EDI_ARG, 4)
                    and self._emit_body(prog, stage)
                    and prog.emit_nop(5)
                    and prog.emit(RETN)):
                return prog
            prog.clear()          # ★ seed 不重置，与 C# 一致
        raise ValueError('CxProgram: 字节码超长')

    def execute_xcode(self, hash_):
        seed = hash_ & 0x7F
        if self._programs[seed] is None:
            self._programs[seed] = self._generate(seed)
        prog = self._programs[seed]
        h = hash_ >> 7
        return prog.execute(h), prog.execute((~h) & MASK32)

    # ── 解密 ──
    # 主体是「单字节常量异或」+ 2 个修补字节，所以用 bytes.translate（C 速度）
    # 打底，再补 2 个字节，避免逐字节 Python 循环。
    _TABLES = {}

    @classmethod
    def _table(cls, k):
        t = cls._TABLES.get(k)
        if t is None:
            t = bytes((b ^ k) for b in range(256))
            cls._TABLES[k] = t
        return t

    def _xor_segment(self, key, offset, seg):
        ret1, ret2 = self.execute_xcode(key)
        key1 = ret2 >> 16
        key2 = ret2 & 0xFFFF
        key3 = ret1 & 0xFF
        if key1 == key2:
            key2 += 1
        if key3 == 0:
            key3 = 1
        out = bytearray(seg.translate(self._table(key3)))
        n = len(out)
        i = key2 - offset
        if 0 <= i < n:
            out[i] ^= (ret1 >> 16) & 0xFF
        i = key1 - offset
        if 0 <= i < n:
            out[i] ^= (ret1 >> 8) & 0xFF
        return bytes(out)

    def decrypt(self, hash_, data):
        """整段解密（offset 从 0 开始）。"""
        data = bytes(data)
        total = len(data)
        base = (hash_ & self.mask) + self.offset
        if total == 0:
            return b''
        if base <= 0:
            key = ((hash_ >> 16) ^ hash_) & MASK32
            return self._xor_segment(key, 0, data)
        n = min(base, total)
        out = self._xor_segment(hash_, 0, data[:n])
        if n < total:
            key = ((hash_ >> 16) ^ hash_) & MASK32
            out += self._xor_segment(key, n, data[n:])
        return out


# ── 千恋万花（SenrenCxCrypt）参数 ─────────────────────────────────────
SENREN = dict(mask=0x134, offset=0x736,
              prolog_order=[1, 0, 2],
              odd_order=[3, 1, 2, 4, 0, 5],
              even_order=[7, 4, 3, 6, 2, 0, 1, 5])


def load_control_block(path_or_bytes, offset=None):
    """16 位小端 uint32 × 1024。"""
    import struct
    if isinstance(path_or_bytes, (bytes, bytearray)):
        b = bytes(path_or_bytes)
    else:
        b = open(path_or_bytes, 'rb').read()
    if offset is not None:
        b = b[offset:offset + 4096]
    else:
        b = b[:4096]
    return list(struct.unpack('<1024I', b))


def make_senren(control_block):
    return CxCrypt(control_block=control_block, **SENREN)
