# 芳乃 DDSP Reflow 模型 · 20000 步

[公开下载页](https://github.com/InariNGT-Ofiicial/dsh-train-pipeline/releases/tag/voice-yoshino-20000)

这是此前《千恋＊万花》体验版芳乃演示使用的现有 checkpoint。本次上传没有重新训练，也没有转换或重写权重；模型文件与此前演示记录的 SHA-256 一致。

## 下载文件

| 文件 | 内容 | 字节数 |
| --- | --- | ---: |
| `model_20000.pt` | DDSP-SVC 6.2 Reflow checkpoint，单说话人 | 280286063 |
| `config.yaml` | 与该 checkpoint 同一实验的原始配置 | 1182 |
| `SHA256SUMS.txt` | 权重和配置的 SHA-256 | — |
| `MODEL_CARD.md` | 本页说明的副本 | — |

SHA-256：

```text
5cd92374cabffb73ea84ec4974fae544e84376a6ce5eba5644b868d4ff42cfc9  model_20000.pt
3b65d35c6ac17775d94ebd965f7724652952315a9a02863d7c28026ac77845b6  config.yaml
```

Windows 可用 `Get-FileHash -Algorithm SHA256 <文件>` 校验。下载后须保持权重和配置配对，不能只拿权重拼接另一份配置。

## 放入翻唱音色库

将两个文件放在两插件共享的 `voiceLibDir` 下：

```text
03_voices/
  芳乃_步数20000/
    exp/
      reflow-senren-yoshino/
        model_20000.pt
        config.yaml
```

随后重载 DSH / 翻唱插件，核对它选中的模型路径，再执行短片段测试：

```text
cover_convert src=<自己的主唱干声> voice=芳乃 key=0 dryRun=true
```

确认路径后关闭 `dryRun` 执行实际换声。仍需自行准备兼容的 DDSP Reflow 工程、Python/CUDA 环境、ContentVec、RMVPE 与声码器等外部依赖；这些不在本次 Release 中。原配置使用 `contentvec768l12tta2x`、`rmvpe` 和 `nsf-hifigan`，采样率 44100 Hz。

## 验证和来源范围

- 原翻唱插件曾找到此 checkpoint 并完成换声调用；模型与配置哈希核对通过。
- 用户仅明确认可一个等响度 8 秒干声 AB 的音色变化明显，不代表整曲或所有输入音质均已验收。
- 演示素材目录中芳乃有 633 条音频，实测约 37.1839 分钟。这不是该 checkpoint 完整训练集的证明；历史 QC 与当前数据目录不能据此合并为训练清单。
- 本次发布仅含权重、配套配置、校验文件和说明，不含游戏包、解包语音、训练语音、歌曲或参考音频。
- 权重以 PyTorch checkpoint 原始格式提供；上传前仅以 ZIP 元数据和 pickle 指令扫描检查私人路径/凭据，没有反序列化执行 checkpoint。

## 许可范围

代码仓库的 MIT 许可明确不覆盖模型权重、游戏素材与角色声音。本次上传没有为这些第三方内容另行授予许可，也不代表权利方授权商业使用或再分发。
