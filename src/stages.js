/**
 * 阶段定义与流程规则 —— 把「怎么做」交给模型，把「不许跳」写死在这里。
 *
 * 一条铁律：**训练集的瓶颈永远是素材，不是步数。**
 * 30 分钟的干净干声 > 3 小时混杂素材 + 20000 步。
 */

export const STAGES = [
  {
    id: 'S0', key: 'doctor', name: '环境体检',
    does: 'DDSP 工程/权重/Python/CUDA/ffmpeg/配置/磁盘/音色库',
    gate: '无 error',
  },
  {
    id: 'S1', key: 'acquire', name: '素材获取与解包',
    does: '本机搜（含 Steam 库）→ 备好解包工具链 → 下载指定资源 → 解封包 + 反编译剧本 → lines.jsonl',
    gate: '行数 > 0 且语音文件命中率报告已生成；加密封包需人工介入时明确停下',
  },
  {
    id: 'S2', key: 'scan', name: '角色盘点',
    does: '统计每个角色有多少句、多少秒，决定训谁',
    gate: '目标角色可用时长 ≥ 目标时长的一半',
  },
  {
    id: 'S3', key: 'build', name: '出数据集',
    does: '按角色复制/转码/重采样/裁静音，落 dataset_raw/<角色>',
    gate: '每条音频 44.1kHz 单声道、时长在 [minSec, maxSec]',
  },
  {
    id: 'S4', key: 'qc', name: '质量门',
    does: '削波、静音比、重复段、时长分布、离群检测',
    gate: '剔除后仍 ≥ 目标时长的 60%',
  },
  {
    id: 'S5', key: 'preprocess', name: '预处理',
    does: 'draw.py 划分 train/val → preprocess.py 提 f0 + 特征缓存',
    gate: 'data/train/audio 与 data/val/audio 均非空，且无缓存报错',
  },
  {
    id: 'S6', key: 'train', name: '训练',
    does: 'train_reflow.py，按实际训练配置的保存间隔落 model_<步数>.pt',
    gate: '出现 ≥1 个 checkpoint，且 loss 不 NaN/不炸',
  },
  {
    id: 'S7', key: 'register', name: '注册与试听',
    does: '冒烟推理 1 句 → 放进 03_*/<角色>_步数N/exp/reflow-test → 翻唱插件可见',
    gate: '试听 wav 出声，且 cover 插件能列出该音色',
  },
];

export const FLOW = STAGES.map((s) => s.id).join(' → ');

/** 五道不能"猜"的决策点：每一条都必须量出来或问出来 */
export const DECISIONS = [
  {
    id: 'D1', q: '训谁？',
    why: '多角色混训会得到一个"四不像"；DDSP 配置是 n_spk:1，只能单角色',
    how: 'train_scan 列出角色与可用时长，让用户点名',
  },
  {
    id: 'D2', q: '素材够不够？',
    why: 'reflow 6.2 的经验值：30 分钟能出可用效果，1-2 小时明显更稳；<10 分钟基本白训',
    how: 'train_scan 给出「角色 × 句数 × 总时长」，不足时明确说不够而不是硬训',
  },
  {
    id: 'D3', q: '素材干不干净？',
    why: 'galgame 原包语音通常是无 BGM 的 ogg，最干净；录屏/番剧必须过分离',
    how: '看源类型；非 galgame 源强制走 media adapter 的分离步骤',
  },
  {
    id: 'D4', q: '切多长？',
    why: '配置里 duration=2s 是训练窗口，片段短于它必炸；过长的片段会让模型学到句尾漂移',
    how: 'minSec=max(3, duration+1)，maxSec=15；由 train_build 强制',
  },
  {
    id: 'D5', q: '训到多少步停？',
    why: '步数不是越多越好，过拟合后音色会"糊"',
    how: 'train_status 每 2000 步报 loss；一般 12000-24000 步区间内试听挑',
  },
];

/** 流程红线（违反即判定失败，不给"看起来成功"的余地） */
export const WORKFLOW_RULES = [
  '未过 train_doctor 不进入 S5；未过 train_qc 不进入 S5。',
  'dataset 的采样率必须与配置 sampling_rate 一致，转换由 train_build 强制，不接受"差不多"。',
  '训练启动前必须确认 data/train/audio 非空且 val 非空；空的 val 会让 interval_val 报错。',
  '退出码 0 不算成功：训练要看 checkpoint 是否真的落盘，推理要看 wav 是否真的出声。',
  '未注册进音色库 = 闭环未完成。模型躺在 exp 里，翻唱插件是看不见的。',
  '不把未经授权的第三方音色/台词用于对外发布；插件只做本地数据集与本地训练。',
  '网络取材必须留 provenance（URL + sha256 + 时间）；插件不内置任何资源站爬虫，素材来源由调用方负责。',
  '解包/反编译失败两次就停手移交人工，不要反复换插件硬试 —— 加密封包的密钥猜不出来。',
];

export const SOURCE_TYPES = [
  {
    id: 'galgame', name: 'galgame 解包', flagship: true, implemented: true,
    why: '脚本里有权威 speaker 字段，语音本身无 BGM、无混响，是唯一能做到「零人工标注」的源',
    need: 'arc_unpacker（可自动获取）+ FreeMote PsbDecompile；加密封包才需要 KrkrExtract 人工',
  },
  {
    id: 'media', name: '番剧 / 录屏 / 合集', flagship: false, implemented: false,
    why: '没有权威 speaker 字段，必须靠字幕 Name 或声纹聚类，误差不可忽略',
    need: '接入点已留：ffmpeg 抽音轨 → 人声分离 → VAD 切片 → 角色归属',
  },
];
