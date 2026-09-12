# Subagent 历史实验索引与重放边界

本目录保留旧版本的故障、候选、失败与采用证据。各报告的“当前安装”“尚未采用”“默认不启用”均指该批实验时点，不代表现在的产品；历史 PASS/FAIL、包版本、摘要和计数不回填成新版本验收。

## 当前入口

- [发行包默认 scope 与限制](../../../../docs/agent/subagent-owned-default.md)：launcher 默认选择 `owned-process-groups-v2`；不是安全沙箱，不迁移旧会话。
- [维护源码](../../../../packages/rotom-subagents/README.md)：产品默认内化组件为 `pi-subagents@0.52.1-rotom.1`，不再由历史 patch 堆栈构建。
- [产品资源合同](../../../runtime/product-config.mjs)与[验证入口](../../../../docs/agent/verification.md)是当前路径/版本的权威来源。

## 如何阅读旧命令

报告中的源码定位和仍存在的测试路径已按目录重构更新；这仅便于定位，不表示用当前 harness 可以重现当时结果。当前 lifeline 回归位于 `../subagent/lifeline-regression.test.mjs`，默认测 installed product；旧候选必须显式提供匹配的 `SUBAGENT_LIFELINE_SOURCE`，不能将当前默认当作历史 baseline。

部分无引用的旧 patch / flat / readiness 测试已在维护提交 `542e22a` 清理。对应报告保留其历史名称，不提供失效下载链接，也不恢复兼容壳。准备器仍可能依赖这些旧 preimage：**执行前核对全部输入；缺失时只能在有相应历史的隔离维护 checkout 重建，不可直接在当前树运行整套旧命令。**

私有维护 commit、临时日志与产物不保证存在于公开仓库；不要构造指向公开 GitHub 的失效历史 commit 链接，不要带回私有 `.git` 或上传原始会话来补齐。新验证须记录实际 revision、归档、命令与结果，旧授权和旧 PASS 不可复用。
