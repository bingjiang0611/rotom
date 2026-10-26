import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it } from "vitest";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { offloadCandidate, offloadRecords } from "../src/sol-pi/extensions/observation-pack/offload.ts";
import { estimateTokens } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";
import { result } from "./compaction-offload-session.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(text: string) {
 const dir = await mkdtemp(join(tmpdir(), "offload-calibration-")); roots.push(dir);
 const manager = new FakeSessionManager([], "calibration", dir);
 manager.appendMessage({ role: "user", content: "synthetic request", timestamp: 1 });
 manager.appendMessage(fauxAssistantMessage("synthetic response"));
 const messages = [result(8192, "call-a"), result(8192, "call-b")];
 for (const message of messages) { message.content = [{ type: "text", text }]; manager.appendMessage(message); }
 const pi = new FakePi(manager);
 const ctx = fakeContext(manager, { getContextUsage: () => ({ contextWindow: 4000, tokens: 4500, percent: 112.5, usageTokens: 4500, trailingTokens: 0 }) });
 createObservationPackExtension({ compactionOffload: true })(pi.asExtensionApi());
 await pi.emit("session_start", {}, ctx);
 const event = { type: "session_before_compact", reason: "threshold", preparation: {
  messagesToSummarize: [messages[0]], turnPrefixMessages: [messages[1]], tokensBefore: 4500, settings: { reserveTokens: 500 },
 } };
 const ledger = async () => (await readFile(join(runtimeRoot(ctx), "observation-pack/ledger.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
 return { pi, ctx, manager, event, messages, ledger };
}

it("replays system sections and tool deltas instead of counting only the last system message", async () => {
 const text = "// ordinary source line\n".repeat(350);
 const { pi, ctx, manager, event, messages, ledger } = await fixture(text);
 const base = "base instruction\n".repeat(1000), policy = "replacement policy";
 const tool = { name: "current", description: "current tool", parameters: { type: "object", properties: {} } };
 manager.appendMessage({ role: "system", content: base, sections: { policy: "old policy".repeat(1000) },
  toolsAdded: [{ ...tool, name: "removed", description: "old description".repeat(1000) }], timestamp: 2 });
 manager.appendMessage({ role: "system", content: "", sections: { policy }, toolsRemoved: [{ name: "removed" }], toolsAdded: [tool], timestamp: 3 });
 ctx.getSystemPrompt = () => base + policy;
 const saved = messages.reduce((sum, message) => {
  const c = offloadCandidate(message, runtimeRoot(ctx))!;
  return sum + c.observation.tokens - estimateTokens(c.placeholder);
 }, 0);
 const contextEstimate = 2 * estimateTokens(text) + estimateTokens("synthetic request") + estimateTokens("synthetic response") +
  estimateTokens(base + policy + JSON.stringify([tool]));
 expect(await pi.emit("session_before_compact", event, ctx)).toBeUndefined();
 expect((await ledger()).at(-1)).toMatchObject({ reason: "insufficient_savings" });
 expect((await ledger()).at(-1).after).toBeCloseTo(4500 * (1 - saved / contextEstimate));
});

it.each(["hexadecimal", "ordinary code"])("calibrates %s savings to reported usage, without promising arbitrary scale invariance", async (kind) => {
	const text = (kind === "hexadecimal"
		? Array.from({ length: 130 }, (_, i) => `// ${createHash("sha256").update(String(i)).digest("hex")}\n`).join("")
		: "// Validate the request and return the result.\nexport const value = 17;\n".repeat(130)).slice(0, 8192);
	for (const scale of [1, 2.3, 100]) {
		const { pi, ctx, manager, event, messages, ledger } = await fixture(text);
		event.preparation.tokensBefore *= scale;
		const saved = messages.reduce((sum, message) => {
			const candidate = offloadCandidate(message, runtimeRoot(ctx))!;
			return sum + candidate.observation.tokens - estimateTokens(candidate.placeholder);
		}, 0);
		const contextEstimate = 2 * estimateTokens(text) + estimateTokens("synthetic request") + estimateTokens("synthetic response");
		const oldAfter = event.preparation.tokensBefore - saved;
		const after = event.preparation.tokensBefore * (1 - saved / contextEstimate);
		expect(oldAfter <= 0.6 * 3500).toBe(scale === 1);
		const result = await pi.emit("session_before_compact", event, ctx);
		expect((await ledger()).at(-1).after).toBeCloseTo(after);
		if (scale < 100) {
			expect(result).toEqual({ cancel: true });
			expect(offloadRecords(manager.getBranch())[0]!.estimatedTokensAfter).toBeCloseTo(after);
		} else {
			expect(result).toBeUndefined();
			expect((await ledger()).at(-1).reason).toBe("insufficient_savings");
		}
	}
});
