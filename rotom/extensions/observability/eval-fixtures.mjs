// Synthetic-only fixture shared by API and browser checks; never a runtime resource.
import { mkdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
export const ATTACK = '<script>globalThis.evalInjected=1</script><img src=x onerror="globalThis.evalInjected=1">';
export async function fixtureSession(root, id = "synthetic-idle", { active = false, large = false } = {}) {
	await mkdir(root, { recursive: true });
	const timestamp = "2026-01-01T00:00:00.000Z";
	const records = [{ type: "session", version: 3, id, timestamp }];
	let parentId = null, index = 0;
	const message = (role, content, extra = {}) => {
		const entry = { type: "message", id: `entry-${index++}`, parentId, timestamp, message: { role, content, ...extra } };
		records.push(entry); parentId = entry.id;
	};
	message("user", `检查合成组件的边界条件。${ATTACK}`);
	message("assistant", [{ type: "text", text: "先读取并验证合成输入。" }, { type: "toolCall", id: "synthetic-call", name: "bash", arguments: { command: ATTACK + "x".repeat(3000) } }], { stopReason: "toolUse" });
	message("toolResult", [{ type: "text", text: ATTACK + "合成错误：" + "y".repeat(3000) }], { toolCallId: "synthetic-call", isError: true });
	if (large) for (let i = 0; i < 50; i++) message("user", `合成时间线 ${i} ${"z".repeat(2500)}`);
	message("assistant", [{ type: "text", text: "已定位合成边界错误，等待人工复盘。" }], { stopReason: "stop", usage: { input: 100, output: 40, cost: { total: 0.002 } } });
	const path = join(root, `${id}.jsonl`);
	await writeFile(path, records.map((row) => JSON.stringify(row)).join("\n") + "\n");
	if (!active) { const old = new Date(Date.now() - 10 * 60 * 1000); await utimes(path, old, old); }
	return path;
}
