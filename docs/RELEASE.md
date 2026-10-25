# 音色训练插件 v0.4.2

正式版本，同时支持 **DSH 0.2.1-rc.2 与 0.2.1-rc.3**。原有配置、工具名和人工设置保持兼容，无需宿主版本豁免。

补齐 DSH 安装兼容声明和源仓库元数据，保留原有业务工具和外部工程要求。

Windows / Linux × rc.2 / rc.3 的原生宿主兼容 CI 通过；本轮触发的原有回归 CI 全部通过。本地安装包还经过两个官方 npm 运行时及已安装 rc.3 Desktop 内置模块验证。

附件包含可安装的 `.tgz` 和 `SHA256SUMS.txt`。安装到实际使用的同一 profile 后重新加载插件或重启 DSH。外部 Python 工程、科研软件及模型按 README 单独准备。

本次兼容验收未运行 GPU 训练/翻唱、模型 API 或真实平台写入；宿主模块测试不代表 Desktop UI 全业务验收。验证边界与复现见 [DSH_COMPATIBILITY.md](docs/DSH_COMPATIBILITY.md)。
