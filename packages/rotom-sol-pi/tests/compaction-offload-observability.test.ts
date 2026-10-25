import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it, vi } from "vitest";
import { createCompactionOffload, offloadCandidate, offloadRecords } from "../src/sol-pi/extensions/observation-pack/offload.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";
import { result } from "./compaction-offload-session.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "sol-pi-offload-observability-"));
	roots.push(root);
	const manager = new FakeSessionManager([], "synthetic", root);
	manager.appendMessage(fauxAssistantMessage("usage anchor"));
	const pi = new FakePi(manager);
	const ledger = vi.fn(async (_entry: Record<string, unknown>) => {});
	const ctx = fakeContext(manager, { getContextUsage: () => ({ contextWindow: 4000, tokens: 4500, percent: 112.5, usageTokens: 4500, trailingTokens: 0 }) });
	const offload = createCompactionOffload(pi.asExtensionApi(), () => ledger);
	const messages = [result(8192, "a"), result(8192, "b")];
	const event = { reason: "threshold", preparation: { messagesToSummarize: messages, turnPrefixMessages: [], tokensBefore: 4500, settings: { reserveTokens: 500 } } };
	return { root, manager, pi, ledger, ctx, offload, messages, event };
}

it("TUI failure does not undo a confirmed defer or stale cancellation", async () => {
	const { pi, ctx, manager, ledger, event } = await setup();
	vi.spyOn(console, "error").mockImplementation(() => {});
	ctx.mode = "tui";
	const notify = vi.fn(() => { throw new Error("synthetic UI failure"); });
	ctx.ui = { notify } as unknown as ExtensionContext["ui"];
	expect(await pi.emit("session_before_compact", event, ctx)).toEqual({ cancel: true });
	expect(offloadRecords(manager.getBranch())).toHaveLength(1);
	expect(await pi.emit("session_before_compact", event, ctx)).toEqual({ cancel: true });
	expect(notify).toHaveBeenCalledTimes(1);
	expect(ledger.mock.calls.at(-1)![0].event).toBe("offload_defer_stale");
});

it("TUI formats the English offload estimate with grouped digits", async () => {
	const { pi, ctx, manager, event } = await setup();
	const notify = vi.fn();
	ctx.mode = "tui";
	ctx.ui = { notify, setStatus: vi.fn() } as unknown as ExtensionContext["ui"];
	expect(await pi.emit("session_before_compact", event, ctx)).toEqual({ cancel: true });
	const record = offloadRecords(manager.getBranch())[0]!;
	const saved = record.estimatedTokensBefore - record.estimatedTokensAfter;
	expect(notify.mock.calls[0]![0]).toContain(`compaction deferred, ~${saved.toLocaleString("en-US")} context tokens offloaded`);
	expect(notify.mock.calls[0]![0]).toMatch(/~\d,\d{3} context tokens/u);
});

it.each(["session_start", "session_tree"])("cached projection skips I/O until %s resets it", async (eventName) => {
	const { pi, ctx, offload, messages, event } = await setup();
	vi.spyOn(console, "error").mockImplementation(() => {});
	await pi.emit("session_before_compact", event, ctx);
	const message = messages[0]!;
	const first = await offload.project(message, ctx);
	expect(first!.content[0]!.text).toContain("offloaded before compaction");
	await rm(offloadCandidate(message, runtimeRoot(ctx))!.observation.filePath);
	// If lstat/ensureStored ran again, a missing archive would fail open instead.
	expect(await offload.project(message, ctx)).toEqual(first);
	await pi.emit(eventName, {}, ctx);
	expect(await offload.project(message, ctx)).toBeUndefined();
});

it("validation cache keys include the runtime root", async () => {
	const { pi, ctx, offload, manager, messages, event, root } = await setup();
	vi.spyOn(console, "error").mockImplementation(() => {});
	await pi.emit("session_before_compact", event, ctx);
	expect(await offload.project(messages[0]!, ctx)).toBeDefined();
	const otherCtx = fakeContext(new FakeSessionManager(manager.getBranch(), "other-session", root));
	expect(runtimeRoot(otherCtx)).not.toBe(runtimeRoot(ctx));
	offload.restore(otherCtx);
	expect(await offload.project(messages[0]!, otherCtx)).toBeUndefined();
});

it("projection ledger failure does not hide a verified pointer", async () => {
	const { pi, ctx, offload, messages, event, ledger } = await setup();
	vi.spyOn(console, "error").mockImplementation(() => {});
	await pi.emit("session_before_compact", event, ctx);
	ledger.mockRejectedValue(new Error("synthetic ledger failure"));
	expect((await offload.project(messages[0]!, ctx))!.content[0]!.text).toContain("offloaded before compaction");
});
