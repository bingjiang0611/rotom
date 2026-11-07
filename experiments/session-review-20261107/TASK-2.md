# 任务书 2：聚焦“停得不对”，并修正第一轮

先读 `VERIFY-1.md`。第 0 节的隐私规则与 `TASK.md` 完全相同，继续适用：仓库是公开的，原文、路径、项目名、URL、凭据一律不进仓库，全程只读。

窗口仍是第一轮的 7 天。统一传 `--now 2026-11-07T05:00:00Z`，保证两轮口径一致。

## A. 修正第一轮 findings.md（直接改文件）

1. §2.10：bash、codemode、browser_inspect、ask_user_question、subagent_wait 的 p50/p95 统一改用 `metrics.json` 里 `trace.toolDurationMs` 的值，并写明来源。
2. §2.9：删掉“更像调用合同使用不正确”。等 E 节做完再按证据重写。
3. §2.2：在 bash 那条后面注明“704 次是非零退出码，包含预期失败，不能等同于工具缺陷”。
4. “Jev 分类器”：问维护者这是什么。如果是私有工具，改成“本地分类器”。
5. `radius/*` provider：问维护者是不是内部网关名。如果是，`metrics.json` 里的 `radius` 统一换成 `custom_provider_1`，并在 findings §1 注明。

## B. 跑停点统计（只读）

```bash
node experiments/session-review-20261107/stop-context.mjs --days 7 --now 2026-11-07T05:00:00Z \
  --out experiments/session-review-20261107/results/stop-context.json \
  --samples "$TMPDIR/rotom-stop-samples.json"
```

脚本做的事：

- 统计 agent 每次把控制权交还用户时的结构特征：stopReason、最后一句是否以问号结尾、是否在征求许可、是否列了剩余步骤、是否声称完成、是否报告受阻；这一轮跑了多少工具、多长时间、有几次错误。
- 把用户的下一条消息分成 4 类：`bare_continue`（只说“继续”）、`bare_approve`（只说“可以/好/ok”）、`correction_keyword`、`other`。
- 另外统计用户中断（`aborted`）前这一轮的形态。
- 子 agent 会话跳过，因为它们没有真人回复。
- 文本只在本地做正则判断，不输出。

跑完人工过一遍 `stop-context.json` 的 `model` 键，有私有 provider 名就按 A.5 替换。

## C. 定性复查停点（这一轮的重点）

从 `$TMPDIR/rotom-stop-samples.json` 里抽样，尽量覆盖不同会话和不同模型：

- 15 个 `bare_continue`；
- 10 个 `bare_approve`；
- 10 个 `aborted`。

对每个样本，读 agent 交还控制权前的最后一条消息，以及之前这一轮的工具序列，然后归类。

**停太早**（用户回“继续”或“可以”）：

- `E1` 为一件已经授权的事征求许可，例如用户已经说过 full-send 或“做完为止”，agent 还在问“要不要我继续/推送”。
- `E2` 做完一个里程碑就停下，并列出剩余步骤，但这些步骤都在原请求范围内、而且可以执行。
- `E3` 声称完成，但其实没完成；用户的“继续”是在催它把剩下的做完。
- `E4` provider 出错或中断恢复后停住，没有自动接上。
- `E5` 报告受阻，但用现有工具其实能解决。
- `E6` 停得合理：确实需要用户决定，或涉及外部写入、费用、不可逆操作。用户随后批准是正常流程。
- `E7` 其他（写一句话转述）。

**停太晚**（用户中断）：

- `L1` 原地打转：重复同一条失败路径。
- `L2` 擅自扩大范围。
- `L3` 方向错了或理解错了需求。
- `L4` 长命令或长等待，用户不想再等。
- `L5` 用户只是想插话补充信息，不是 agent 的问题。
- `L6` 其他。

每个样本写一行：

```
| label | 类别 | 模型 | 一句话转述（不带原文） | 当时有没有“继续做完”的明确指令（有/无/不确定） |
```

汇总时回答：

1. 停太早里 E1–E7 的占比是多少？E1 + E2 + E3 + E5（不该停却停了）一共占多少？
2. 这些“不该停”的停点是否集中在某个模型（`qoder/dfmodel` 还是 `openai-codex/*`），或者集中在某一类任务？
3. coding-policy 已经要求“Keep going through next steps the request already covers……Stop and ask only for decisions the user owns”（`rotom/extensions/coding-policy/index.ts`）。违规样本的最后一条消息里，最常见的是哪种句式？用你自己的话写出 2–3 个模板，不要抄原文，例如“完成 X，下一步可以做 Y，需要我继续吗？”
4. 停太晚里 L1–L6 的占比。L1 和 L2 的样本中，中断前有没有可以提前识别的信号（连续错误、同一调用重复、改动扩散到新目录等）？
5. `bare_approve` 里，有多少是 agent 在问一个合理的问题（E6），有多少是问了不必问的问题（E1）？

## D. 两个未解释的数字

1. **`model_change` 921 条。** 抽 3–5 个 `model_change` 很多的会话，看每次切换发生在什么时候：会话启动、用户执行 `/model`、出错后、子 agent，还是扩展自动切换（比如 Reducer 用的 `gpt-5.6-luna`）。给出各类的大致数量。
2. **`subagent_wait` 的 17 次 timeout。** 统计这 100 次调用的 timeout 参数怎么分布：模型传了什么值，还是用的默认值（只报数字）。timeout 之后主会话下一步做了什么：再 wait、读状态、自己动手，还是放弃。timeout 时子 agent 实际处于什么状态：仍在运行、已经完成但没回报，还是卡住。

## E. find_roots 的 14 次错误

把这 14 条错误消息归并成**模板**，再报告每个模板的次数和所在会话数。归并时把 App 名、窗口标题、路径、pid、数字替换成 `<app>`、`<title>`、`<path>`、`<n>`。例如 `Root query '<title>' did not match any current root. Call find_roots to inspect roots.`

另外回答两个问题：失败是不是集中在每个会话的第一次调用？失败之后有没有成功的调用？

## 产出、审计与推送

- `results/stop-context.json`：B 节的脚本输出。
- `results/round2.md`：结构为
  1. A 节改了什么；
  2. C 节的样本表和 1–5 问的回答；
  3. D 节；
  4. E 节；
  5. 修订后的 Top 5 改进：如果第一轮的顺序需要调整，说明原因；
  6. 拿不准的地方。
- 同时提交修改后的 `results/findings.md` 和（可能被替换过的）`results/metrics.json`。

推送前：

```bash
git diff --check
python3 scripts/audit-public.py --root . --deny-term "<你的用户名>" --deny-term "<主要项目名>"
```

审计 PASS 后，只提交 `results/` 下的文件：

```bash
git add experiments/session-review-20261107/results/
git commit -m "docs(session-review): round 2 stop-point review and round 1 corrections"
git push -u origin claude/optimistic-einstein-soq1sd
```

如果需要改脚本，单独一个 commit，并写明原因。推送后回报 commit SHA 和审计的 status 行。
