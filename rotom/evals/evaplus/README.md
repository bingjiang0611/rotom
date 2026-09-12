# rotom · Eva+ 评测接入准备

当前状态：**PREPARED / 未在 Eva+ 沙箱验证**。此目录是维护适配器，不进入 npm 产品包。
`release.json` 的 `ready: false` 会使安装和运行都在外部动作之前退出；最终版本确定后再冻结产物。

## 接入合同

- 平台解析 `meta.yaml`，将 settings 作为环境变量传给 `install.sh` / `start.sh`。
- `install.sh` 安装经过 SHA256 校验的 Node 24.18.0 Linux x64/arm64 官方归档，以及 `release/rotom.tgz`（也可按 `release.json.productParts` 清单由最多 4 MiB 的分片重组，逐片和整包 SHA256 校验后安装）。使用产品 runtime/pi 独立锁文件及源码摘要固定的 Pi fork，不安装 stock Pi 代替 rotom。
- 脚本要求 Python >=3.11 且支持 `tarfile` 的 `data` extraction filter；目标首先是 Ubuntu 24.04 / Python 3.12。安装目录必须全新，重复或未知安装不会自动覆盖。
- `start.sh` 从绝对路径 `PROMPT_FILE` 读取原始任务，以 stdin 传给 `rotom --print --mode json`，不改变 case cwd、不将任务拼进 shell 命令。
- 模型仅使用显式 `API_KEY` / `BASE_URL` / `MODEL_NAME`；兼容 Chat Completions API。`CONTEXT_WINDOW` 和 `MAX_TOKENS` 必填，须按真实模型能力配置。`MAX_TOKENS` 是单次响应上限，不是整个任务 token 预算。
- `deepseek` 模型显式使用兼容端点的 `system` 角色、`max_tokens` 字段和 DeepSeek thinking 格式，不让 Idealab URL 被误识别为标准 OpenAI 端点。模型保持 reasoning-capable，使 `THINKING=off` 能向服务端发送 `thinking: {type: disabled}`，而不是只在客户端省略参数。
- Eva+ 沙箱中的 Idealab 流式连接实测会在结束帧前断开。适配器在随机 loopback 端口接收 Pi 的 SSE 请求，以非流式 Chat Completions 调用上游，再合成带 `finish_reason`、usage 和 `[DONE]` 的有界 SSE；子进程只持有一次性本机令牌，真实 API key 不进入其环境、文件或 argv。
- 使用每次运行独立 HOME / Pi 配置目录；不继承宿主凭据、Qoder 会话、用户模型配置或产品覆盖变量。代理与显式 CA 配置可继承。`models.json` 只写环境变量引用，密钥不写入文件或 argv。
- 使用完整产品的正常 CLI 和资源校验，并显式选择 `bash,read,write,edit` 作为 Terminal-Bench 工具面，覆盖沙箱内命令执行和文件修改。`--no-approve` 明确忽略 case 中可执行的 Pi 项目扩展配置，不静默信任其脚本；Browser/Computer Use、Goal 和 Subagent 与纯终端任务无关，不进入本轮模型请求。
- stdout 输出本适配器的 metadata JSON：状态、退出码、耗时、最终 message usage 累计和产品 identity。丢弃模型正文、工具正文、错误正文及中间流；`--no-session` 且关闭产品 trace。
- `status=completed` 只表示 Agent 正常结束。**题目是否通过由 Benchmark verifier 决定**；适配器不写 reward 文件，`score` 永远为 null。费用未知时 `cost=null`，不会将 Pi 默认零费率当成免费。
- 进程超时、事件不完整或输出溢出返回非零；没有自动重试。超时/退出时清理本次进程组，此行为不构成对恶意进程的安全隔离，最终隔离依赖平台 case 沙箱销毁。

## 最终版本交接

1. 在冻结并验证的产品 checkout 执行 `cd rotom && npm run pack:release -- /absolute/output-dir`。使用实际生成并通过审计的 tgz；不从开发目录复制 node_modules、会话或凭据。
2. 将产物放到独立适配仓库的 `release/rotom.tgz`，填写 `release.json` 的 `productVersion`、`productSha256`、`sourceCommit`。`ready` 最后改为 true。Node SHA256 已按官方 `https://nodejs.org/dist/v24.18.0/SHASUMS256.txt` 固定。
3. 已核对平台样例：`meta.yaml`、`install.sh`、`start.sh` 放在适配仓库根目录，`adapter.py`、`release.json` 同级；版本分支采用 `versions/<versionId>`。从本目录按文件白名单导出，新建独立历史，不复制本维护仓的 `.git`。`release/` 默认忽略，上传产物时须明确加入交付清单或选择已批准的制品分发方式。
4. 在 Ubuntu 24.04 的独立环境测试实际 `install.sh`，随后在仓库外的 case cwd 测试 `start.sh`；确认最终产品资源校验、模型工具往返、取消/超时和 verifier 均正常。
5. 在 Eva+ 项目内新增 Code Agent，解析适配仓库并选择精确版本。参数由平台配置，不提交密钥。检查平台所选模型与 `MODEL_NAME` 完全一致，避免实际使用另一模型但报告标错。
6. 新建“模型评测”，选择 Terminal-Bench 2.1 和搭载的 rotom，按 `plan.json` 的全量范围执行。任务“确定”会启动运行；仅保存模板也要求绑定模型与 Code Agent。

## 预定评测口径

2026-09-12 用户确认本轮使用 `bailian/deepseek-v4-flash` 跑 Terminal-Bench 2.1 全部 89 题，每题一次，不设置额外总费用和总时长上限。`TIMEOUT_SEC=0` 将逐题超时交给平台基准规则；适配器仍处理取消信号和子进程回收。当前并发 4、巡检关闭、稳定性重复关闭，基准判分不另加 LLM 裁判。

模型和总预算策略已确认。实际产品 identity 在独立交付目录冻结；平台数据集底层 commit、镜像和 verifier identity 仍待核对。名称同为 2.1 或均为 89 题不能证明与本地 Harbor registry 是相同 revision。实际比较时保留每次尝试，区分安装/认证/超时/判分失败；不通过重跑挑最佳成绩。

`plan.json` 是规划记录，不是平台执行器或费用熔断器。本适配器的 TIMEOUT_SEC 只限制单 case Agent 执行；不能控制模型请求前已消耗费用、安装时长或整个批次总预算。本轮用户已明确不设总预算上限；若后续要求有界预算，需要另行选择可执行的控制办法。

## 本地验证

```sh
python3 -m unittest discover -s rotom/evals/evaplus -p 'test_*.py' -v
bash -n rotom/evals/evaplus/install.sh rotom/evals/evaplus/start.sh
```

离线测试使用 fake Agent，只证明 adapter 的输入、配置、进程和结果合同。实际 tgz 安装检查单独记录，不由 fake Agent 测试代替；尚未执行真实模型请求或 Eva+ 沙箱评测。

2026-09-10 实际检查：adapter 11 项测试通过，shell 语法与 JSON 检查通过；eval harness typecheck 通过。现有 eval suite 在显式 Node 24 下为 86 通过、1 跳过、1 失败：`test/product-runtime.test.ts` 的预期资源列表未包含当前 `extension:qoder`。此次只新增独立适配目录，未修改该资源合同或测试；此失败单列，未扩大修复范围。

2026-09-12：adapter 12 项测试通过，含平台负责超时（`TIMEOUT_SEC=0`）时正常完成和 SIGTERM 回收；单 case 显式超时仍有覆盖。当前 Pi fork 源码/归档检查及 alpha.10 实际 tgz 构建审计通过。安装验证与候选 identity 保存在忽略的本地交付目录，不把维护仓 dirty HEAD 标作精确产品源码。

2026-09-12 后续：用户改用可调用的 `bailian/deepseek-v4-flash`（Idealab 文档对应 `deepseek-v4-flash-0731`），并发提高到 4。真实安装包的 macOS 模型/工具往返通过。首个全量 Eva+ 任务在上传 53 MB tgz 入沙箱时发生 `RUN_SANDBOX_UPLOAD_FAILED`，已中止；不是产品答题成绩。增加不超过 4 MiB 的传输分片，原始整包 SHA256 不变。14 项 adapter 测试通过，实际分片重组字节一致；平台 Linux 安装仍待验证。平台日志含沙箱操作内部重试，adapter 的无重试不能代表平台底层也不重试。

2026-09-12 传输排查：4 MiB 二进制分片仍在 release/rotom.tgz.part-000 上传失败，未进入安装。尚不能确定是二进制、子目录还是单文件大小限制；新增根目录 base64 文本分片，单片解码后不超过 512 KiB，逐片和整包 SHA256 校验后安装。15 项适配器测试通过。先用独立单题验证传输和 Linux 安装，再启动全部 89 题；基础设施试验独立记录，不作为产品分数或择优重跑。

2026-09-12：文本分片单题验证已通过 Linux 安装，随后 Agent 模型调用失败、usage 为 0。适配器新增固定枚举错误分类，不保存响应正文。独立诊断版本额外执行一次最小模型请求，仅报告 HTTP 状态、固定枚举网络错误与耗时；该版本不用于正式全量评分。

2026-09-12：进一步确认沙箱直连非流式请求成功，而 Pi 的流式请求约 35 秒后缺少 `finish_reason`。新增本机非流式桥接；18 项适配器测试通过，冻结 alpha.10 经桥接真实调用完成，usage 为 6124 tokens。Eva+ `build-cython-ext` 预检任务 `01a094c3-6534-71bf-977b-1f917551b5ef` 得分 100，含 52 轮交互和 72 次工具调用。全量 89 题任务 `01a094d0-aff9-79ab-ac7d-a3f685ec68ed` 已按并发 4 启动，最终结果待平台完成。
