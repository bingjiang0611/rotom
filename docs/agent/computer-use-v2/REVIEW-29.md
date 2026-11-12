# Computer Use v2.1 第 29 轮审核：0.2.0 冻结修复（`main`，`8e1fe0c`）

## 结论

**接受 `8e1fe0c50273f50926709324c38d1c7dadbdfd25` 作为 0.2.0 的唯一构建源，可以执行一次 `pack:release`。** `ab7d49a` 作废。

## 核对

- **历史**：`main` 为 `4c7f7bb → ab7d49a → 3056b40（REVIEW-28）→ 8e1fe0c`，全部快进，作者和提交者都是 GitHub noreply。候选分支仍在 `4936306`，REVIEW-27 链接可达。
- **F1**：`rotom/package.json` 删除了 `publishConfig.tag`，`publishConfig` 恢复为 `{ access, registry }`；测试断言没有改。与 `4c7f7bb` 相比，
  `package.json` 唯一的变化是 `version` 从 `0.1.27` 到 `0.2.0`。
- **范围**：相对功能基线 `4c7f7bb` 只改了 `package.json` 的版本号和 5 份文档（含 REVIEW-28），没有产品代码、组件归档、锁文件或 Pi 构建器改动。
- **文档**：冻结记录写明 `ab7d49a` 作废；dist-tag 改为“由交接命令的 `--tag latest` 指定，`verify` 回读”；补上了隔离 HOME 在证据保存后删除、最终 tgz 放在隔离 HOME 之外并保留到 registry 核验完成、
  隔离 HOME 下找不到签名身份就停下且不碰钥匙串。发布说明同步。

## 审核者复现

- `runtime/distribution.test.mjs`：29 项，27 通过、2 失败；两项失败都是审核容器 Node 22 低于产品要求的 24，在 `4c7f7bb` 上同样失败。F1 那一项现在通过。
  执行方在 Mac 上用 Node 24.18.0 报告 29/29。
- `scripts/npm-release-handoff.test.mjs`：5/5。
- 带历史的审计（候选自带脚本，只含 `main` 与候选分支的完整克隆）：PASS，549 个提交，0 项。
- registry 只读查询 `@bingjiang0611/rotom@0.2.0`：HTTP 404，版本尚不存在。

## 小问题（不阻断，不要为此改包内容）

`STATUS.md` 仍写“冻结产品版本 0.2.0、tag/access/license”，其中的“tag”现在指交接命令的 dist-tag，而不是 manifest 字段。
STATUS 不进入发行包，可以在发布记录提交里顺手改；**不要**为此在打包前新增提交，否则冻结失效。

## 下一步

1. 在 `8e1fe0c` 的干净工作区执行一次 `npm run pack:release -- /absolute/output-dir`（输出目录不在仓库内，也不在之后的隔离 HOME 内）。失败或结果未知就停下报告，不自动重跑。
2. 按冻结记录第 2–5 步验收实际最终 tgz：记录文件数、压缩和解包大小、SHA-256、SRI，审计 tgz；隔离 HOME/prefix 安装与各项检查；
   受管 Mac 硬门禁（隔离路径、用户已有的 Apple Development 身份、真实启动、diagnostics 协议 11、PID 与可执行文件属于隔离副本）。被端点安全终止就停止发布。
3. 全部通过后，用 `node scripts/npm-release-handoff.mjs commands <absolute-final-tgz> latest` 生成命令，连同验收报告一起交回，等审核者核对后再交给用户执行。
