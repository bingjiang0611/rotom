# 公开前隐私检查

> 以下“本轮”记录首次隐私清理与隔离验证，不是对当前公开版本重新审计的声明。项目仓库现为 [bingjiang0611/rotom](https://github.com/bingjiang0611/rotom)，npm 包现通过 `@bingjiang0611/rotom` 公开分发。后续上传/打包仍须对实际目标重新执行本页门禁，不能复用旧 PASS。

## 范围与清理策略

本轮检查的是 rotom 的本地源码、维护历史及 npm 归档，不代表已检查 GitHub 账号下的全部仓库。未创建远端、推送或发布 npm 包。

- 删除依赖私人安装路径的 recorder 自动发现/加载；可选公开集成仍须经过 identity 与 canonical path 验证。
- 移除依赖私人业务仓库结构的评测案例，将剩余示例改为独立通用 fixture。
- 清理维护者个人绝对路径、私人 App 标识和原始运行坐标；保留汇总验证结果、失败及实验局限，不用隐私清理掩盖负面结果。
- deferred state v1 只恢复当前声明的能力，忽略未知字符串 ID，不再保存私人旧平台名单。未知版本和结构损坏的记录不覆盖先前有效状态；resume/fork 仍保留 Subagent。
- `.pi/`、会话/凭据和本地构建状态通过 ignore 隐藏，不删除活跃状态。
- 干净初始仓库没有旧 reference commit 时，footprint 仍校验已冻结的当前合同，但历史源码差异标记为 unavailable / null；不伪造空 diff，也不为运行检查带回旧 Git 对象。

原维护历史保留在本机，不能直接推送。公开副本只复制清理后的 tracked 文件，在独立目录初始化全新 Git 仓库，以 GitHub noreply 身份建立初始提交；不复制原 `.git`、untracked 文件、宿主 HOME、node_modules 或凭据。公开副本还须检查所有 refs 的历史及提交者邮箱，不能仅凭工作树干净判定可发布。

## 可重复检查

需要 Python 3 与 Git，不联网、不上传文件、不调用模型：

```bash
python3 -m unittest discover -s scripts -p 'test_audit_public.py'
python3 scripts/audit-public.py --root .
# 对准备上传的独立仓库检查所有 refs 的历史：
python3 scripts/audit-public.py --root . --history
# 检查实际分发包，递归覆盖嵌套 vendor tgz：
python3 scripts/audit-public.py --artifact /absolute/path/to/rotom.tgz
```

`--deny-term` 可重复传入企业域名、私有 namespace 或个人标记。不要把这些真实值提交到公共规则文件，也不要把含私有历史路径的审计结果公开。脚本仅报告相对位置、分类和 digest，不回显命中正文；超预算、无法读取或无完整覆盖时返回非零。

检查项包括常见凭据形状/私钥块、个人 HOME 路径、内网地址/域名、凭据与状态文件、归档 symlink/path traversal，以及历史中的非 GitHub noreply 邮箱。`pack:release` 自动执行 tracked-tree 与实际归档检查；Git 全历史检查仍须独立执行。

## 上游内容与局限

锁定的第三方归档保持原始字节、integrity 和许可证。以下误报已逐行核对公开标签，只按文件路径与完整行 SHA-256 放行并单独计数，不放宽凭据规则：

- [pi-subagents v0.52.1 的 configuration.md](https://github.com/nicobailon/pi-subagents/blob/v0.52.1/docs/configuration.md)：一个作者 HOME 示例。
- [highlight.js 11.12.0 的 RouterOS 语法定义](https://github.com/highlightjs/highlight.js/blob/11.12.0/src/languages/routeros.js)：三行公开路由示例，ES/lib 两份构建中共有 14 次私网地址示例命中。

- Pi fork 导入的上游 revision `da840b6216578c2a571d0374ac6a2091a83f9d91` 中，CHANGELOG、containerization 文档、Doom 构建产物、overlay/footer/terminal 测试及 test.sh 的公开示例，按精确路径与完整行 SHA-256 放行（含示例 `internal-host`，不豁免凭据规则）；已逐行核对上游 Git 对象。两份上游录制会话 fixture 不带入，大型 compaction 测试使用合成数据。

- Pi 随附的 registry 依赖中，Node 类型声明、OpenAI 的公开 Google metadata endpoint、diff 的论文 DOI、Undici/clipboard 的示例和 FormData 的公开 Git 作者 URL，按 `scripts/pi-public-examples.json` 记录的 package/version/integrity 与精确路径/行摘要核对。AWS 两处 SDK 类型文档中的官方非秘密示例 AccessKey 使用独立的精确行例外；不豁免任意 credential-shaped 值，改行/改值/改路径仍阻断，有专门负向测试。

修改这些示例或在其他位置出现类似路径/地址仍会阻断。过短的额外标记也可能命中普通 identifier 或 integrity；应核对并收窄标记，不修改锁定依赖来消除误报。

Pi CLI/SDK 闭包随包携带后，实测 tgz 约 51 MiB，递归扫描约 263 MiB。因此归档输入上限为 64 MiB、累计扫描为 384 MiB；普通文件/归档成员仍为 32 MiB，嵌套深度仍有界，超限依然 BLOCKED，不跳过依赖或二次归档。

扫描是有界文本启发式，不是任意秘密不存在、二进制/OCR 内容安全、第三方供应链安全或代码所有权证明。未发现确认的真实密钥；若后续确认真实凭据泄露，应撤销/轮换，不能仅删文件或重建历史。

## 本轮复检

| 检查 | 结果 |
|---|---|
| 审计器确定性回归 | 10 passed，覆盖脱敏、嵌套归档、路径/链接、历史删除、noreply、预算和精确公开示例例外 |
| `check-personal` | 123 passed / 0 skipped；default runtimeContractGate PASS |
| runtime identity | 32 passed / 0 skipped |
| Chrome API fixture | 21 passed；不是真实 Chrome 交互 |
| eval typecheck / 基础设施 / adapters | PASS / 87 passed + 1 既有可选 skip / 9 passed；无模型 eval |
| 实际 tgz | pack gate PASS；3,786 个普通文件，含 vendor 的递归审计 PASS |
| 隔离 HOME/prefix 安装 | PATH 无全局 Pi，CLI 0.85.1；installed default/full smoke 与 footprint PASS，lifecycleErrors=0 |
| 无旧历史公开副本 | 独立 Git 初始提交，noreply 身份；tree + all-refs history 审计 PASS；重新安装公开依赖后 123 tests 与 default/full footprint PASS，旧 reference 明确 unavailable |

保留的失败：最初的工具面断言多列了一个不属于产品的 supervisor，已按实际 declaration 修正；一次 eval fixture 因外层 `umask 077` 把预期宽权限目录变成私有目录而失败，恢复测试预期 umask 后通过，未削弱生产权限；首次 tgz 审计被公开上游路由示例阻断，核对精确行后补充有界例外并成功重新构建。独立仓库首次检查误带 `ROTOM_OBSERVABILITY=0`，导致 8 个要求启用 trace 的 fixture 失败；移除测试环境中的该开关后 123 项通过，未修改产品禁用语义。原始日志保持私有，失败未当作无效尝试抹除。

未执行模型评测、真实业务操作、Chrome 重载、推送或公开发布。仅本机 Mac 验证，产品仍为私有 alpha；许可证、名称/IP 与第三方完整分发审查不由本轮隐私检查替代。
