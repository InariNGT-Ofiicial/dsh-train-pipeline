# 外部材料清单

本仓库不包含外部工程、工具二进制、模型或素材。运行 `train_doctor` 可检查本地缺失项。

## DDSP-SVC 6.2 Reflow

需要含 `train_reflow.py`、`main_reflow.py`、`batch_infer.py`、`draw.py`、`preprocess.py`、`slicer.py` 的工程，及匹配的 Python 环境与配置。旧版 WebUI 工程不能据此视为兼容。

当前 doctor 检查的预训练文件为：

- `pretrain/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02/model.ckpt`
- `pretrain/contentvec/checkpoint_best_legacy_500.pt`

它们按相对 `ddspDir` 的路径检查，不会自动下载。其余 DDSP 依赖以所使用工程自己的说明为准。

## 解包与反编译

`train_toolchain action=install` 从配置中的上游 GitHub release 获取工具，记录版本、来源和摘要；默认只安装 CLI 工具，GUI 工具需指定 id。它不会安装 DDSP 或 GPU 环境。

| 工具 | 本插件接口 | 上游 |
| --- | --- | --- |
| arc_unpacker | XP3 等命令行解包，按格式支持范围执行 | [vn-tools/arc_unpacker](https://github.com/vn-tools/arc_unpacker) |
| FreeMote | PsbDecompile 处理部分 SCN/PSB | [UlyssesWu/FreeMote](https://github.com/UlyssesWu/FreeMote) |
| GARbro | GUI 人工兜底；兼容 Formats.dat 可用于已实现的 CxDec 分支 | [morkt/GARbro](https://github.com/morkt/GARbro) |
| KrkrExtract | GUI 人工兜底，不当作自动 CLI | [xmoezzz/KrkrExtract](https://github.com/xmoezzz/KrkrExtract) |

工具默认位于 `<songRoot>/tools/`，可改 `toolsDir`。未知加密方式不保证可解。

## 音频

请使用有权处理的本地素材，或给 `train_fetch` 明确 URL。来源记录位于训练工作区的 `materials/_provenance.json`，可能包含个人路径与私有 URL，不能随源码发布。视频源的自动分离和角色识别尚未实现；MSST 不属于当前训练插件的默认依赖。
