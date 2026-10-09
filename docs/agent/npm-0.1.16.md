# rotom 0.1.16

状态：已发布并独立核验 `0.1.16 / latest`。registry 的 version、dist-tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配唯一最终 tgz；构建源及验证见 [发行证据](npm-0.1.16-verification.json)。包 `@bingjiang0611/rotom`，access `public`，许可证 `UNLICENSED`。本次流程未执行全局升级，存活会话不自动迁移。

## 发行说明

- Bash/PowerShell 新增可选 `compact: true`，直接调用与 Codemode 结构化输出均限制为末尾 80 行 / 8 KiB；省略内容保存为可回读的私有完整日志。默认输出、退出码、超时和取消语义不变。
- edit 仅在写入前的纯匹配校验拒绝时明确提示本次未写入；不把写入异常或未知结果描述为可安全重试。
- 复用现有 coding-policy，强化路径证据复用、定向 diff/进程汇总、失败后重读，以及过滤日志时保留原检查退出码。
- 同步内置 Pi fork 构建归档、锁定身份和上下文静态字节基线；没有改 compaction、子代理生命周期或新增模型能力。

源码功能验收见 [工具执行卫生与源头输出控制报告](../../experiments/tool-efficiency-2026-10-09/RESULTS.md)：真实模型正式任务 26/26 通过，但自然 A/B 未证明整体减少 token、工具调用或成本，不能宣称普遍效率提升。源码验收不替代本次最终 tgz 的安装与发行检查。

## 发行边界

从最新公开 main 的独立干净 clone 冻结发布元数据，只对该 commit 成功构建一个最终 tgz。实际产物已通过隐私扫描、文件清单/摘要核验，以及隔离 HOME/prefix、PATH 无全局 Pi 的安装、版本、default/full SDK smoke、check-personal（312 产品测试、70 Goal 测试及 Provider/footprint 门禁）、0.1.15→0.1.16 升级与卸载验证。直接在 tgz 安装后的 SDK 验证了 compact 的 80 行上限、真实非零退出码、完整私有日志，以及 edit 拒绝后的文件未变。维护测试入口使用冻结 clone 和锁定依赖，Pi executable 来自实际安装包；产品 smoke 加载实际安装包资源。

构建首次因 npm 12.2 的 pack JSON 对象格式与现有数组合同不兼容，在 dry-run 阶段失败，未生成 tgz；最小复现后使用隔离 npm 11.13.0 成功构建。未修改全局 npm 或冻结源码。验证准备阶段补齐维护 workspace 依赖并移除错误继承的 observability 禁用变量，校正版本输出与 ESM 导入假设后通过；未修改产物、未重打包或放宽门禁。本次发行未新增真实模型、Chrome/设备或跨平台验收，源码阶段的真实模型结果不冒充最终产物的 L3 验证。

npm 登录与 publish 由用户前台终端执行，Agent 未读取凭据；随后独立完成 registry 和下载字节核验。本机全局升级另行交接，安装后旧会话仍须重启。临时 npm 认证注销及删除待用户在原前台终端完成。
