import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { endReviewCases, endReviewFixturesIntact, scoreEndReviewState } from "../src/end-review-regressions.ts";
import { reviewStopping, stoppingVerdict } from "../src/end-review.ts";

const directories: string[] = [];
async function workspace() { const directory = await mkdtemp(join(tmpdir(), "end-review-test-")); directories.push(directory); return directory; }
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it.each(endReviewCases)("the independent existing judge validates the $id control", async (item) => {
	const directory = await workspace();
	for (const [name, body] of Object.entries(item.files)) await writeFile(join(directory, name), body);
	expect(await endReviewFixturesIntact(directory, item)).toBe(true);
	const run = spawnSync(process.execPath, ["verify.mjs"], { cwd: directory, encoding: "utf8", timeout: 5000 });
	expect(run.error).toBeUndefined();
	expect([0, 1]).toContain(run.status);
	const verification = await readFile(join(directory, "verification.json"), "utf8");
	expect(scoreEndReviewState(item, verification)).toBe(item.expected === "approved" ? 1 : 0);
	if (item.id === "geometry-not-state-invalid") expect(JSON.parse(verification).passed).toBe(true);
});

it("does not manufacture a successful preflight after protected files change", async () => {
	const item = endReviewCases[0];
	const directory = await workspace();
	for (const [name, body] of Object.entries(item.files)) await writeFile(join(directory, name), body);
	await writeFile(join(directory, "verify.mjs"), "// altered verifier");
	expect(await endReviewFixturesIntact(directory, item)).toBe(false);
});

it.each([
	[false, "satisfied", "approved", "approved"],
	[false, "user-blocked", "approved", "approved"],
	[true, "unsatisfied", "rejected", "rejected"],
	[true, "unsatisfied", "approved", "rejected"],
	[false, "unknown", "approved", "unknown"],
	[false, "satisfied", "rejected", "approved"],
] as const)("checks verdict consistency: remaining=%s finding=%s marker=%s", (localWorkRemaining, status, marker, expected) => {
	const report = JSON.stringify({ localWorkRemaining, requirements: [{ requirement: "Local work", status, evidence: "current.json" }], redundantModelVote: marker });
	expect(stoppingVerdict(report)).toBe(expected);
	// A contradictory model vote cannot override the structured findings.
	expect(stoppingVerdict(`${report}\n<${marker}/>`)).toBe("unknown");
});

it.each(["null", "{}", "[]", "not JSON", JSON.stringify({ localWorkRemaining: false, requirements: [] }), JSON.stringify({ localWorkRemaining: false, requirements: [{ requirement: "x", status: "satisfied", evidence: "" }] })])("refuses incomplete review schema: %s", report => {
	expect(stoppingVerdict(report)).toBe("unknown");
});

const usage = { input: 3, output: 2, cacheRead: 5, cacheWrite: 0, reasoning: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function response(content: unknown[], stopReason = "stop") { return { role: "assistant", content, stopReason, usage }; }
function context(cwd: string, complete: unknown) { return { cwd, model: { provider: "faux", id: "fixture" }, modelRegistry: { complete } } as ExtensionContext; }
const input = { task: "A blocked handoff is allowed after local work.", claim: "All local work is complete; device access is missing.", evidence: "Captured local verification succeeded.", requiredFiles: ["evidence.txt"] };

it("uses the existing file-only reader and records exact auxiliary usage without continuing", async () => {
	const directory = await workspace();
	await writeFile(join(directory, "evidence.txt"), "Local work is complete.");
	const complete = vi.fn()
		.mockResolvedValueOnce(response([{ type: "toolCall", id: "read-1", name: "review_read", arguments: { path: "evidence.txt" } }], "toolUse"))
		.mockResolvedValueOnce(response([{ type: "text", text: JSON.stringify({ localWorkRemaining: false, requirements: [{ requirement: "Local work", status: "satisfied", evidence: "evidence.txt" }] }) }]));
	const appendUsage = vi.fn();
	const signal = new AbortController().signal;
	const result = await reviewStopping(context(directory, complete), { appendUsage }, signal, input);
	expect(result.status).toBe("approved");
	expect(result.files.map(file => file.path)).toEqual(["evidence.txt"]);
	expect(result.reportedTokens).toBe(20);
	expect(appendUsage.mock.calls).toEqual([["end-review", "faux", "fixture", usage], ["end-review", "faux", "fixture", usage]]);
	expect(complete.mock.calls[0][2].signal).toBe(signal);
	expect(complete.mock.calls[0][1].systemPrompt).toContain("read-only stopping reviewer");
	expect(complete.mock.calls[0][1].systemPrompt).not.toContain("bounded completion reviewer");
	const firstUser = complete.mock.calls[0][1].messages[0];
	expect(firstUser.role).toBe("user");
	expect(firstUser.content).toContain("read-only stopping reviewer");
	expect(firstUser.content).toContain(input.task);
	expect(firstUser.content).not.toContain("bounded completion reviewer");
	expect(firstUser.content).not.toContain("Finish with exactly <approved/>");
	expect(() => JSON.parse(result.report)).not.toThrow();
	expect(complete.mock.calls[0][1].tools.map((tool: { name: string }) => tool.name)).toEqual(["review_read", "review_list"]);
	expect(await readFile(join(directory, "evidence.txt"), "utf8")).toBe("Local work is complete.");
});

it("does not run a review after cancellation", async () => {
	const complete = vi.fn();
	const abort = new AbortController(); abort.abort();
	const result = await reviewStopping(context(await workspace(), complete), { appendUsage() {} }, abort.signal, input);
	expect(result.status).toBe("unknown");
	expect(complete).not.toHaveBeenCalled();
});

it("preserves a provider error as unknown without retrying or inventing usage", async () => {
	const complete = vi.fn().mockResolvedValue({ ...response([], "error"), errorMessage: "fixture-provider-error" });
	const result = await reviewStopping(context(await workspace(), complete), { appendUsage() {} }, new AbortController().signal, input);
	expect(result.status).toBe("unknown");
	expect(result.report).toContain("fixture-provider-error");
	expect(complete).toHaveBeenCalledTimes(1);
});

it("does not turn a command attempt or an unsupported claim into approval", async () => {
	const directory = await workspace();
	const complete = vi.fn()
		.mockResolvedValueOnce(response([{ type: "toolCall", id: "write-1", name: "bash", arguments: { command: "touch owned" } }], "toolUse"))
		.mockResolvedValueOnce(response([{ type: "text", text: JSON.stringify({ localWorkRemaining: false, requirements: [{ requirement: "Local work", status: "satisfied", evidence: "evidence.txt" }] }) }]));
	const result = await reviewStopping(context(directory, complete), { appendUsage() {} }, new AbortController().signal, input);
	expect(result.status).toBe("unknown");
	expect(result.report).toContain("Required current files were not inspected");
	await expect(readFile(join(directory, "owned"))).rejects.toThrow();
});
