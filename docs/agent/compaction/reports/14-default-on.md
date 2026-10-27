# 任务 14 · rotom 无配置文件时默认开启压缩卸载

## 结果与边界

已把 rotom 的无配置文件默认改为 Compaction Offload 开启，并通过 Action Fusion 组合的真实产品 faux 回归。本轮没有真实模型调用；LIVE_AUTHORIZATION 保持 null，所有旧付费授权仍已消费。

只改 rotom 第三方 wrapper、测试和文档。没有改 `packages/rotom-sol-pi/`、installed sol-pi 源码、vendor tgz、lockfile、product-config、Pi fork 或任何 package 版本；没有打包、发布、修改活跃安装或推送 main。依赖重装只发生在独立维护副本，归档与锁保持原样。

## A. 默认值与配置优先级

`rotom/extensions/third-party/sol-pi.ts` 中仅将 `ROTOM_SOL_PI_DEFAULT_CONFIG.compactionOffload` 改为 true，并同步注释。SoL-Pi 包自身 `DEFAULT_CONFIG.compactionOffload` 仍是 false。

| 输入 | 结果 |
| --- | --- |
| 没有配置文件，环境变量未设置/空 | rotom 默认开启 Action Fusion、Observation Pack、Reducer、Compaction Offload；只有 Online Context Compact 关闭 |
| 有用户配置文件，未写 compactionOffload | 文件完全替代 rotom 默认，该字段按 SoL-Pi 默认 false；不迁移旧配置 |
| 项目不受信 | 不读取项目 SoL-Pi 配置；仍按用户配置或 rotom 无文件默认处理 |
| ROTOM_COMPACTION_OFFLOAD=0 | 最后覆盖为关闭，包括无文件默认与文件显式 true |
| ROTOM_COMPACTION_OFFLOAD=1 且 Observation Pack 开 | 覆盖为开启，包括文件显式 false |
| =1 但 Observation Pack 关 | 保持关闭，只报一行 requires Observation Pack，不阻止启动 |
| 非法环境变量值 | 提示后忽略，保留解析出的配置 |

`index.test.ts` 更新默认断言，并补上默认 + =0、用户省略字段、用户 false + =1 的检查；保留受信/不受信项目与配置文件替代测试。Observation Pack 依赖同时检查结果和一行提示内容，避免仅检查默认 true 而让 =1 覆盖逻辑变成无效测试。

## B. Action Fusion + 卸载组合

新增 `rotom/evals/test/compaction-offload-fusion.test.ts`，使用仓内产品 Pi 的 AgentSession、真实 rotom wrapper、安装的 SoL-Pi 及真实本地文件工具。只有 provider 响应由 faux 脚本提供；全程禁止 fetch，不读取真实认证。

测试先确认隔离用户目录和项目中都没有 SoL-Pi 配置文件，再调用真实 `loadRotomSolPiConfig`，断言返回无文件默认对象及四项开启状态。随后把该对象仅将 Reducer 改为 false，写入隔离临时配置供正常产品 loader 加载。这是避免额外模型请求的测试注入，不是生产新增配置或写入用户文件；没有硬编码另一套默认组合，也没有绕过原 wrapper 注册工具。

实际轨迹：

1. 复用既有中等文件 fixture，分批读取并越过 64K 阈值，发生第一次 defer。
2. 用真实 Action Fusion `edit` 将临时文件从 before 改为 one；`then_run` 只运行本地 Node 检查文件内容并打印约 2.6 KiB 合成文本，不出网。
3. 第 14 轮调用 `obs_recall`，命中第 1 个卸载批次，工具未标记错误；断言召回包含完整原文件文本，而不只是指针或摘录。
4. 再读取既有文件，把第一次 edit 的中等文本结果推入旧上下文；第二次 defer 确实卸载该 edit 的 toolCallId。
5. 在该结果已被指针替换后，第二次 Action Fusion edit 将 one 改为 two，`then_run` 独立检查最终文件。
6. 第 22 轮召回第一次 edit 的结果，命中第 2 个卸载批次，未标记错误；断言完整原始 mutation + then_run 结果均可取回。

结果：**23 次本地 faux 响应，2 次 defer，0 次原生摘要，2 次召回均 offloaded=true/resultError=false；两次 edit 的 mutation=applied、followup=succeeded，最终文件确为 two。**

重要区别：中等大小的成功纯文本 Action Fusion 结果本来就属于卸载候选，不应虚构“edit 结果永不卸载”的规则。本测试走了任务要求的另一条验收路径：证明它被卸载后可以取回，并且之后的真实 edit 仍正常工作。原文比较在内存中完成，报告不保存工具输出正文。

负对照：临时把 rotom 默认恢复 false，新增测试在无文件默认断言处失败；恢复 true 后通过。随后完整重跑原有压缩专项及 eval 全量测试，负对照没有留在工作树。

## C. 文档

- 根 `CLAUDE.md` 仅替换第 3 节指定的半句，其余内容不动。
- 新增 `docs/agent/compaction-offload.md`，51 行：说明机制、开关、文件优先级、Observation Pack 依赖，直接摘录 11/13 的 9 个有效配对原值汇总，并指向 evals README。
- `docs/usage.md` 的功能表和小节改为“无配置文件时默认开启”；顺带将该小节旧的 .4 文案纠正为实际已安装/锁定的 .5，未修改包版本。
- vendor README 只同步 wrapper 当前默认描述，保留历史版本 .4 的 default-off 记录。

没有把九个小样本当作显著性结论：仅实测一个模型，64K 人为缩小阈值，付费回放内 Action Fusion 关闭；本次组合验证是 faux 且 Reducer 关闭。完整生产组合（含 Reducer 的真实模型运行）未验证，本轮也未授权该调用。测得秒数不能外推生产窗口、稳定节费或普遍加速。

## 验证

环境：Node v24.18.0、Vitest 4.1.9、产品 Pi 1.4.0-rotom.2、SoL-Pi 0.1.0-rotom.5。日志留在 `/tmp/rotom-offload-14.4dCAYx/`。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| npm ci，ignore-scripts/omit optional/legacy-peer-deps/replace-registry-host=never | PASS，锁文件不变 | install-official.log |
| 指定产品 ROTOM_PI 的 node --experimental-strip-types --test --test-concurrency=1 index.test.ts | 21/21 | third-party-tests.log |
| 新 Action Fusion 组合专项 | 1/1 | fusion-final.log |
| npx vitest run test/compaction-offload-eval.test.ts | 21/21，原 1/10/20-read 轨迹仍通过 | focused.log |
| 指定产品 ROTOM_PI / ROTOM_TEST_PI 的 npm test | 180 passed / 1 既有 sidecar skip，23 文件 | full-test.log |
| npm run typecheck | PASS | typecheck-final.log |
| 默认关闭负对照 | 按预期失败，已恢复 | default-negative.log |
| 长期文档与汇总值 | 51 行；链接有效，四行数字与 11/13 原报告逐项一致 | 独立脚本核对 |
| tracked-tree 公开扫描 | PASS，7,847 项，0 finding | audit-tree.json |
| tree+history 公开扫描 | BLOCKED，仅既有已接受的 12 条身份 finding，0 新增 | audit-history.json |

首次原样 npm ci 因本机 registry 不同于锁文件的官方 registry、且 allow-remote=none，被 EALLOWREMOTE 拒绝。显式添加 `--registry=https://registry.npmjs.org` 后成功；没有修改全局配置、放宽远程来源策略或修改锁文件。当前 PATH 没有 Pi，裸 node 测试也曾报无法解析 Pi dist；设置绝对仓内 ROTOM_PI 后通过，没有更改 runtime 查找规则。

历史扫描并非全绿：六个旧 commit 的 author/committer 各一条 non-noreply finding，digest 均为 cd29c5ac348a；未修改扫描规则或扩大这项历史例外。最终 diff 仅含八个任务文件；sol-pi 源码/归档、lockfile、product-config、包版本与 LIVE_AUTHORIZATION 所在文件没有改动。

## 本次提交大小门禁例外

普通 20,000-byte 门禁拒绝了任务要求修改的三份既有大文件。拆分会扩大范围，且不符合 CLAUDE 只改一处的要求。用户通过决策卡明确批准**仅本次、仅以下精确暂存 blob**：

| 文件 | bytes | 获批 blob |
| --- | --- | --- |
| CLAUDE.md | 27378 | 3bd54485dfd2dc57f8b6f6e0d565b22db7196beb |
| docs/usage.md | 32446 | 382a4c1ae3951d125132cbca5739b65aa8e9b1d3 |
| rotom/extensions/third-party/index.test.ts | 30998 | 10a3c7188f26352641bdbb3dea6aa4e749bc9f8a |

临时 hook 复制原门禁，只跳过这三个精确 blob，并绑定本次起始 HEAD；任一获批 blob 变化即拒绝，提交后 HEAD 变化也不能复用。其余文件仍走原 20,000-byte 检查，仓内脚本和长期 hook 配置不变。独立临时 index 的两个负对照已证明：新增超过上限的文件仍被拒绝；换掉获批 CLAUDE blob 也被拒绝。证据为 size-negative-oversize.log、size-negative-blob.log。临时 hook 在提交后清除，不形成长期豁免。

## 核验意见（规划者，2026-10-27）

**accepted（`677f89b`）。** 规划者在本环境（Node 24.22.1）重跑：第三方 `index.test.ts`（指定仓内产品 `ROTOM_PI`）11/11 ok，进程随后不退出、被外层 timeout 结束，这是本环境已知的 Node 进程不退出问题，与本改动无关；`compaction-offload-eval` 21/21；新增 `compaction-offload-fusion` 1/1；typecheck 通过；`git diff --check origin/main...HEAD` 干净；tracked-tree 公开审计 PASS、0 findings。全量 `npm test` 未重跑，采信报告的 180/1 skip。

- 改动面与任务一致：只改 rotom 默认（`compactionOffload: true`），sol-pi 包默认、归档、lockfile、product-config 都没动；配置文件语义保持「有文件就完全以文件为准」，文档写清了省略字段时为关。
- CLAUDE.md 只改了指定的半句；`docs/agent/compaction-offload.md` 的汇总表数字与 11/13 报告逐项一致，局限写得充分。

下一步：规划者开 PR 合入 main（任务 15）。
