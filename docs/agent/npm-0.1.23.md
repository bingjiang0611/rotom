# npm 0.1.23 发布记录

- 授权目标：`@bingjiang0611/rotom@0.1.23`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：维护者已在前台发布；registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节均已独立核验。维护者另行明确要求 Agent 全局安装；全局命令已切换到分版本目录中的 0.1.23，保留 0.1.22 及更早版本和活跃会话。实际安装的 18,870 个文件与最终包字节一致。
- 唯一构建源：`72be6144dc72131de834705309169f3fcad8fea1`。只成功打包一次；53,056,287 字节、18,870 个文件。完整摘要和验证结果见 [机器可读证据](npm-0.1.23-verification.json)。

## 相对 0.1.22 的变更

- coding-policy 新增排查推进规则：结束前，每个未决项要么用现有工具查清，要么写明受阻原因，要么交给具体负责人；“尚未确定 / 可能 A 或 B / 只读了开头”在能查清时不算结论。请求范围内的改动与测试继续做；外部写入、部署、费用与数据丢失仍须授权。
- 最终汇报的“下一步”改为：仍有未决项（含只诊断未修复的问题）时必填并放在最后，给出一个具体问题或带审批说明的提议动作。
- 新增 `follow-through.eval.ts` A/B 评测（不进入发行包）。`qoder/ultimate`、high thinking、真实 `AGENTS.md` 下，诊断题以具体下一步收尾 0/2 → 2/2，方案缺口题 0/2 → 1/2，简答对照题不变长；“浅查即停”在短 fixture 上未复现，相关规则无正向证据。详见 `rotom/evals/README.md`。

## 验证范围和限制

- Pi fork 源码/归档 identity 检查通过；唯一 tgz 的独立隐私审计、隔离安装、default/full smoke、升级与卸载通过。分发 25 项、产品 328 项、Goal 87 项测试和离线 Provider 9 项通过；18,870 个安装文件与 tgz 字节一致。
- 干净 clone 中 `check-personal` 前两次未通过，均为验证环境问题：未安装 fork 开发依赖与 `runtime/pi` 源码依赖（按 verification/architecture 现有说明 `npm ci` 后解决），以及传入的 Pi 路径不是 canonical realpath。产品与产物未改动，未重新打包。
- footprint 固定参考观测仍为 DRIFT，与 0.1.21/0.1.22 相同，属于已记录参考差异，不冒充 PASS。
- 首次 `npm publish` 因命令中 tgz 变量为空而在本地读取 `package.json` 失败（npm 日志显示 `publish ['.']`），未上传；registry 只读确认版本仍不存在后，以绝对路径执行一次成功。
- 本次发行 gate 不调用真实模型、浏览器或手机；follow-through 规则的真实模型证据仅来自上述 eval，样本 n≤2，不代替长会话或真实业务验收。

## 发布交接

遵循 [npm 分发合同](distribution.md) 和 [验证与交付](verification.md)。Agent 不执行 npm login/publish，不读取认证凭据；最终 tgz 验证通过后，用 `scripts/npm-release-handoff.mjs commands <absolute-tgz> latest` 生成分阶段命令，由维护者在自己的前台终端执行。

只有 registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配时，才记录发布成功、创建 release tag 并进入本机安装交接。
