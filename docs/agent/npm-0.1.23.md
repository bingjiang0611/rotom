# npm 0.1.23 发布记录

- 授权目标：`@bingjiang0611/rotom@0.1.23`，dist-tag `latest`，access `public`，许可证 `UNLICENSED`。
- 状态：发布元数据已冻结；尚未打包、发布或核验 registry。

## 相对 0.1.22 的变更

- coding-policy 新增排查推进规则：结束前，每个未决项要么用现有工具查清，要么写明受阻原因，要么交给具体负责人；“尚未确定 / 可能 A 或 B / 只读了开头”在能查清时不算结论。请求范围内的改动与测试继续做；外部写入、部署、费用与数据丢失仍须授权。
- 最终汇报的“下一步”改为：仍有未决项（含只诊断未修复的问题）时必填并放在最后，给出一个具体问题或带审批说明的提议动作。
- 新增 `follow-through.eval.ts` A/B 评测（不进入发行包）。`qoder/ultimate`、high thinking、真实 `AGENTS.md` 下，诊断题以具体下一步收尾 0/2 → 2/2，方案缺口题 0/2 → 1/2，简答对照题不变长；“浅查即停”在短 fixture 上未复现，相关规则无正向证据。详见 `rotom/evals/README.md`。

## 发布交接

遵循 [npm 分发合同](distribution.md) 和 [验证与交付](verification.md)。Agent 不执行 npm login/publish，不读取认证凭据；最终 tgz 验证通过后，用 `scripts/npm-release-handoff.mjs commands <absolute-tgz> latest` 生成分阶段命令，由维护者在自己的前台终端执行。

只有 registry 的精确版本、latest tag、integrity、shasum、可信 tarball URL 与下载字节全部匹配时，才记录发布成功、创建 release tag 并进入本机安装交接。
