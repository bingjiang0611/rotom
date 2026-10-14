# npm 0.1.22 发布记录

- 授权目标：`@bingjiang0611/rotom@0.1.22`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：维护者已在前台发布；registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节均已独立核验。维护者看到精确命令后，另行明确授权 Agent 执行安装；全局命令已切换到分版本目录中的 0.1.22，保留 0.1.21 和活跃会话。实际安装的 18,870 个文件与最终包字节一致。
- 唯一构建源：`044702dcd5c502e3ed129acef64ad4540e253abb`。只成功打包一次；53,055,254 字节、18,870 个文件。完整摘要和验证结果见 [机器可读证据](npm-0.1.22-verification.json)。

## 相对 0.1.21 的变更

- `rotom update` 支持按版本目录安装的布局，校验下载 integrity 后切换命令链接，保留旧版本与活跃会话；不再仅支持 npm global 安装。
- trace 记录 launcher 校验后的 rotom/Pi 版本；失败请求与压缩记录有界错误类别和 HTTP 状态，不记录错误正文，未知保持 unknown。
- 摘要更新重写当前状态并精简已完成工作；避免再次生成由 Pi 元数据携带的文件清单，保持扩展可见的完整旧摘要。长度为软目标，不降低输出上限或接受截断摘要。
- Subagent 缩短 8 个产品可见参数描述，减少 202 个公共 JSON 字节；参数校验、默认值、权限及执行行为不变。

## 验证范围和限制

- Pi fork 源码/归档 identity 检查通过；唯一 tgz 的独立隐私审计、隔离安装、default/full smoke、升级与卸载通过。分发 25 项、产品 328 项、Goal 87 项测试通过；18,870 个安装文件与 tgz 字节一致。
- 离线 Provider 和运行时合同门禁通过；旧的固定上下文观测基线仍为 DRIFT，属于已记录的参考差异，不冒充 PASS。首次两次 Node 只读 registry 核验超时；启用现有环境代理后，未修改的 handoff helper 核验通过，独立 curl 下载也与最终包字节一致。
- 已有真实长会话摘要重放和跨模型比较，见 [压缩验证记录](compaction-update-evaluation.md)。观测到输出减少，但样本有限，部分调用存在缓存差异；不宣称无损压缩、跨厂商泛化、多轮续跑准确率或美元节省。
- 不为此次发行恢复已经撤销的 context fold，不改个人重试/模型设置，不新增后台等待工具或 trace 保留策略。
- 本次发行 gate 不调用真实模型、浏览器或手机，不代替跨平台、真实 Chrome、终端 UI 或后续业务任务验收。

## 发布交接

遵循 [npm 分发合同](distribution.md) 和 [验证与交付](verification.md)。Agent 不执行 npm login/publish，不读取认证凭据；最终 tgz 验证通过后，用 `scripts/npm-release-handoff.mjs commands <absolute-tgz> latest` 生成分阶段命令，由维护者在自己的前台终端执行。

只有 registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配时，才记录发布成功、创建 release tag 并进入本机安装交接。
