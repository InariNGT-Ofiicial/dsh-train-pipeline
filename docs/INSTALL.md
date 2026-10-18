# 安装与配置

## 外部环境

Windows 是主要运行平台，尤其是工具链下载、解包与 `taskkill` 停训练。Linux CI 验证的是便携 CPU 工具与文件契约，不代表 Windows 外部工具也能在 Linux 使用。

- Node.js 18+；DSH 提供 `tools` 服务及 `@deepseek-ai/cordis >=4.0.1` 插件接口。
- DDSP-SVC 6.2 Reflow 工程；包含 `slicer.py`、`draw.py`、`preprocess.py`、`train_reflow.py`、`main_reflow.py`、`batch_infer.py`。
- 对应 Python 环境中的 `torch`、`numpy`、`soundfile`、`librosa`，以及 DDSP 工程自身的其余依赖。GPU/CUDA 安装以该工程要求为准。
- FFmpeg 可配置文件路径或使用 PATH；工具链联网功能使用系统 `curl`，ZIP 解压优先系统 bsdtar。
- 游戏解包时按需安装 arc_unpacker、FreeMote；已解包语音目录可直接 scan/build。SenrenCxCrypt 分支需要兼容的外部 `Formats.dat`，可通过 `DSH_FORMATS_DAT` 指定。

```text
AudioWork/                       ← songRoot
  02_ddsp/DDSP-Reflow/            ← ddspDir（含 train_reflow.py）
    env/python.exe               ← ddspEnv（也可为其他虚拟环境的解释器）
    configs/reflow-example.yaml
    pretrain/...
    data/train/audio/
    data/val/audio/
    exp/reflow-example/
  03_voices/                     ← voiceLibDir
  04_training/                   ← trainRoot
  tools/                         ← toolsDir，按需下载
```

具体预训练文件见 [材料清单](../materials/README.md)。只运行 `train_scan` 的语音目录探测不需要 PyTorch；`soundfile` 用于精确时长。少了探测环境仍可盘点文件，但会明确显示时长未知。

## 配置位置与优先级

生效顺序为：默认值 → DSH 插件配置 → **`train.local.json` 的非空键**。本机配置优先级最高；空字符串与 `null` 不覆盖插件配置。没有值的路径才尝试自动发现。配置文件放在本插件根目录，已加入 Git 忽略。

```json
{
  "songRoot": "../AudioWork",
  "trainRoot": "../AudioWork/04_training",
  "voiceLibDir": "../AudioWork/03_voices",
  "ddspDir": "../AudioWork/02_ddsp/DDSP-Reflow",
  "ddspEnv": "../AudioWork/02_ddsp/DDSP-Reflow/env/python.exe",
  "ffmpeg": "ffmpeg",
  "configName": "reflow-example.yaml",
  "expName": "reflow-example",
  "sampleRate": 44100,
  "minSec": 3,
  "maxSec": 15,
  "targetHours": 0.5
}
```

**相对路径以启动进程的当前目录为基准**。DSH 的启动目录可能不同，日常部署建议在本机配置中使用自己的绝对路径；这些本机配置不要上传。`configName` 相对 `<ddspDir>/configs/`；`expName` 对应 `<ddspDir>/exp/`，必须与 DDSP YAML 的 `expdir` 一致。

| 参数 / 环境变量 | 作用 |
| --- | --- |
| `songRoot` / `DSH_COVER_ROOT` | 工程根目录；都空时使用当前目录 |
| `trainRoot` / `DSH_TRAIN_ROOT` | 训练工作区；都空时为 `<songRoot>/04_训练工作区`；此变量不改变 songRoot |
| `voiceLibDir` | 共享音色库；空时扫描根目录下首个 `03_*` |
| `ddspDir` / `ddspEnv` | 外部工程及解释器；空时在根目录和两层子目录查找 |
| `toolsDir` | 工具链目录；空时为 `<songRoot>/tools` |
| `ffmpeg` | 可执行文件路径或 `ffmpeg` 命令名 |
| `proxy` | 显式代理优先，否则读取 HTTPS_PROXY / HTTP_PROXY；连不上代理时直连并报告降级 |
| `timeoutMs` / `maxOutputChars` | 执行超时 / 日志展示长度 |
| `DSH_TRAIN_PYTHON` | 仅测试脚本使用；运行插件请配置 ddspEnv |

显式配置的目录即使尚未创建也会保留。错误的 DDSP/Python 路径由 `train_doctor` 报告，不会静默改用别的工程。`train_setup writeConfig=true` 可生成本机配置，重载插件后生效；它只是接入检查，不能替代完整 doctor。

`cordis.patch.yml` 随插件分发，`cordis.dev.yml` 是配置示例。不要直接修改分发文件写入自己的代理、用户名或绝对路径。

## 检查与安装

```powershell
node test/live.mjs train_doctor
# 或运行安装辅助脚本。DryRun 只显示命令。
powershell -NoProfile -File scripts/install.ps1 -DryRun -Install
powershell -NoProfile -File scripts/install.ps1 -Install
```

检查失败时脚本返回非零，安装辅助脚本停止；DSH 命令失败时也不会显示已安装。

| 错误 | 处理 |
| --- | --- |
| DDSP 工程/脚本缺失 | ddspDir 指向含 train_reflow.py 的层级，并核对 Reflow 版本 |
| Python/依赖失败 | 使用 DDSP 自己的解释器，按外部工程要求安装依赖 |
| 采样率或 expdir 不一致 | 让插件设置与实际 YAML 一致后再预处理 |
| 时长未知 | 检查 soundfile 与文件格式；损坏/不支持文件计为失败，不按字节数换算 |
| 数据/验证集为空 | 检查数据整理与 draw.py 输出，不能直接开训 |
| 注册缺 config.yaml | 使用同一实验输出的配置，不能随便拼接另一个模型的配置 |
| 翻唱插件找不到新音色 | 两插件指向同一库；核对注册路径，重载翻唱插件 |

预处理会移动旧音频并执行外部脚本；特征缓存、训练配置与并发任务需自行隔离。doctor 与 QC 是可单独调用的工具，当前代码未提供跨工具的强制工作流状态锁。
