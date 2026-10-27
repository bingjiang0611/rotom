# Compaction Offload：压缩前先卸载

## 做什么

rotom 在无 SoL-Pi 配置文件时默认开启 Compaction Offload。
阈值压缩前，将旧的中等大小文本工具结果存入会话目录，并以 `obs_recall` 指针替换请求中的原文。
估算剩余上下文足够小就推迟原生摘要；空间不足或无法完成卸载时仍走原生摘要。
不改原始会话，不额外调用模型；需要原文时模型可按页召回。
TUI 的 “Auto-compaction cancelled” 在这里表示推迟摘要，不表示任务取消。

## 开关与配置

- `ROTOM_COMPACTION_OFFLOAD=0 rotom`：最后覆盖为关闭。
- `ROTOM_COMPACTION_OFFLOAD=1 rotom`：请求开启，但必须同时启用 Observation Pack；未启用时只报一行并保持关闭。
- 环境变量未设置或为空：保留配置；非法值提示后忽略。
- 无配置文件：rotom 同时默认开启 Action Fusion、Observation Pack、Reducer 和 Compaction Offload，只有 Online Context Compact 关闭。
- 有 `~/.pi/agent/sol-pi.json` 或受信项目 `.pi/sol-pi.json`：文件完全取代 rotom 默认。省略 `compactionOffload` 时按 SoL-Pi 自身默认 `false`，不自动迁移旧配置。
- 不受信项目的配置不参与加载。SoL-Pi 包本身的默认仍为 `false`，本次没有修改包、版本或归档。

已有配置文件要开启，可使用：

```json
{ "version": 1, "observationPack": true, "compactionOffload": true }
```

Reducer 是另一项独立功能，会额外请求模型；上面的配置未开启它。

## 9 个有效配对的原值汇总

B=baseline（关闭卸载），A=candidate（开启卸载）；只比较同任务/重复次数的有效配对，不混入失败或未执行样本。
下表直接摘录 [11 报告](compaction/reports/11-fourth-replay.md)的 6 对和 [13 报告](compaction/reports/13-multi-file-fix-replay.md)的 3 对，不合并推算显著性。时间单位为 ms。

| 回放/臂 | 正确/有效数 | 原生/推迟总数 | 压缩等待均值/中位 | input/cacheRead 总数 | output 总数 | wall 均值 |
| --- | --- | --- | --- | --- | --- | --- |
| 11/B | 6/6 | 12/0 | 9175.658/8914.046 | 1391699/1771776 | 44378 | 122244.724 |
| 11/A | 6/6 | 3/10 | 2989.223/2134.446 | 1109712/2265728 | 46214 | 123477.390 |
| 13/B | 3/3 | 6/0 | 9369.409/9410.571 | 691298/1919872 | 34692 | 142824.422 |
| 13/A | 3/3 | 3/2 | 5555.053/4346.735 | 590357/1078784 | 18884 | 85518.617 |

cacheWrite 均为 0；11/A 的 10 次推迟含 1 次 `defer_stale`，不是 10 次独立卸载。
回放支持卸载、摘要回退和后续任务完成的可行性，不证明稳定节费或普遍生产加速。

## 局限与复跑

- 仅实测 `openai-codex/gpt-5.6-luna`、low；压缩阈值缩小到 64K，保留区为 5,120，不能把测得的秒数外推到生产窗口。
- 付费回放内 Action Fusion 和 Reducer 关闭；生产默认组合的 Action Fusion + 卸载仅有零模型 faux 回归，Reducer 在该回归中也关闭。
- 样本小；读取批次、部分读取、续读次数不同。13 中一个未卸载的 candidate 也更快，不能把全部差值归因于卸载。
- 召回未标记错误不等于完整语义恢复；现有实测指标不证明召回对象就是源文件，也不证明召回对修改必不可少。
- 输入包含缓存，不能直接换成美元；估算与已报告 usage 不代表完整账单。

复跑入口、零费用 faux 和真实回放要求见 [rotom/evals README](../../rotom/evals/README.md)。真实回放须先取得新的精确授权；旧授权已消费，不得重用。
