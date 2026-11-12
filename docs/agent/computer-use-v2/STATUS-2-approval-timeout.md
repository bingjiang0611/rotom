# Computer Use v2.1：授权等待超时与诊断修复

## 范围与证据

基于 `d4acbd3`。用户手动测试中，Finder 的后台读取成功且用户报告没有干扰；随后一次点击在 `acquire` 阶段约 45 秒后失败。会话回执为 `broker_unavailable`，却被写成“其他 agent 占用，可以停止它或关闭 broker”。用户不确定当时是否出现授权卡片，旧日志没有卡片生命周期证据。

- 已确认代码缺陷：客户端普通请求期限 45 秒短于 broker 的 120 秒授权期限。
- 另一个已确认缺陷：server 捕获 `core.handle` 异常后未回显请求 ID。客户端丢弃没有 ID 的错误回复，最终只报告超时。
- 未证明哪个缺陷触发了历史上的这一次失败；不能声称已定位当时的卡片显示/选择情况，也不能把 `broker_unavailable` 等同于 `resource_busy`。
- 按调用链，租约失败发生在本次原生输入回调前。没有重新读取业务窗口，所以不声称当前目录未变化。

## 改动

1. `broker/client.ts`：只有 acquire 请求额外预算一次授权期限；若请求等待租约，再加一次排队期限。默认分别为 165 秒（45 + 120）和 195 秒（45 + 120 + 30）；其他请求仍为 45 秒。复用协议里的默认期限，不新增用户配置，不自动重发请求。
   - 这是当前产品 daemon 默认时限的合同。若以后产品开放自定义 broker 授权/排队期限，须先把相应期限纳入握手，不能让 daemon 单方面超过客户端预算。
2. `broker/approval-ui.ts`：从 bridge 提取现有授权卡片逻辑，使用 Pi 原生 select 的 timeout/signal，限制到 broker 截止时间和当前连接生命周期。到期、断线或 UI 异常时拒绝；迟到选择不得经新连接发送或沿用。
3. `broker/core.ts`：即使 timer 因事件循环延迟尚未触发，也按实际 deadline 拒绝迟到授权；不持久化迟到的 always 决定。
4. `broker/server.ts`：内部异常回复回显原请求 ID，让调用方及时收到结构化失败而不是假超时。
5. `broker/lease-result.ts`、`constants/copy.ts`、`recovery.ts`：只有真实 resource_busy 才报告持有者。broker_unavailable 不再建议停止其他会话、关闭仲裁或自动重试。租约失败标记 `dispatch=not_started`；没有该明确标记的 unknown 和部分执行结果保持 unknown，不能因后置检查失败重放。
6. 授权诊断接入既有 Computer Use trace，绑定发起 UI 的会话。仅记录 requestId、阶段和决定枚举，不记录 App、窗口、标签、卡片文字或错误正文。
   - 阶段：received、prompt_requested、decision、unavailable、expired、cancelled、ui_error、response_ack、response_error。
   - prompt_requested 仅证明调用了 UI API，不证明卡片实际显示或用户看到了；response_ack 仅证明 broker 接受了决定回复，不证明原生输入或业务成功。
   - 继承已有 trace 的关闭开关、私有权限和保留上限；没有新增对外上传或截图。

未改 broker wire version、helper 协议、原生代码、发行归档或活跃安装。保留显式 broker 开关的既有合同，但错误提示不再鼓励用它绕过仲裁。S2 不在本轮范围，pretest 仍是完整 typecheck。

## 离线验证

Node 24.18.0，独立开发 checkout；临时 socket、内存 broker、模拟时钟和 UI stub，没有连接真实 helper 或操作业务窗口。

| 检查 | 结果 |
| --- | --- |
| `node --test --experimental-strip-types --test-concurrency=2 'test/*.test.ts'` | 284/284 通过，0 跳过 |
| `node scripts/cu-v2-script-dry-run.mjs` | 38 checks，0 failing，3 个真机项目跳过 |
| 超时负对照 | 只把发送定时器恢复为旧的 45 秒预算，新回归失败；已恢复修复 |
| `npm run typecheck -- --pretty false` | 仍非零退出；146 项旧诊断，按文件/错误码/正文忽略位置变化比较，无新增 |
| 原先的 147 项为何少一项 | 租约结果提取后复用实际错误码类型，移除了 bridge 中过窄错误码联合导致的 TS2322；未扩大清理范围 |

新增回归覆盖：
- 子 agent 请求等待超过 45 秒时，父会话仍能授权；只有一次请求/一次授权/一个租约。
- 断线后取消 UI 信号，丢弃迟到决定；过期决定不因 timer 尚未执行而生效。
- server 异常通过同一请求 ID 即时回传；不伪装租约占用。
- 卡片接收、UI 请求、决定和回执的元数据；无 UI、过期、取消、UI 抛错及敏感内容不落诊断。
- broker 不可用时原生回调执行次数为 0，不再提示关闭仲裁或停止其他 agent；真正占用仍有持有者信息。
- 原有未知/部分执行结果不被改写为“未派发”；诊断落盘仍保持私有权限。

完整 typecheck 和 `npm test` 尚未全绿，原因与 S2 相同，不用直接运行单测的结果冒充该闸门通过。

## 下一步

维护者先审核本轮 diff；通过后再冻结、按 REVIEW-15 更正后的产品身份方案建立新的独立测试版。由用户手动复测授权卡片和一次后台点击，确认真实 App 效果及是否干扰前台。当前运行中的测试版没有更新，不在旧会话重试来验证本轮修复。
