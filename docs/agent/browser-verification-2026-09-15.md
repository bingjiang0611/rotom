# Browser 稳定性验收（2026-09-15 UTC）

## 范围与结论

本轮修复 Relay socket 生命周期竞争和虚拟化全文读取。源码验收不是 npm 发布：仅经用户授权更新本机独立 Relay 组件并手动重载 Chrome 扩展，未更新活跃 Pi 安装。

- 最终 Chrome extension **0.9.2 / protocol 19**。
- macOS **27.0**、Node **24.18.0**；隔离源码、HOME 与锁文件安装的 Pi/第三方依赖。
- 按用户授权实际调用 **qoder/ultimate**；无 token 总使用上限，保留超时、取消与 unknown 不重放。美元费用未知。
- **本次 Browser 范围通过；全量 personal gate 未全部通过。** 不推断任意网页或其他平台均正常。

## 原始断连与回退诊断

- 已复现第二个 native host 启动失败退出时删除仍存活 host 的 socket；仅加 inode 退出校验后，又复现 stale 回收最后检查与 unlink 之间的竞争。修复的是这两条可证明的生命周期路径，不是把所有断连都归为同一原因。
- `file://` 是 URL 合同错误，不是 Relay 未安装；现在 URL/tabName 在连接前校验，本地 HTML 应使用 HTTP 服务。
- 本次运行已经派发 Relay 请求，或已经消费一次 fallback launch 许可时，回退拒绝是预期保护。重连失败、超时、旧协议、登录页等不能把该许可重新打开；本次只澄清原因，未放宽回退门禁。
- 标签名缺失、过期 ref/cursor、无效 claim 与其他超时不能由 socket 或全文测试统一解释。原标签单次 recover 的合成场景已通过，但不承诺任意状态丢失均自动恢复。

## 修复与证据

| 项目 | 证据与结果 |
|---|---|
| socket 生命周期 | 重复 host 不删除现存端点；真实进程 barrier 复现 stale 回收 check/unlink 竞争，加入进程寿命 FD 锁后竞争者被排斥；保留 socket dev/ino 清理校验 |
| 锁释放与身份 | 覆盖 crash/SIGKILL、EOF/SIGTERM、持久 lockfile 身份、symlink 拒绝和外部 successor socket 保护 |
| macOS FD 模式 | 本机 `lockf(1)` 手册明确支持无 command 的 FD 模式；helper 退出后竞争者 exit 75，父 Node 关闭持锁 FD 后竞争者 exit 0 |
| 短虚拟列表 | 网格采样之外补查有界语义容器；滚动步长按视口重叠，验证实际起点、连续覆盖和恢复位置 |
| 后台渲染 | 真实诊断发现 scrollTop 0→1760 时 scroll events/RAF 均为 0；复用 focus emulation，并等待两帧回执，不选择标签或聚焦窗口 |
| 完整性 | 无实际滚动、发现/扫描越界、已知 frame 未完成、渲染回执未知或恢复失败均不报告全文完成 |
| Browser 回归 | `node --experimental-strip-types --test --test-concurrency=1 rotom/extensions/browser/*.test.ts rotom/extensions/browser/*.test.mjs`：**122/122** |
| footprint 回归 | `rotom/runtime/context-footprint.test.mjs`：**9/9**；default/full/scoped-full 精确合同 PASS，未放宽 gate |
| runtime | 对应 footprint 路径的 runtime smoke 通过；必要语法检查及 `git diff --check` 通过 |

实际读取有界：每个文档最多 64 个语义候选、最多 8 个同源文档、每个 frame 最多 6 个目标、总计 60 步。不能把这种发现策略当作任意隐藏/无语义组件的穷尽证明；超过边界保留 partial，需要另行设计定向读取。

## Qoder Ultimate 真实 Chrome

最终候选使用已重载的 protocol 19 扩展；只操作新建的本地合成标签，不操作业务标签。页面共 80 行、可视容器高度 160px、仅渲染附近 10 行，初始 scrollTop=480。

- 通过真实模型请求与 provider/model 回执确认 `qoder/ultimate`，不是仅配置了模型名。
- 全文 **2 页**，消费全部 cursor；独立拼接 document-text 检出 **80 个不同 ID，无缺失**。
- `contentCoverage=scroll-end`、`contentComplete=true`、`truncated=false`、`scrolledContainers=1`。
- 唯一一次后续 visible snapshot 回读 **Virtual scroll position: 480**，tabId 不变。
- 关闭自身标签后 `tabs=[]`；服务器 **pageViews=1、saves=0**。
- 该最终阶段 8 次模型请求，reported tokens 36,089；这些不是整轮任务用量。

此前 protocol 17 / 相同 native-host 锁代码的独立 Chrome 阶段还覆盖两个合成标签、输入/Enter/勾选/select/单次保存、截图及 host 重启后的原标签 recover；保存计数始终为 1，未重放写动作。该阶段不替代最终 0.9.2 的全文验收，也不代表真实业务站点 L3。

## 保留的失败与限制

- 两轮真实 Chrome 曾分别返回 10/80 行却标为完整：先是容器漏检，后是后台未渲染；均保留失败记录，未被早先的单测 PASS 覆盖掉。
- 一次私有验证脚本漏传 fixture URL，访问/保存计数均为 0、会话标签为空；修复脚本后才进行后续验收，不算产品通过证据。
- Ultimate 最终复审曾误判 macOS `lockf` 无 FD 模式；以本机完整手册及实际 FD 竞争试验反证后，Ultimate 撤销该阻断。没有据模型误判改动已验证的锁实现。
- 较早全量 `check-personal` 为 493 项：491 pass、2 个 Subagent external fixture deadline。相关文件未修改，但尚无同配置 baseline 归因，不称其为已证明的环境问题或已修复回归；未重放闭合证据不足的工作。
- 首轮长 Ultimate 验证被中止，结果保留 unknown；后续审查基于明确的新修订/证据，不把该轮补记为成功。
- Linux `flock`、其他 macOS/Node 版本、复杂 OOPIF 与真实业务页尚未验收；隔离浏览器回退亦未进行真实启动验证。
- 原始模型会话、页面内容、运行坐标与本机路径只保留在私有证据目录，不提交或进入发行包。
