# dsh-train-pipeline

DeepSeek Harness（DSH）的本地音色训练插件，版本 **0.4.1**。19 个工具覆盖本机素材查找、指定 URL 下载、部分吉里吉里封包解包、角色盘点、数据集整理、质量检查、DDSP Reflow 预处理与训练，以及训练结果注册。

与 [dsh-cover-pipeline](https://github.com/InariNGT-Ofiicial/dsh-cover-pipeline) 配套：训练插件把 `model_N.pt` 和 `config.yaml` 放入约定的音色库，翻唱插件重载后发现并使用该音色。

Git 源码树仅包含源码、合成测试生成器和文档，不包含 DDSP 工程、模型权重、游戏素材、语音、歌曲或参考音频。

**芳乃模型下载**：[20000 步权重与配套配置](https://github.com/InariNGT-Ofiicial/dsh-train-pipeline/releases/tag/voice-yoshino-20000) 按用户要求单独提供为公开 Release 附件，使用方法与 SHA-256 见 [模型说明](docs/YOSHINO_MODEL.md)。它不随 `git clone` 或 npm 包下载，插件代码的 MIT 许可不自动适用于权重。

## 安装

当前主要面向 Windows。需要 Node.js 18+、DSH 和可用的 **DDSP-SVC 6.2 Reflow** 工程及其 Python 环境。GPU 训练依赖该工程自己的 PyTorch/CUDA、预训练权重和配置；本插件不会安装 DDSP 或下载权重。

```powershell
git clone https://github.com/InariNGT-Ofiicial/dsh-train-pipeline.git
cd dsh-train-pipeline
# 设置为自己的音频工程根目录，也可配置 train.local.json。
$env:DSH_COVER_ROOT = (Resolve-Path ../AudioWork).Path
node test/live.mjs train_doctor
dsh plugin --profile desktop add .
```

`../AudioWork` 仅为示例，应先准备自己的外部工程目录。安装后重载 DSH。环境布局、配置优先级和故障排查见 [安装与配置](docs/INSTALL.md)；外部工具和权重清单见 [材料说明](materials/README.md)。

## 使用流程

```text
train_doctor → train_plan → train_hunt / train_fetch / train_unpack
            → train_scan → train_build → train_qc
            → train_preprocess → train_run → train_status / train_stop
            → train_infer → train_register → 翻唱插件重载
```

可以在 DSH 中描述目标角色与素材目录。调用方需要逐步检查工具返回的 `ok`、报告和产物。`train_plan` 提供流程规则；它不会自动强制所有前置质量门，也不意味着一次自然语言请求必然完成整条链。

`train_preprocess` 会更换 DDSP 工程的 `data/train/audio` 与 `data/val/audio`，先把原有音频目录移动到训练工作区的 `backup/`。请使用独立训练工程，避免与正在运行的任务共用数据目录。`train_run` 遇到已有 checkpoint 默认停止，显式 `confirmOverwrite=true` 才继续。

## 源与支持范围

| 输入 | 已实现行为 | 限制 |
| --- | --- | --- |
| 按角色分目录的语音 | 按目录名盘点与整理；读取音频帧数计算时长 | 目录名仍需抽检；不能证明内容纯净或角色标注正确 |
| JSON / KAG3 `.ks` 剧本 | 启发式提取 speaker / voice 引用，报告匹配率 | 陌生格式可能漏抓；立绘名推测仅供参考 |
| 普通 XP3、部分内嵌 EXE 封包 | 调用外部 arc_unpacker，按实际落盘文件检查结果 | 不覆盖所有引擎、版本或加密方式 |
| SenrenCxCrypt 系列 | 已有静态解析/解密实现；需兼容的 GARbro `Formats.dat` | 本机体验版验证通过，不承诺其他游戏兼容 |
| 单角色音频目录 | 指定角色后整理 WAV 数据集 | 不自动区分 BGM 或多人对话 |
| 番剧 / 录屏 | 适配器接口已留 | 分离、VAD、声纹归属尚未实现 |

**时长口径**：语音目录通过 `soundfile` 读取 `frames / samplerate`，不再按压缩文件字节数估时。文件损坏或格式不支持时报告失败数量与未知时长，不把部分总和标成完整时长。剧本分支仍使用 `4.2 秒/句` 的粗估，并明确标注“未实测”；质量检查报告使用实际数据集时长。

## 工具一览

| 工具 | 用途 |
| --- | --- |
| `train_sources` / `train_plan` | 实现状态、流程与决策提示 |
| `train_doctor` / `train_setup` | 环境检查、配置建议、可选写入本机配置 |
| `train_hunt` | 搜索本机目录与 Steam 库，受深度和时间预算限制 |
| `train_toolchain` | 检查或从上游 GitHub release 安装解包工具；GUI 工具单独标识 |
| `train_fetch` | 下载给定 URL，记录 URL、SHA-256 与时间，不内置资源站搜索 |
| `train_unpack` / `train_acquire` | 解包、可选反编译；acquire 串接查找与角色盘点 |
| `train_scan` | 源识别、角色数量、语音数、时长及匹配报告 |
| `train_build` | 转码、单声道、重采样、裁静音、超长分段 |
| `train_qc` | 采样率、时长、削波、静音、粗重复检测；`apply=true` 才移动不合格文件 |
| `train_preprocess` | 备份旧音频，复制新数据，执行 `draw.py` / `preprocess.py` |
| `train_run` / `train_status` / `train_stop` | 后台训练、日志与 checkpoint 状态、停止进程 |
| `train_infer` | 选择已有 checkpoint 做短句推理，需人工试听 |
| `train_register` / `train_overview` | 注册模型与配置、检查工作区和音色库 |

注册布局、指定步数和翻唱调用示例见 [接入翻唱插件](docs/INTEGRATION.md)。注册默认拒绝覆盖，缺少同一实验的 `config.yaml` 或空模型时失败。注册成功只证明文件可发现，不证明模型音质。

## 测试与验证

```powershell
python -m pip install -r requirements-test.txt
# 可选：指定用于合成测试的 Python 解释器。
$env:DSH_TRAIN_PYTHON = (Get-Command python).Source
npm test
```

CPU 套件不需要 GPU、真实模型、网络或游戏素材；覆盖工具契约、路径、启动失败、KAG3/JSON 解析、合成数据集与 QC、OGG 精确时长、注册与包内容。GitHub Actions 在 Windows/Linux 运行该套件。真实 GPU 训练和下载测试需要独立环境，详见 [验证范围](docs/VALIDATION.md)。

本机演示曾验证《千恋＊万花》体验版解包、角色目录整理、**读取已有 20000 步检查点**、注册和原翻唱插件调用。该演示没有重新训练模型，也不作为本仓库在其他机器上完整训练成功的保证。只发布计数与验证口径，不发布其原始素材、音频或权重。

## 许可

插件代码采用 [MIT](LICENSE)。`py/cxdec.py` 的上游算法来源及许可保留在 [第三方说明](THIRD_PARTY_NOTICES.md)。外部工具按各自许可使用；代码许可不授予游戏素材、音色、表演、训练数据或模型的使用与再分发权。
