# rotom 0.1.16

状态：用户已明确授权 `0.1.16 / latest`，发布准备中，尚未发布。包 `@bingjiang0611/rotom`，access `public`，许可证 `UNLICENSED`。

## 发行说明

- Bash/PowerShell 新增可选 `compact: true`，直接调用与 Codemode 结构化输出均限制为末尾 80 行 / 8 KiB；省略内容保存为可回读的私有完整日志。默认输出、退出码、超时和取消语义不变。
- edit 仅在写入前的纯匹配校验拒绝时明确提示本次未写入；不把写入异常或未知结果描述为可安全重试。
- 复用现有 coding-policy，强化路径证据复用、定向 diff/进程汇总、失败后重读，以及过滤日志时保留原检查退出码。
- 同步内置 Pi fork 构建归档、锁定身份和上下文静态字节基线；没有改 compaction、子代理生命周期或新增模型能力。

源码功能验收见 [工具执行卫生与源头输出控制报告](../../experiments/tool-efficiency-2026-10-09/RESULTS.md)：真实模型正式任务 26/26 通过，但自然 A/B 未证明整体减少 token、工具调用或成本，不能宣称普遍效率提升。源码验收不替代本次最终 tgz 的安装与发行检查。

## 发行边界

从最新公开 main 的独立干净 clone 提交并冻结本次发布元数据；只对冻结 commit 成功构建一个最终 tgz。实际产物须完成隐私扫描、文件清单/摘要核验，以及隔离 HOME/prefix、PATH 无全局 Pi 的安装、版本、default/full SDK smoke、check-personal、0.1.15→0.1.16 升级及卸载验证。

npm 认证与最终 publish 命令交给用户前台终端，Agent 不读取凭据；只有 registry version/tag/integrity/shasum、可信 tarball URL 和下载字节全部一致才记录正式发布完成。npm 审核中不得重发；本机全局升级及旧会话重启另行交接，不由发布授权自动推断。
