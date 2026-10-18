# 接入 dsh-cover-pipeline

两插件共享 `songRoot` 与 `voiceLibDir`。注册工具复制选定实验中的 `model_<N>.pt` 与 **同目录 `config.yaml`**，写入溯源文件；不会重新训练或修改翻唱插件。

直接使用已发布的芳乃 20000 步模型，下载与放置方法见 [芳乃模型说明](YOSHINO_MODEL.md)。该 Release 已提供匹配配置，无需先运行训练。

```text
03_voices/
  ExampleVoice_步数20000/
    exp/
      reflow-example/
        model_20000.pt
        config.yaml
        .train-manifest.json
```

在 DSH 调用：

```text
train_status
train_infer steps=20000 inputWav=<自己的短句干声>
train_register role=ExampleVoice steps=20000 libDir=<自己的共享音色库>
```

省略 `steps` 时选择当前实验中的最高非零 checkpoint，不意味着最高步数最好。应先试听多个 checkpoint 再明确指定。默认不覆盖同名注册；只有显式 `overwrite=true` 才覆盖。

角色名中的路径非法字符和下划线会剔除，避免翻唱插件 `split('_')[0]` 截断名称；若实验名不含 `reflow`，注册目录自动补 `reflow-` 前缀，并在结果里说明。模型或同一实验配置不存在/为空时注册失败，避免只有“可见”模型却缺推理配置。

注册后**重载 DSH / 翻唱插件**，让其重新扫描。翻唱插件按自身规则挑选同名权重；如有多个实验或步数，用其配置/检查工具核对最终选中的模型路径。

```text
cover_convert src=<真实主唱干声> voice=ExampleVoice key=0 dryRun=true
```

先检查命令中的模型和配置路径，再将 `dryRun` 关闭执行短片段换声。注册测试可选加载原翻唱插件的 `src/config.js`，确认其 `listVoices` / `findVoice` 找到刚注册的同一个文件：

```powershell
$env:DSH_COVER_PLUGIN_ROOT = (Resolve-Path ../dsh-cover-pipeline).Path
node test/register.mjs
```

该测试使用临时合成 checkpoint，仅验证目录、文件复制和发现契约，不能用于模型推理。

## 主唱与和声映射

沿用现有翻唱插件的定义：卡拉 OK 二次分离结果中，`kara/Vocals.wav` 是主唱，`kara/instrumental.wav` 是残余和声。换声应输入真实主唱，混音时可保留原和声。本仓库不修改这一映射。

演示脚本曾把这两路接反，属于外部演示接线错误，不是翻唱插件 README 的错误。注册成功、模型哈希一致、F0 保持或混音响度合格，都不能单独证明音色像目标角色；短片段等响度干声 AB 与人工试听仍有必要。
