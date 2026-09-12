# 有界模型评测（仅明确授权后）

模型/容器/外部对象/付费调用需本次明确授权；此文件不构成自动运行许可。行内路径相对 dev-agent 仓库根。普通文档/定向检查见根指南与 SKILL.md，不预读本文件。

## 执行模型 gate

优先使用固定、版本化的任务清单。`rotom/evals/profiles/<profile>.txt` 第一条非空行必须精确为 `# dev-agent-benchmark-profile/v1`，之后每个非注释行使用 `<benchmark> <explicit-task-id>`；忽略空行和后续注释，并用 `parseBenchmarkProfileV1` 的测试合同拒绝缺失/未知版本、未知 benchmark、非法 ID 与重复项。当前 `canary.txt` 各固定一题，只是基础设施/明显回归 smoke，不是代表性样本；runner 不增加 `--profile`，逐行把匹配 benchmark 的 task id 传给现有 `--task`。

在固定清单尚未建立时：

- 可以用固定 profile 单题或 `--n-tasks=N` 验证 runner/认证/容器链路，但必须标记为“基础设施 smoke”；
- 不要把固定各一题或数据集的前 N 题称为代表性 canary；
- 不要临时挑选只对 candidate 有利的题；
- 报告 `INCONCLUSIVE`，并指出缺少固定题单。

使用当前 runner 的真实参数，不虚构 `profile` CLI：

```bash
cd rotom/evals
npm run benchmark -- swe-bench-multilingual \
  --provider="$ROTOM_EVAL_PROVIDER" \
  --model="$ROTOM_EVAL_MODEL" \
  --product=/absolute/path/to/candidate/rotom \
  --task=EXPLICIT_TASK_ID \
  --run-name=descriptive-candidate-name

npm run benchmark -- terminal-bench-2 \
  --provider="$ROTOM_EVAL_PROVIDER" \
  --model="$ROTOM_EVAL_MODEL" \
  --product=/absolute/path/to/candidate/rotom \
  --task=EXPLICIT_TASK_ID \
  --run-name=descriptive-candidate-name
```

用 `--dry-run` 先核对最终 Harbor argv。需要 Apple container 时默认使用 runner 的 `apple-container-amd64`；不要把 Rosetta/镜像/网络失败算成 Agent 0 分。

## 渐进扩容

1. 先跑受影响的微型 case 和 2–4 道固定 canary。
2. 出现明确产品回归时停止扩容，保留 artifacts 并定位根因。
3. 全部通过但样本不足以支持用户要求的结论时，扩到 8–12 道。
4. 结果方向冲突、随机性高或触及横切核心时，扩到 nightly 样本。
5. 只有发布级问题才继续 full。

不要用 4 道题证明“整体进步”；它们只能快速拒绝明显退化。

## 比较 baseline 与 candidate

- 优先复用最后一个有效 baseline artifact，避免每次把模型调用翻倍。
- 仅在 commit、product bundle、模型、thinking、dataset lock、环境、timeout、attempts 全部相容时复用。
- 模型别名行为、评测环境或 grader 变化时，重跑同题 baseline/candidate。
- candidate 包含无关 dirty WIP 时，创建隔离 worktree 或快照；不要把混合 bundle 当作本次改动结果。
- 同一任务比较最终 verifier/reward、环境状态、tool trace、token 和延迟。最终文本不是成功证据。
- 对二元小样本，优先汇报逐题 paired delta，不用一个百分比掩盖样本量。

## 保护凭据

- 不读取、复制或上传 subscription/API 凭据，除非用户对本次评测明确授权。
- 即使获得授权，也不得把 refresh token 放进不可信任务容器；只使用 runner 已实现并验证的短期 access-only 路径。
- 任务结束后删除容器内凭据；任何 artifact、日志、manifest 和命令输出都不得包含 token。
- access-only 路径尚未实现、token 有效期不足或认证状态不可验证时，停止模型 gate 并报告阻塞，不自行降级到其他 provider/model。

## 分类结果

使用以下四种结论之一：

- `PASS`：所选 gate 全部通过，且结论没有超出覆盖范围。
- `REGRESSION`：同配置 paired evidence 显示 candidate 比 baseline 退化。
- `INCONCLUSIVE`：样本不足、结果冲突、缺少稳定 baseline 或题单。
- `BLOCKED`：认证、镜像、Rosetta、网络、磁盘、grader 或其他基础设施阻止观察产品结果。

把失败分开记录：

1. Product：Agent 正常运行、verifier 正常执行，但 outcome 退化。
2. Infrastructure：安装、拉镜像、认证、限流、网络、容器或 verifier 自身失败。
3. Unknown：证据不足，不能归类。

基础设施失败不进入产品通过率分母；也不能静默丢弃。

## 汇报

最终交付保持下面的结构，先给结论：

```text
Decision: PASS | REGRESSION | INCONCLUSIVE | BLOCKED
Profile: fast | canary | nightly | full
Candidate / baseline: <commit or bundle sha>
Configuration: <model, thinking, environment, dataset lock, attempts>
Coverage: <tests and explicit task ids>
Product results: <paired pass/fail delta>
Infrastructure failures: <count and cause>
Cost/time: <observed, not guessed>
Last verified gate: <highest actually passed gate>
Unobserved: <what remains UNKNOWN>
Next expansion trigger: <when a larger profile is required>
```

不要把“安装成功”“启动成功”“单元测试通过”写成真实模型或外部服务 L3 已验收。不要把估算耗时写成实测耗时。
