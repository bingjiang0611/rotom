# 任务 01 执行报告：BLOCKED（持久化原子性合同待决定）

## 结论与交接

任务尚未实现，不申请 accepted。按任务说明“需要人决定时停下”的要求，在实现前停止：现有 Pi `appendEntry` 无法保证任务所要求的“任何异常 → 完全没发生”。已用合成 SessionManager 和真实文件系统错误复现，不是推测。

**需要规划者与 bob 决定**：

1. 修订任务 01 的持久化合同，允许追加失败留下 partial/unknown 状态，并明确失败记录如何判定、隔离、在切树/恢复时处理；还是
2. 保留严格的全有或全无要求，另开任务解决 Pi 持久化边界，再继续任务 01。

本执行者不自行选第 1 项降低验收要求，也不越界修改 Pi fork。规划者更新任务并由 bob 确认后，再继续实现。单纯换新版 Pi 不是已验证的解决方案：本分支仓内 fork 的 `_appendEntry` 也使用相同顺序。

## 实际改动与范围

| 文件 | 说明 |
|---|---|
| `docs/agent/compaction/reports/01-offload-mechanism.md` | 记录阻碍、复现方法、全部验收命令及待决定事项。 |

没有修改 `packages/rotom-sol-pi/` 代码、配置、测试或依赖锁；没有修改 `rotom/`、Pi fork、版本、vendor 归档。没有新增依赖或调用模型，没有读取或外发真实会话内容。

同步基线：`ba9288fd`（`origin/compaction/offload-first`）。原工作区在 `eval/system` 且有未提交的其他任务改动，因此采用独立 worktree 检出 `compaction/offload-first`，执行 `git fetch origin` 和 `git pull --ff-only origin compaction/offload-first`；未切换或清理原工作区。只交付本报告到任务分支，不推 main、不改写历史。

## 阻碍证据

任务要求先 `ensureStored`、再 `pi.appendEntry("sol-pi-compaction-offload", record)`、最后取消摘要；不变量 4 要求“一个推迟要么完整……要么完全没发生”。同时，投影集合必须从当前分支的所有卸载记录重建，旧 usage 判断依赖最新卸载记录。

实际调用链（本任务锁定的 npm Pi `1.3.0`）：

```text
ExtensionAPI.appendEntry
  → AgentSession 绑定的 appendEntry
  → SessionManager.appendCustomEntry
  → _appendEntry:
      fileEntries.push(entry)
      byId.set(entry.id, entry)
      leafId = entry.id
      _persist(entry)             ← 这里的磁盘错误在内存已更新后抛出
```

定位：

- 已安装 `@earendil-works/pi-coding-agent/dist/core/agent-session.js:2754`：扩展 API 委托 `appendCustomEntry`。
- 已安装 `dist/core/session-manager.js:815–819`：先更新内存、分支叶节点，再持久化。
- 仓内 `packages/rotom-pi/packages/coding-agent/src/core/session-manager.ts:1191–1195`：同样顺序（只读核对）。

复现结果：

```json
{"pi":"1.3.0","failure":"EISDIR","leafAdvanced":true,"inMemoryOffloadRecords":1,"onDiskOffloadRecords":0,"result":"atomicity requirement disproved"}
```

这意味着：即使 hook 捕获异常并返回 `undefined`，也不能声称“没有卸载记录”。后续按规定从分支重建时仍会读到这条记录，可能启用投影或被旧 usage 规则认作成功推迟。清空扩展自己的 Set 不能撤销 SessionManager 的分支记录。

没有改写会话历史、反射修改 Pi 私有字段、静默追加补偿记录或自动重试写入：这些都不是本任务授权的持久化合同。

### 可重跑的最小合成复现

在 `packages/rotom-sol-pi` 完成任务指定的 `npm ci` 后运行。它只创建临时合成会话，最后删除；不加载真实会话，不访问模型。

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';

const root = mkdtempSync(join(tmpdir(), 'offload-append-repro-'));
try {
  const manager = SessionManager.create(root, join(root, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Synthetic persistence check', timestamp: 1 });
  const file = manager.getSessionFile();
  const original = readFileSync(file, 'utf8');
  const leafBefore = manager.getLeafId();
  renameSync(file, `${file}.original`);
  mkdirSync(file); // 真实写入失败，不 mock appendEntry
  assert.throws(() => manager.appendCustomEntry('sol-pi-compaction-offload', {
    version: 1,
    toolCallIds: ['synthetic-call'],
    observationIds: ['obs_000000000000000000000000'],
    afterAssistantEntryId: 'synthetic-assistant',
    estimatedTokensBefore: 1100,
    estimatedTokensAfter: 500,
    thresholdTokens: 1000,
  }), { code: 'EISDIR' });
  assert.notEqual(manager.getLeafId(), leafBefore);
  const records = manager.getBranch().filter(e =>
    e.type === 'custom' && e.customType === 'sol-pi-compaction-offload');
  assert.equal(records.length, 1);
  assert.equal(readFileSync(`${file}.original`, 'utf8'), original);
  assert.equal(original.includes('sol-pi-compaction-offload'), false);
  console.log('EISDIR; leaf advanced; memory=1; disk=0');
} finally {
  rmSync(root, { recursive: true, force: true });
}
JS
```

## 验收命令与结果

环境：macOS、本任务独立 worktree、SoL-Pi `0.1.0-rotom.3`、锁定 npm Pi `1.3.0`、Vitest `4.1.11`。以下是**未改代码的基线结果**，不是新功能通过验收。

| 命令（前五条在 `packages/rotom-sol-pi`） | 结果 |
|---|---|
| `npm ci --ignore-scripts --registry=https://registry.npmjs.org --replace-registry-host=always` | 退出 0，安装 167 个包。npm 报告现有 8 项漏洞（6 moderate、2 high）；未越界运行 audit fix。 |
| `npm run typecheck` | 退出 0。 |
| `npx vitest run tests/compaction-offload.test.ts` | 退出 1，`No test files found`。任务停止，尚未创建此测试；不能算验收通过。 |
| `npm test` | 退出 1；19 个测试文件中 18 通过、1 失败；168 个用例中 166 通过、2 失败。仅为说明中已知的 `tests/install-guide.test.ts` 缺少组件 `AGENTS.md`、`CLAUDE.md` 两个用例，无新增基线失败。 |
| `npm pack --dry-run` | 退出 0，35 文件，49.5 kB 压缩 / 168.2 kB 解包。只是 dry-run，未重打 vendor 或安装发行版。 |
| `git diff --check origin/main...HEAD` | 退出 0；提交报告后再次核对。另用 `git diff --cached --check` 检查报告自身。 |
| `python3 scripts/audit-public.py --root .` | 退出 0，tracked-tree PASS，检查 7,793 文件、0 findings；报告已暂存，包含在扫描中。扫描不证明不存在任意秘密或知识产权问题。 |

### L1 与真实运行分开说明

- **L1 基线**：上述 typecheck 与现有测试；没有新的卸载机制测试通过。
- **本地合成复现**：真实 SessionManager、真实文件系统 `EISDIR`，证明底层追加不是失败原子的；不等于新卸载功能的 L2。上文报告内的完整复现命令也已独立执行通过。
- **L2**：未在 rotom 运行时安装或重放新机制；未执行新机制的真实 App 验证。
- **L3**：没有真实模型调用，无费用，无真实会话对照。推迟收益、`obs_recall` 频率、任务成功率、credits 均未知，仍归任务 03。

## 偏差、占位符及未完成项

- 唯一流程偏差是为保护其他任务 WIP 使用独立 worktree；未扩大写入范围。
- 遇到原子性合同冲突后按要求停止，而不是把 partial 状态写成成功。不是 Pi `reason` 字段类型不兼容问题。
- **卸载占位符实际样例和字节数：不适用。** 尚未实现生成函数，不能把手写示意称作实际输出；待任务恢复后由合成测试生成并补报。
- 候选筛选、持久化与恢复、旧 usage 去重、投影、ledger、配置与 faux-provider A/B/C/D 场景均未实现、未验证。
- 临时复现脚本与验收日志保留在本机任务 evidence 临时目录，未进仓库；合成会话目录已清理。独立 worktree 和 npm 安装依赖保留，便于恢复任务。

**下一步 owner：规划者与 bob。** 先明确上面的持久化合同选择，再向执行者下发继续指令；不要将这份 BLOCKED 报告视为任务 01 已完成。
