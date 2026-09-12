# 文档与源码对齐审计（2026-09-12）

## 范围与结论

对审计开始时全部 97 份 Git tracked 文档（Markdown、文本、HTML 原型）做名称、链接/资源、显式路径扫描；结合 launcher、product config、package scripts、入口和关键实现核对当前用法。源码语义按领域重点检查，不是每条 API 的运行时证明；ignored 安装目录、私有会话和旧归档正文不作为当前文档修改对象。

项目仓库已确认是公开的 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom)（GitHub API HTTP 200，默认分支 `main`）。未发现 tracked 文档中指向旧 `dev-agent` 仓库的 HTTP/SSH URL；修正的是“尚未创建远端”、旧产品说明和本地断链。该维护 checkout 未配置 remote，本次不改 Git remote、不推送。

## 已整改

- 统一项目仓库入口；区分源码公开、npm `private` Alpha 与许可/正式发布。
- 修正 Qoder 默认 browser / 显式 qodercli、13 个资源文件、250K 实测输入与 272K 管理窗口的区别。
- 同步 Subagent、deferred-tools 重构路径及历史目录链接；移除已删除 flat/readiness 测试的失效链接，不恢复兼容壳。
- 历史实验增加时点边界和[重放说明](../../rotom/extensions/third-party/history/README.md)，保留原版本、失败、计数与授权限制。
- Computer Use 文档对齐默认禁止推测性重放、真实参数与可用检查；Goal 文档对齐源码入口和组合 no-progress 指纹。
- 修正 worker 的 fresh 默认、bundled skill 的 scoped fork/resume 限制；上游完整指南与产品工具面分开。
- 安装示例使用版本占位，澄清 `--force` 会删除同版本目录、独立 prefix 不适用全局卸载命令；设计原型同步品牌并标为 prototype。
- 保留上游 package/config 名、持久化 schema、eval identity、历史版本及许可证；不将这些当成改名遗漏。

## 验证与未覆盖项

- 最终 99 份文档（新增本报告和历史索引）、305 处非代码块链接/资源扫描：本地目标与锚点无失效项。按 Git tracked tree 核对，不以本机文件存在代替干净 checkout；研究员输出模板中的两个 `(url)` 是明确占位。
- `node --experimental-strip-types --test rotom/extensions/third-party/subagent/skill.test.ts`：2/2；首轮因新增说明超过既有篇幅上限失败，压缩文案后通过，未放宽测试。
- `git diff --check`；原型内联 JavaScript 语法和设计 metadata JSON 静态检查。没有界面布局/真实浏览器验收。
- Computer Use 维护副本仍缺上游 `typecheck` / `test:*` 所需文件；本轮纠正文档，不自动补代码或恢复发布工作流。
- Subagent 的本机 ignored `docs/agents.md` 不属于 tracked tree；文档改链到已验证 HTTP 200 的上游固定版本参考，当前 profile 默认值以源码为准。包内 guide/打包对遗漏文档的行为未在本轮修复或验收。
- 未检查所有外链的在线可达性，未重跑模型/平台/全量 runtime/发布 gate，也未重建或覆盖 vendor tgz、node_modules、全局安装。维护组件文档更新不等于旧归档内的文档已更新；随下一次授权组件发行接入。
