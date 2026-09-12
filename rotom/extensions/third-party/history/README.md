# Subagent 历史实验与当前入口

本目录保留旧版本故障、候选、失败与采用证据。各报告的“当前安装”“尚未采用”“默认不启用”均指该批实验时点，不代表当前产品；历史 PASS/FAIL、版本、摘要和计数不回填成新版本验收。

## 当前入口

- [产品说明](../../../README.md)：launcher 默认选择 `owned-process-groups-v2`；不迁移活跃会话。
- [内化源码与维护](../../../../packages/rotom-subagents/README.md)：当前组件为 `pi-subagents@0.52.1-rotom.1`，产品不再从历史 patch 堆栈生成新实现。
- [执行 scope 合同](../../../../packages/rotom-subagents/docs/owned-execution.md)与[资源声明](../../../runtime/product-config.mjs)是当前能力和路径的核对入口。

## 历史采用合同

完整的早期采用设计与维护报告不在本精简公开快照内。本节仅提供公开可读的边界摘要，不冒充原报告或新的验收证明：

- 任务结果、受控资源关闭、组外后代覆盖与业务效果核验是不同维度。
- capacity 释放只证明已登记的受控资源关闭，不证明任意逃逸后代或远端副作用结束，也不授权重放未知工作。
- 当前首版 scope 只支持明确列出的拓扑；旧矩阵的正面目标不代表现在已启用，详见上方执行合同。
- 新安装或新版本不迁移既有会话、不回填旧证明，也不放宽 canonical lease 与恢复围栏。

## 旧命令的重放限制

仍存在的测试路径已按目录重构更新，仅便于定位。当前 `../subagent/lifeline-regression.test.mjs` 默认测试 installed product；不能把它当作旧 candidate/baseline，历史输入须显式匹配 `SUBAGENT_LIFELINE_SOURCE`。

部分旧 patch、flat/readiness 测试已经移除。准备器可能仍依赖其 preimage；缺失输入时不能直接在当前树重跑整套旧命令，更不能恢复兼容壳或绕过 identity gate。报告中的私有 commit、临时日志与旧产物不保证存在于公开仓库；不要构造失效 GitHub commit 链接或上传私有历史来补齐。旧授权与旧 PASS 不可复用。
