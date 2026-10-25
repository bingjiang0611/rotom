import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCards, collectLabels, errorBreakdown, sessionStats } from "../scripts/session-cards.mjs";
import { callFingerprint } from "../scripts/command-failures.mjs";

const cli = fileURLToPath(new URL("../scripts/session-cards.mjs", import.meta.url));
const timestamp = "2026-01-01T00:00:00.000Z";
const basicFindings = {
	"repeat-after-error": "clear", "ended-after-tool-error": "unknown", "ended-on-provider-error": "clear",
	"schema-errors": "unknown", "oversized-tool-result": "unknown", "harness-fault": "unknown",
};
const basicFindingCounts = Object.fromEntries(Object.entries(basicFindings).map(([rule, status]) => [rule, {
	hit: 0, clear: status === "clear" ? 1 : 0, unknown: status === "unknown" ? 1 : 0,
}]));
const text = (value: string) => ({ type: "text", text: value });
const header = (id: string) => ({ type: "session", id, timestamp, cwd: "/synthetic/project", version: 3 });
const message = (id: string, parentId: string | null, role: string, content: unknown, extra = {}) => ({
	type: "message", id, parentId, timestamp,
	message: { role, content, ...extra },
});
const assistant = (id: string, parentId: string, content: unknown, extra = {}) => message(id, parentId, "assistant", content, {
	provider: "synthetic", model: "fixture", stopReason: "stop", usage: { input: 10, output: 4, cacheRead: 2 }, ...extra,
});
const basic = (id: string) => [header(id), message("u", null, "user", "SYNTHETIC_REQUEST"), assistant("a", "u", [text("SYNTHETIC_REPLY")])];
const digest = (id: string) => createHash("sha256").update(id).digest("hex");
const span = (kind: string, spanId: string, attributes: Record<string, string | number>, traceId = "trace") => ({
	schema: "rotom-local-trace/v1", kind, spanId, traceId, name: "pi.tool.execute", attributes,
});

let directory: string;
let root: string;
let out: string;
async function session(id: string, entries: unknown[] = basic(id), folder = root) {
	await mkdir(folder, { recursive: true });
	const path = join(folder, `${id}.jsonl`);
	await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}
async function trace(id: string, records: unknown[], suffix = "") {
	const folder = join(root, "observability");
	await mkdir(folder, { recursive: true });
	const path = join(folder, `${id}.trace.jsonl`);
	await writeFile(path, records.map((entry) => JSON.stringify(entry)).join("\n") + "\n" + suffix);
	return path;
}
const card = (id: string) => readFile(join(out, `${id}.md`), "utf8");
async function label(id: string, verdict: string, categories: string, note = "") {
	const block = `<!-- label:begin -->\nverdict: ${verdict}\ncategories: ${categories}\nnote: ${note}\n<!-- label:end -->\n`;
	await writeFile(join(out, `${id}.md`), (await card(id)).replace(/<!-- label:begin -->[\s\S]*$/, block));
	return block;
}
function run(...args: string[]) {
	return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

beforeEach(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "rotom-session-cards-test-")));
	root = join(directory, "sessions");
	out = join(directory, "private", "cards");
	await mkdir(root);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("session cards", () => {
	it("breakdown classifies commands in memory, joins labels and excludes abandoned calls", async () => {
		const command = "rg SYNTHETIC_COMMAND_SECRET";
		const args = { command };
		const entries: unknown[] = [header("private-loop-session"), message("u", null, "user", "PRIVATE_USER_TEXT"),
			assistant("abandoned", "u", [{ type: "toolCall", id: "abandoned-call", name: "bash", arguments: { command: "npm test" } }])];
		let parent = "u";
		for (let index = 0; index < 4; index++) {
			entries.push(assistant(`a${index}`, parent, [{ type: "toolCall", id: `c${index}`, name: "bash", arguments: args }]));
			entries.push(message(`r${index}`, `a${index}`, "toolResult", [text("PRIVATE_RESULT_TEXT")], { toolCallId: `c${index}`, isError: true, details: { exitCode: 1 } }));
			parent = `r${index}`;
		}
		await session("private-loop-session", entries);
		await session("private-good-session");
		await trace("private-loop-session", [span("span_end", "c0", { "pi.tool.call_id_digest": digest("c0"), "pi.tool.outcome": "tool_error", "pi.tool.exit_code": 1 })]);
		await mkdir(dirname(out), { recursive: true });
		const labelPath = join(dirname(out), "labels.jsonl");
		const labelText = [{ sessionId: "private-loop-session", verdict: "fail", note: "PRIVATE_LABEL_NOTE" }, { sessionId: "private-good-session", verdict: "pass" }, { sessionId: "outside-window", verdict: "fail" }].map((row) => JSON.stringify(row)).join("\n");
		await writeFile(labelPath, labelText);
		const result = run("breakdown", "--root", root, "--out", out);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		const data = JSON.parse(result.stdout).commandFailures;
		expect(data.categories.search.bash).toEqual({ calls: 4, failures: 4, unknown: 0, searchExit1: 4, rate: 1, share: 1 });
		expect(data.categories.test.bash.calls).toBe(0);
		expect(data.sources).toEqual({ trace: 1, toolResult: 3, unknown: 0 });
		expect(data.loops).toMatchObject({ retries: 3, loopingSessions: 1, longest: { n: 2, median: 2, p90: 4 } });
		expect(data.labels).toEqual({ available: true, n: 2, looping: { pass: 0, fail: 1 }, nonLooping: { pass: 1, fail: 0 } });
		const markdown = await readFile(join(dirname(out), "breakdown.md"), "utf8");
		for (const secret of [command, "SYNTHETIC_COMMAND_SECRET", "PRIVATE_USER_TEXT", "PRIVATE_RESULT_TEXT", "PRIVATE_LABEL_NOTE", digest("c0"), callFingerprint("bash", args)]) {
			expect(result.stdout).not.toContain(secret);
			expect(markdown).not.toContain(secret);
		}
		expect(result.stdout).not.toContain("private-loop-session");
		expect(result.stdout).not.toContain("private-good-session");
		expect(markdown).toContain("private-loop-session");
		expect(markdown).toContain("n=2");
		expect((await stat(join(dirname(out), "breakdown.md"))).mode & 0o777).toBe(0o600);
		expect(await readFile(labelPath, "utf8")).toBe(labelText);
		await writeFile(labelPath, "invalid labels\n");
		await expect(errorBreakdown({ root, out })).rejects.toThrow("Invalid labels input");
		expect(await readFile(join(dirname(out), "breakdown.md"), "utf8")).toBe(markdown);
	});
	it("renders only the leaf branch, including its aggregates and final assistant", async () => {
		await session("branches", [
			header("branches"), message("u", null, "user", "ROOT_REQUEST"),
			assistant("abandoned", "u", [text("ABANDONED_BRANCH"), { type: "toolCall", id: "old-call", name: "old-tool", arguments: {} }], { usage: { input: 999 } }),
			message("new-user", "u", "user", [text("CURRENT_BRANCH")]),
			{ type: "model_change", id: "model", parentId: "new-user", timestamp, provider: "synthetic", modelId: "second" },
			{ type: "compaction", id: "compact", parentId: "model", timestamp, tokensBefore: 123 },
			assistant("last", "compact", [text("CURRENT_FINAL")]),
			{ type: "future_entry", id: "future", parentId: "last", timestamp: "2026-01-01T00:00:05.000Z" },
		]);
		const result = await buildCards({ root, out });
		expect(result).toMatchObject({ generated: 1, traceMissing: 1, unknownEntries: 1 });
		const rendered = await card("branches");
		for (const value of ["ROOT_REQUEST", "CURRENT_BRANCH", "CURRENT_FINAL", "tokensBefore=123", "model_change: synthetic/second", 'duration: "5000ms"', "turns: 1", "tool_calls: 0", 'tokens: {"input":10,"output":4,"cacheRead":2}', 'stop_reasons: {"stop":1}', "trace: missing"]) expect(rendered).toContain(value);
		expect(rendered).not.toContain("ABANDONED_BRANCH");
		expect(rendered).not.toContain("old-tool");
		expect(rendered).not.toContain("999");
	});

	it("joins split start/end attributes by trace/span identity and tool-call digest, not order", async () => {
		const input = await session("joined", [header("joined"), message("u", null, "user", "request"),
			assistant("a", "u", [
				{ type: "toolCall", id: "call-one", name: "bash", arguments: { command: "synthetic" } },
				{ type: "toolCall", id: "call-two", name: "read", arguments: {} },
			]),
			message("r2", "a", "toolResult", [text("RESULT_TWO")], { toolCallId: "call-two", toolName: "read" }),
			message("r1", "r2", "toolResult", [text("RESULT_ONE"), { type: "image", data: "DO_NOT_RENDER_IMAGE_DATA" }], { toolCallId: "call-one", toolName: "bash", isError: true }),
		]);
		const tracePath = await trace("joined", [
			span("span_start", "same", { "pi.tool.call_id_digest": digest("call-two"), "pi.tool.name": "read" }, "two"),
			span("span_start", "same", { "pi.tool.call_id_digest": digest("call-one"), "pi.tool.name": "bash" }, "one"),
			span("span_end", "same", { "pi.tool.outcome": "tool_error", "pi.tool.fault_side": "environment" }, "one"),
			span("span_end", "same", { "pi.tool.outcome": "ok" }, "two"),
			span("span_end", "unrelated", { "pi.tool.call_id_digest": digest("another-branch"), "pi.tool.outcome": "timeout" }),
		]);
		const before = await Promise.all([input, tracePath].map((path) => readFile(path)));
		expect(await buildCards({ root, out })).toMatchObject({ generated: 1, parseErrors: 0, traceMissing: 0, tracePartial: 0 });
		const rendered = await card("joined");
		expect(rendered).toContain('bash {"command":"synthetic"} → outcome=tool_error fault=environment · 结果：RESULT_ONE');
		expect(rendered).toContain("read {} → outcome=ok fault=unknown · 结果：RESULT_TWO");
		expect(rendered).toContain("(image)");
		expect(rendered).not.toContain("DO_NOT_RENDER_IMAGE_DATA");
		expect(rendered).toContain('tool_errors: {"tool_error":1}');
		expect(rendered).toContain("trace: ok");
		expect(await Promise.all([input, tracePath].map((path) => readFile(path)))).toEqual(before);
	});

	it("keeps valid trace evidence when the last line is truncated", async () => {
		await session("partial", [header("partial"), message("u", null, "user", "request"), assistant("a", "u", [{ type: "toolCall", id: "call", name: "bash", arguments: {} }])]);
		await trace("partial", [span("span_start", "s", { "pi.tool.call_id_digest": digest("call") }), span("span_end", "s", { "pi.tool.outcome": "ok" })], '{"schema":');
		expect(await buildCards({ root, out })).toMatchObject({ generated: 1, tracePartial: 1, parseErrors: 1 });
		expect(await card("partial")).toContain("trace: partial");
		expect(await card("partial")).toContain("outcome=ok");
	});

	it("marks an unfinished tool span partial instead of inventing a successful outcome", async () => {
		await session("unfinished", [header("unfinished"), message("u", null, "user", "request"), assistant("a", "u", [{ type: "toolCall", id: "call", name: "bash", arguments: {} }])]);
		await trace("unfinished", [span("span_start", "s", { "pi.tool.call_id_digest": digest("call") })]);
		expect(await buildCards({ root, out })).toMatchObject({ tracePartial: 1 });
		expect(await card("unfinished")).toContain("outcome=unknown");
		expect(await card("unfinished")).toContain("tool_errors: {}");
	});

	it("preserves a filled annotation byte-for-byte while refreshing the body", async () => {
		const path = await session("preserve");
		await buildCards({ root, out });
		const block = await label("preserve", "fail", "one, two", "first line\nsecond line  ");
		await appendFile(path, JSON.stringify(assistant("new", "a", [text("UPDATED_REPLY")])) + "\n");
		await buildCards({ root, out });
		const rendered = await card("preserve");
		expect(rendered.endsWith(block)).toBe(true);
		expect(rendered).toContain("UPDATED_REPLY");
		expect(rendered).toContain("turns: 2");
		expect(rendered).toContain('tokens: {"input":20,"output":8,"cacheRead":4}');
	});

	it("refuses to overwrite malformed annotations", async () => {
		await session("bad-label");
		await buildCards({ root, out });
		const original = (await card("bad-label")).replace("verdict:", "verdict = fail");
		await writeFile(join(out, "bad-label.md"), original);
		await expect(buildCards({ root, out })).rejects.toThrow("Invalid label block");
		expect(await card("bad-label")).toBe(original);
	});

	it("exports exactly the filled labels and category counts, with private modes", async () => {
		for (const id of ["one", "two", "three"]) await session(id);
		await buildCards({ root, out });
		await label("one", "pass", "shared", "note one");
		await label("two", "fail", "shared, timeout, shared", "note two\ncontinued");
		const result = run("labels", "--out", out);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ labeled: 2, pass: 1, fail: 1, failSet: 0, conflicts: 0, categories: { shared: 2, timeout: 1 } });
		expect(result.stdout).not.toContain("note");
		const path = join(dirname(out), "labels.jsonl");
		const labels = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(labels).toHaveLength(2);
		expect(labels[1]).toMatchObject({ sessionId: "two", verdict: "fail", categories: ["shared", "timeout"], note: "note two\ncontinued", cardPath: join(out, "two.md") });
		expect(Number.isFinite(Date.parse(labels[1].labeledAt))).toBe(true);
		expect((await stat(out)).mode & 0o777).toBe(0o700);
		expect((await stat(join(out, "one.md"))).mode & 0o777).toBe(0o600);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		await label("two", "", "");
		expect(await collectLabels({ out })).toMatchObject({ labeled: 1 });
		expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
	});

	it.each(["directory", "file"])("rejects Git ancestry with a .git %s, including canonical aliases", async (kind) => {
		const repo = join(directory, "repo");
		await mkdir(repo);
		if (kind === "directory") await mkdir(join(repo, ".git"));
		else await writeFile(join(repo, ".git"), "gitdir: synthetic");
		const alias = join(directory, "alias");
		await symlink(repo, alias);
		for (const base of [repo, alias]) {
			const destination = join(base, "new", "cards");
			await expect(buildCards({ root, out: destination })).rejects.toThrow("Git worktrees");
			expect(run("build", "--root", root, "--out", destination).status).not.toBe(0);
			await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("rejects symlink roots, output directories, cards and labels without changing targets", async () => {
		await session("links");
		const alias = join(directory, "root-link");
		await symlink(root, alias);
		await expect(buildCards({ root: alias, out })).rejects.toThrow("Invalid session root");
		await mkdir(out, { recursive: true });
		const outLink = join(directory, "out-link");
		await symlink(out, outLink);
		await expect(buildCards({ root, out: outLink })).rejects.toThrow("Invalid output directory");
		const target = join(directory, "untouched");
		await writeFile(target, "KEEP");
		await symlink(target, join(out, "links.md"));
		await expect(buildCards({ root, out })).rejects.toThrow();
		await rm(join(out, "links.md"));
		await symlink(target, join(dirname(out), "labels.jsonl"));
		await expect(collectLabels({ out })).rejects.toThrow("Invalid labels input");
		expect(await readFile(target, "utf8")).toBe("KEEP");
	});

	it("rejects output inside the session root before changing input permissions", async () => {
		await chmod(root, 0o755);
		await expect(buildCards({ root, out: root })).rejects.toThrow("inside session root");
		expect((await stat(root)).mode & 0o777).toBe(0o755);
	});

	it("counts every skip reason and separates session and trace parse errors", async () => {
		const huge = await session("huge");
		await truncate(huge, 256 * 1024 * 1024 + 1);
		await session("empty", [header("empty")]);
		await session("invalid", [{ type: "not-a-session" }]);
		const duplicate = await session("duplicate", basic("good"));
		await utimes(duplicate, 1, 1);
		const good = await session("good", [header("good"), message("u", null, "user", "kept")]);
		await appendFile(good, "{invalid\n" + "x".repeat(64 * 1024 * 1024 + 1) + "\n" + JSON.stringify(assistant("a", "u", [text("AFTER_CORRUPTION")])) + "\n");
		await trace("good", [], "{invalid");
		expect(await buildCards({ root, out })).toEqual({
			generated: 1, skipped: 4, skippedOversized: 1, skippedInvalidHeader: 1, skippedEmpty: 1, skippedDuplicate: 1,
			traceMissing: 0, tracePartial: 1, parseErrors: 3, sessionParseErrors: 2, traceParseErrors: 1, unknownEntries: 0,
			badJson: 1, lineTooLong: 1, entryMissingId: 0, danglingParent: 0, cycle: 0, messageMissing: 0, findings: basicFindingCounts,
			invalidHeaderKinds: { other: 1 }, invalidHeaderKeySets: { type: 1 }, sessionVersions: { "1": 0, "2": 0, "3": 1, missing: 0 },
		});
		expect(await card("good")).toContain("AFTER_CORRUPTION");
	});

	it("bounds trace input too and reports it as partial", async () => {
		await session("huge-trace");
		const path = await trace("huge-trace", []);
		await truncate(path, 256 * 1024 * 1024 + 1);
		expect(await buildCards({ root, out })).toMatchObject({ generated: 1, tracePartial: 1 });
	});

	it("streams sessions and traces larger than 32 MiB, retaining early and late records", async () => {
		const path = await session("large", [header("large"), message("u", null, "user", "EARLY_REQUEST")]);
		const tracePath = await trace("large", [span("span_start", "s", { "pi.tool.call_id_digest": digest("large-call") })]);
		const padding = "x".repeat(1024 * 1024 - 256);
		for (let index = 0; index < 33; index++) {
			await appendFile(path, JSON.stringify({ type: "custom", id: `pad-${index}`, parentId: index ? `pad-${index - 1}` : "u", timestamp, data: padding }) + "\n");
			await appendFile(tracePath, JSON.stringify({ schema: "rotom-local-trace/v1", kind: "span_end", name: "pi.turn", traceId: "trace", spanId: `pad-${index}`, attributes: { padding } }) + "\n");
		}
		// No final newline: both stream readers must still parse their last record.
		await appendFile(path, JSON.stringify(assistant("a", "pad-32", [text("LATE_REPLY"), { type: "toolCall", id: "large-call", name: "bash", arguments: {} }])));
		await appendFile(tracePath, JSON.stringify(span("span_end", "s", { "pi.tool.outcome": "tool_error", "pi.tool.fault_side": "environment" })));
		for (const file of [path, tracePath]) expect((await stat(file)).size).toBeGreaterThan(32 * 1024 * 1024);
		expect(await buildCards({ root, out })).toMatchObject({ generated: 1, skipped: 0, parseErrors: 0, tracePartial: 0, unknownEntries: 0 });
		const rendered = await card("large");
		expect(rendered).toContain("EARLY_REQUEST");
		expect(rendered).toContain("LATE_REPLY");
		expect(rendered).toContain("outcome=tool_error fault=environment");
		expect(rendered).toContain("trace: ok");
	});

	it("silently skips known metadata and renders context-bearing entries", async () => {
		const entries: unknown[] = [header("context"), message("u", null, "user", "request")];
		let parentId = "u";
		for (const type of ["custom", "context_edit", "label", "session_info", "thinking_level_change", "usage"]) {
			entries.push({ type, id: type, parentId, timestamp, data: "SILENT_METADATA" });
			parentId = type;
		}
		entries.push(
			{ type: "custom_message", id: "custom-string", parentId, timestamp, customType: "goal", content: "C".repeat(301) },
			{ type: "custom_message", id: "custom-array", parentId: "custom-string", timestamp, customType: "context-layers", content: [text("INJECTED_TEXT"), { type: "image", data: "HIDDEN_IMAGE_DATA" }] },
			{ type: "branch_summary", id: "summary", parentId: "custom-array", timestamp, summary: "B".repeat(301) },
			{ type: "future_entry", id: "future", parentId: "summary", timestamp },
			assistant("a", "future", [text("done")]),
		);
		await session("context", entries);
		expect(await buildCards({ root, out })).toMatchObject({ generated: 1, unknownEntries: 1, sessionParseErrors: 0 });
		const rendered = await card("context");
		expect(rendered).toContain(`custom_message[goal]：${"C".repeat(300)}…[截断 1 字符]`);
		expect(rendered).toContain("custom_message[context-layers]：INJECTED_TEXT (image)");
		expect(rendered).toContain(`branch_summary：${"B".repeat(300)}…[截断 1 字符]`);
		expect(rendered).not.toContain("SILENT_METADATA");
		expect(rendered).not.toContain("HIDDEN_IMAGE_DATA");
	});

	it("renders bashExecution and custom roles, skips system and counts unknown roles without parse errors", async () => {
		await session("roles", [
			...basic("roles"),
			message("bash-ok", "a", "bashExecution", undefined, { command: "echo fixture", output: "BASH_OUTPUT", exitCode: 0, cancelled: false }),
			message("custom-string", "bash-ok", "custom", "C".repeat(301), { customType: "hook" }),
			message("bash-cancelled", "custom-string", "bashExecution", undefined, { command: "D".repeat(201), output: "O".repeat(301), cancelled: true }),
			message("custom-array", "bash-cancelled", "custom", [text("CUSTOM_TEXT"), { type: "image", data: "HIDDEN_IMAGE" }], { customType: "extension" }),
			message("system", "custom-array", "system", "HIDDEN_SYSTEM"),
			message("future", "system", "future_role", "HIDDEN_UNKNOWN"),
			assistant("last", "future", [text("done")]),
		]);
		expect(await buildCards({ root, out })).toMatchObject({ generated: 1, parseErrors: 0, sessionParseErrors: 0, unknownEntries: 1 });
		const rendered = await card("roles");
		expect(rendered).toContain("$ echo fixture → exit=0 · 输出：BASH_OUTPUT");
		expect(rendered).toContain(`$ ${"D".repeat(200)}…[截断 1 字符] → exit=unknown cancelled · 输出：${"O".repeat(300)}…[截断 1 字符]`);
		expect(rendered).toContain(`custom_message[hook]：${"C".repeat(300)}…[截断 1 字符]`);
		expect(rendered).toContain("custom_message[extension]：CUSTOM_TEXT (image)");
		for (const hidden of ["HIDDEN_IMAGE", "HIDDEN_SYSTEM", "HIDDEN_UNKNOWN"]) expect(rendered).not.toContain(hidden);
	});

	it.each([1, undefined])("migrates version=%s entries into an in-memory linear branch", async (version) => {
		const path = await session("legacy", [
			{ ...header("legacy"), version },
			{ type: "message", timestamp, message: { role: "user", content: "LEGACY_REQUEST" } },
			{ type: "compaction", timestamp, tokensBefore: 100, firstKeptEntryIndex: 1 },
			{ type: "message", timestamp, message: { role: "assistant", content: [text("LEGACY_REPLY")], stopReason: "stop" } },
		]);
		const before = await readFile(path);
		const result = await buildCards({ root, out });
		expect(result).toMatchObject({ generated: 1, skipped: 0, sessionParseErrors: 0, unknownEntries: 0 });
		expect(result.sessionVersions).toEqual({ "1": version === 1 ? 1 : 0, "2": 0, "3": 0, missing: version === undefined ? 1 : 0 });
		const rendered = await card("legacy");
		for (const value of ["LEGACY_REQUEST", "LEGACY_REPLY", "tokensBefore=100", "turns: 1"]) expect(rendered).toContain(value);
		expect(await readFile(path)).toEqual(before);
	});

	it("counts session versions only after a card is generated", async () => {
		for (const version of [1, 2, 3, undefined]) {
			const id = `version-${version ?? "missing"}`;
			await session(id, [{ ...header(id), version }, ...basic(id).slice(1)]);
		}
		await session("empty-version", [{ ...header("empty-version"), version: 2 }]);
		const duplicate = await session("duplicate-version", basic("version-3"));
		await utimes(duplicate, 1, 1);
		expect(await buildCards({ root, out })).toMatchObject({
			generated: 4, skipped: 2, skippedEmpty: 1, skippedDuplicate: 1, parseErrors: 0,
			sessionVersions: { "1": 1, "2": 1, "3": 1, missing: 1 },
		});
	});

	it("reports bounded invalid-header kinds without exposing arbitrary type values", async () => {
		const headers = [
			{ type: "span_start" }, { type: "custom" }, { type: "PRIVATE TYPE VALUE" },
			{ type: "x".repeat(33) }, { type: 7 }, null, { type: "session", id: "bad/id" },
		];
		for (const [index, value] of headers.entries()) await session(`invalid-${index}`, [value]);
		const result = run("build", "--root", root, "--out", out);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			generated: 0, skippedInvalidHeader: 7,
			invalidHeaderKinds: { span_start: 1, custom: 1, other: 3, unparseable: 1, "session-bad-id": 1 },
			invalidHeaderKeySets: { type: 5, other: 1, "id,type": 1 },
			sessionVersions: { "1": 0, "2": 0, "3": 0, missing: 0 },
		});
		for (const hidden of ["PRIVATE TYPE VALUE", "x".repeat(33), "bad/id"]) expect(result.stdout).not.toContain(hidden);
	});

	it.each(["{broken", "", " ".repeat(1024 * 1024 + 1), "null", "false"])("finds the first Pi header after skipped prefix lines (case %#)", async (firstLine) => {
		const path = await session("prefixed");
		await writeFile(path, firstLine + "\n" + await readFile(path, "utf8"));
		expect(await buildCards({ root, out })).toMatchObject({ generated: 1, skippedInvalidHeader: 0, invalidHeaderKinds: {}, invalidHeaderKeySets: {} });
		expect(await card("prefixed")).toContain("SYNTHETIC_REQUEST");
	});

	it("reports a first nonempty line above 64 MiB without accepting a later header", async () => {
		const path = await session("long-prefix");
		await writeFile(path, " \n" + "x".repeat(64 * 1024 * 1024 + 1) + "\n" + await readFile(path, "utf8"));
		expect(await buildCards({ root, out })).toMatchObject({ generated: 0, skippedInvalidHeader: 1, lineTooLong: 1, invalidHeaderKinds: { "line-too-long": 1 } });
	});

	it("keeps the full branch across a screenshot toolResult larger than 1 MiB", async () => {
		const base64 = Buffer.alloc(1024 * 1024, 0x61).toString("base64");
		const screenshot = message("image", "a", "toolResult", [{ type: "image", data: base64, mimeType: "image/png" }, text("VISIBLE_RESULT")], { toolCallId: "screenshot", isError: false });
		expect(Buffer.byteLength(JSON.stringify(screenshot))).toBeGreaterThan(1024 * 1024);
		await session("screenshot", [header("screenshot"), message("u", null, "user", "EARLY_REQUEST"), assistant("a", "u", [{ type: "toolCall", id: "screenshot", name: "browser_inspect", arguments: {} }]), screenshot, assistant("last", "image", [text("FINAL_REPLY")])]);
		expect(await buildCards({ root, out })).toMatchObject({ generated: 1, sessionParseErrors: 0, lineTooLong: 0, danglingParent: 0 });
		const rendered = await card("screenshot");
		for (const value of ["EARLY_REQUEST", "browser_inspect", "(image)", "VISIBLE_RESULT", "FINAL_REPLY"]) expect(rendered).toContain(value);
		expect(rendered).not.toContain(base64.slice(0, 128));
	});

	it("diagnoses sorted header keys without exposing values or unsafe field names", async () => {
		const candidates = [
			{ z: "PRIVATE_VALUE", Alpha: 1 }, { Alpha: 2, z: "PRIVATE_VALUE" },
			{ type: "trace", "PRIVATE-FIELD": "PRIVATE_VALUE" }, { ["x".repeat(33)]: "PRIVATE_VALUE" },
		];
		for (const [index, value] of candidates.entries()) await session(`keyset-${index}`, [value, ...basic(`later-${index}`)]);
		const result = run("build", "--root", root, "--out", out);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ generated: 0, skippedInvalidHeader: 4, invalidHeaderKinds: { "missing-type": 3, trace: 1 }, invalidHeaderKeySets: { "Alpha,z": 2, other: 2 } });
		for (const hidden of ["PRIVATE_VALUE", "PRIVATE-FIELD", "x".repeat(33)]) expect(result.stdout).not.toContain(hidden);
	});

	it("accepts filename-safe string IDs while rejecting traversal and control characters", async () => {
		await session("safe-file", [{ ...header("safe id.1") }, ...basic("safe id.1").slice(1)]);
		for (const [index, id] of ["../escape", "a/b", "a\\b", "a\u0000b", "a\nb"].entries()) await session(`unsafe-${index}`, [header(id), ...basic(id).slice(1)]);
		expect(await buildCards({ root, out })).toMatchObject({ generated: 1, skippedInvalidHeader: 5, invalidHeaderKinds: { "session-bad-id": 5 } });
		await label("safe id.1", "pass", "");
		await collectLabels({ out });
		expect(JSON.parse((await readFile(join(dirname(out), "labels.jsonl"), "utf8")).trim()).sessionId).toBe("safe id.1");
	});

	it.each(["toolUse", "error", "aborted", undefined])("explains a textless final assistant with stopReason=%s", async (stopReason) => {
		await session("no-final", [...basic("no-final"), assistant("last", "a", [{ type: "toolCall", id: "call", name: "bash", arguments: {} }], { stopReason })]);
		await buildCards({ root, out });
		const final = (await card("no-final")).split("## 最终回复\n")[1];
		expect(final).toContain(`(最后一条 assistant 无文本，stopReason=${stopReason ?? "unknown"})`);
		expect(final).not.toContain("SYNTHETIC_REPLY");
	});

	it("selects by mtime, since and limit; ignores observability and symlink descendants", async () => {
		const recent = await session("recent", basic("recent"), join(root, "nested"));
		const old = await session("old");
		const middle = await session("middle");
		const now = Date.now() / 1000;
		await utimes(old, now - 864000, now - 864000);
		await utimes(middle, now - 7200, now - 7200);
		await utimes(recent, now, now);
		await session("excluded", basic("excluded"), join(root, "observability"));
		await symlink(old, join(root, "linked.jsonl"));
		await symlink(root, join(root, "loop"));
		expect(await buildCards({ root, out, since: "1d", limit: 1 })).toMatchObject({ generated: 1 });
		expect(await card("recent")).toContain('session: "recent"');
		expect(await buildCards({ root, out, since: "1h" })).toMatchObject({ generated: 1 });
		expect(await buildCards({ root, out, since: "1d" })).toMatchObject({ generated: 2 });
		await expect(buildCards({ root, out, limit: 501 })).rejects.toThrow("500");
		await expect(buildCards({ root, out, since: "yesterday" })).rejects.toThrow("Nd or Nh");
		expect(run("labels", "--out", out, "--limit", "1").status).not.toBe(0);
	});

	it("truncates all content fields, omits thinking and prints only build counts", async () => {
		await session("truncate", [header("truncate"), message("u", null, "user", "U".repeat(2001)),
			message("u2", "u", "user", [text("V".repeat(1001))]),
			assistant("a", "u2", [text("A".repeat(4001)), { type: "thinking", thinking: "SECRET_THINKING" }, { type: "toolCall", id: "call", name: "synthetic", arguments: { data: "P".repeat(250) } }]),
			message("r", "a", "toolResult", [text("R".repeat(301))], { toolCallId: "call" }),
		]);
		const result = run("build", "--root", root, "--out", out);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			generated: 1, skipped: 0, skippedOversized: 0, skippedInvalidHeader: 0, skippedEmpty: 0, skippedDuplicate: 0,
			traceMissing: 1, tracePartial: 0, parseErrors: 0, sessionParseErrors: 0, traceParseErrors: 0, unknownEntries: 0,
			badJson: 0, lineTooLong: 0, entryMissingId: 0, danglingParent: 0, cycle: 0, messageMissing: 0, findings: basicFindingCounts,
			invalidHeaderKinds: {}, invalidHeaderKeySets: {}, sessionVersions: { "1": 0, "2": 0, "3": 1, missing: 0 },
		});
		const rendered = await card("truncate");
		for (const value of ["U".repeat(2000) + "…[截断 1 字符]", "V".repeat(1000) + "…[截断 1 字符]", "A".repeat(400) + "…[截断 3601 字符]", "A".repeat(4000) + "…[截断 1 字符]", "R".repeat(300) + "…[截断 1 字符]", "…[截断 61 字符]", "(thinking 15 字符)"]) expect(rendered).toContain(value);
		expect(rendered).not.toContain("SECRET_THINKING");
		expect(result.stdout).not.toContain(directory);
	});

	it("truncates Unicode characters without splitting surrogate pairs", async () => {
		await session("unicode", [header("unicode"), message("u", null, "user", "😀".repeat(2001)), assistant("a", "u", [{ type: "thinking", thinking: "😀" }, text("done")])]);
		await buildCards({ root, out });
		expect(await card("unicode")).toContain("😀".repeat(2000) + "…[截断 1 字符]");
		expect(await card("unicode")).toContain("(thinking 1 字符)");
		expect(await card("unicode")).not.toContain("�");
	});

	it("puts findings in the card, summary and labels while preserving annotations on rebuild", async () => {
		const path = await session("findings", [header("findings"), message("u", null, "user", "request"),
			assistant("a", "u", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "PRIVATE_ARGUMENT" } }]),
			message("r", "a", "toolResult", "PRIVATE_RESULT", { toolCallId: "c1", isError: true }),
			assistant("end", "r", [text("done")]),
		]);
		await trace("findings", [span("span_start", "s", { "pi.tool.call_id_digest": digest("c1") }), span("span_end", "s", { "pi.tool.outcome": "tool_error", "pi.tool.fault_side": "harness" })]);
		const result = await buildCards({ root, out });
		expect(result.findings["ended-after-tool-error"]).toEqual({ hit: 1, clear: 0, unknown: 0 });
		expect(result.findings["harness-fault"].hit).toBe(1);
		const rendered = await card("findings");
		const statuses = JSON.parse(/^findings: (.+)$/m.exec(rendered)![1]);
		expect(Object.keys(statuses)).toHaveLength(6);
		expect(statuses["ended-after-tool-error"]).toBe("hit");
		const section = rendered.split("## 规则命中\n")[1].split("## 最终回复")[0];
		expect(section).toContain("ended-after-tool-error（count=1）");
		expect(section).toContain("harness-fault（count=1）");
		expect(section).not.toMatch(/PRIVATE_|command/);
		const block = await label("findings", "pass", "reviewed");
		await collectLabels({ out });
		const exported = JSON.parse((await readFile(join(dirname(out), "labels.jsonl"), "utf8")).trim());
		expect(exported.findings).toEqual(statuses);
		expect(exported.verdict).toBe("pass");
		await appendFile(path, JSON.stringify(assistant("new", "end", [], { stopReason: "error" })) + "\n");
		await buildCards({ root, out });
		expect((await card("findings")).endsWith(block)).toBe(true);
		await collectLabels({ out });
		expect(JSON.parse((await readFile(join(dirname(out), "labels.jsonl"), "utf8")).trim()).findings["ended-on-provider-error"]).toBe("hit");
	});

	it("shows no hits explicitly and exports old cards as unknown without trusting body text", async () => {
		await session("old-card");
		await buildCards({ root, out });
		expect(await card("old-card")).toContain("## 规则命中\n(无)\n");
		await label("old-card", "pass", "");
		const old = (await card("old-card")).replace(/^findings: .+\n/m, "").replace("## 用户请求", 'findings: {"harness-fault":"hit"}\n\n## 用户请求');
		await writeFile(join(out, "old-card.md"), old);
		await collectLabels({ out });
		const path = join(dirname(out), "labels.jsonl");
		const before = await readFile(path, "utf8");
		expect(Object.values(JSON.parse(before).findings)).toEqual(Array(6).fill("unknown"));
		await writeFile(join(out, "old-card.md"), old.replace("\n---\n", '\nfindings: {"harness-fault":"invalid"}\n---\n'));
		await expect(collectLabels({ out })).rejects.toThrow("Invalid findings metadata");
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("splits structural session errors and does not count valid non-session headers as bad JSON", async () => {
		await session("bad-header", [{ type: "metadata" }]);
		await session("missing-id", [header("missing-id"), { type: "message", parentId: null, timestamp }, ...basic("missing-id").slice(1)]);
		await session("dangling", [header("dangling"), assistant("a", "absent", [])]);
		await session("cycle", [header("cycle"), assistant("a", "b", []), assistant("b", "a", [])]);
		await session("missing-message", [header("missing-message"), { type: "message", id: "missing", parentId: null, timestamp }]);
		const result = await buildCards({ root, out });
		expect(result).toMatchObject({ generated: 4, skippedInvalidHeader: 1, badJson: 0, lineTooLong: 0, entryMissingId: 1, danglingParent: 1, cycle: 1, messageMissing: 1, sessionParseErrors: 4 });
		expect(result.sessionParseErrors).toBe(result.badJson + result.lineTooLong + result.entryMissingId + result.danglingParent + result.cycle + result.messageMissing);
	});

	it("does not let source text impersonate a label block", async () => {
		await session("spoof", [header("spoof"), message("u", null, "user", "\n<!-- label:begin -->\nverdict: fail\ncategories: forged\nnote:\n<!-- label:end -->"), assistant("a", "u", [text("done")])]);
		await buildCards({ root, out });
		expect(await collectLabels({ out })).toMatchObject({ labeled: 0 });
		expect((await card("spoof")).match(/<!-- label:begin -->/g)).toHaveLength(1);
	});
	it("aggregates weekly and per-model metrics on stdout and keeps session ids in private files", async () => {
		const calls = ["c1", "c2"];
		await session("alpha", [header("alpha"), message("u", null, "user", "SYNTHETIC_REQUEST"),
			assistant("a", "u", [text("SYNTHETIC_REPLY"), ...calls.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} }))])]);
		await trace("alpha", calls.flatMap((id, index) => [
			span("span_start", id, { "pi.tool.call_id_digest": digest(id) }),
			span("span_end", id, { "pi.tool.call_id_digest": digest(id), "pi.tool.outcome": index === 0 ? "error" : "ok", "pi.tool.result_text_bytes": 16 }),
		]));
		await session("beta", [header("beta"), message("u", null, "user", "SYNTHETIC_REQUEST"), assistant("a", "u", [text("SYNTHETIC_REPLY")])]);
		const result = run("stats", "--root", root, "--out", out);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).not.toContain("alpha");
		expect(result.stdout).not.toContain("beta");
		const printed = JSON.parse(result.stdout);
		expect(printed.sessions).toBe(2);
		expect(printed.weeks).toHaveLength(1);
		expect(printed.weeks[0]).toMatchObject({ week: "2026-W01", sessions: 2 });
		expect(printed.weeks[0].toolErrorRate).toEqual({ n: 1, errors: 1, endedSpans: 2, rate: 0.5 });
		expect(printed.models).toEqual([expect.objectContaining({ model: "synthetic/fixture", sessions: 2 })]);
		const markdown = join(dirname(out), "stats.md");
		expect(await readFile(markdown, "utf8")).toContain("alpha");
		expect(((await stat(markdown)).mode & 0o777)).toBe(0o600);
		const rows = (await readFile(join(dirname(out), "stats.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(((await stat(join(dirname(out), "stats.jsonl"))).mode & 0o777)).toBe(0o600);
		expect(rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
			expect.objectContaining({ sessionId: "alpha", toolErrors: 1, endedToolSpans: 2, week: "2026-W01" }),
			expect.objectContaining({ sessionId: "beta", toolErrors: null, toolErrorRate: null, costUsd: null, costPartial: true }),
		]);
	});

	it("breaks tool and provider errors down on stdout and keeps session ids in the private file", async () => {
		const record = (kind: string, spanId: string, name: string, attributes: Record<string, string | number>, status?: string, parentSpanId?: string) => ({
			schema: "rotom-local-trace/v1", kind, spanId, traceId: "trace", name, ...(status ? { status } : {}), ...(parentSpanId ? { parentSpanId } : {}), attributes,
		});
		const tool = (callId: string, outcome: string) => [
			record("span_start", callId, "pi.tool.execute", { "pi.tool.name": "bash" }),
			record("span_end", callId, "pi.tool.execute", { "pi.tool.name": "bash", "pi.tool.outcome": outcome, "pi.tool.fault_side": "unknown", "pi.tool.error_code": "nonzero_exit" }, "error"),
		];
		const request = (spanId: string, status: string, attributes: Record<string, string | number> = {}) => [
			record("span_start", spanId, "pi.ai.request", { "pi.ai.provider": "synthetic", "pi.ai.model": "fixture", ...attributes }, undefined, "turn"),
			record("span_end", spanId, "pi.ai.request", { "pi.ai.provider": "synthetic", "pi.ai.model": "fixture", ...attributes }, status, "turn"),
		];
		// One failed edit whose reason exists only in the result text, joined to its
		// trace span by the call-id digest; the text must never reach stdout.
		const edit = (callId: string, extra: Record<string, string | number> = {}) => {
			const attributes = { "pi.tool.name": "edit", "pi.tool.call_id_digest": digest(callId), ...extra };
			return [
				record("span_start", callId, "pi.tool.execute", attributes, undefined, "turn"),
				record("span_end", callId, "pi.tool.execute", { ...attributes, "pi.tool.outcome": "tool_error", "pi.tool.fault_side": "model" }, "error", "turn"),
			];
		};
		await session("alpha", [header("alpha"), message("u", null, "user", "SYNTHETIC_REQUEST"),
			assistant("a", "u", [text("SYNTHETIC_REPLY"), { type: "toolCall", id: "e1", name: "edit", arguments: { path: "sample.ts" } }], { stopReason: "error" }),
			message("r1", "a", "toolResult", [text("Could not find the exact text in sample.ts. The old text must match exactly including all whitespace and newlines.")], { toolCallId: "e1", isError: true })]);
		await trace("alpha", [
			record("span_start", "run", "pi.agent.run", {}),
			record("span_start", "turn", "pi.agent.turn", {}, undefined, "run"),
			...tool("c1", "tool_error"), ...tool("c2", "tool_error"),
			...edit("e1"),
			...request("r1", "error", { "pi.ai.error.category": "timeout" }),
			...request("r2", "error", { "pi.ai.error.category": "timeout" }),
		]);
		await session("beta", [header("beta"), message("u", null, "user", "SYNTHETIC_REQUEST"), assistant("a", "u", [text("SYNTHETIC_REPLY")])]);
		const result = run("breakdown", "--root", root, "--out", out);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).not.toContain("alpha");
		expect(result.stdout).not.toContain("beta");
		expect(result.stdout).not.toContain("SYNTHETIC");
		expect(result.stdout).not.toContain("sessionId");
		const printed = JSON.parse(result.stdout);
		expect(printed.sessions).toBe(2);
		expect(printed.toolTotals).toEqual({ endedSpans: 3, errors: 3, aborted: 0 });
		expect(printed.tools[0]).toMatchObject({ tool: "bash", errors: 2, rate: 1 });
		expect(printed.tools[0].share).toBeCloseTo(2 / 3);
		expect(printed.concentration).toMatchObject({ sessionsWithErrors: 1, topErrors: 3, share: 1 });
		expect(printed.providerTotals).toEqual({ requests: 2, errors: 2, abortedRequests: 0 });
		expect(printed.providers[0]).toMatchObject({ provider: "synthetic", model: "fixture", category: "timeout", count: 2 });
		expect(printed.providerEnd).toEqual({ sessions: 1, runRetried: 1, sessionRetried: 1, single: 0 });
		expect(printed.editFailures).toEqual({
			total: 1, thenRunFailed: 0, uncoded: 0,
			rows: [{ code: "old_text_not_found", trace: 0, derived: 1 }],
		});
		expect(result.stdout).not.toContain("Could not find");
		const markdown = join(dirname(out), "breakdown.md");
		const page = await readFile(markdown, "utf8");
		expect(page).toContain("alpha");
		expect(page).toContain("## 工具出错集中度");
		expect(page).toContain("## provider 请求出错");
		expect(page).toContain("## edit 失败原因");
		expect(page).toContain("old_text_not_found");
		expect(((await stat(markdown)).mode & 0o777)).toBe(0o600);
	});

	it("rejects breakdown output inside a Git worktree and the build-only arguments", async () => {
		await session("breakdown-cli");
		const repo = join(directory, "repo");
		await mkdir(join(repo, ".git"), { recursive: true });
		await expect(errorBreakdown({ root, out: join(repo, "cards") })).rejects.toThrow("Git worktrees");
		expect(run("breakdown", "--root", root, "--out", out, "--limit", "5").status).not.toBe(0);
		expect(run("breakdown", "--root", root, "--out", out, "--focus").status).not.toBe(0);
		expect(run("breakdown", "--root", root, "--out", out, "--since", "28d").status).toBe(0);
	});

	it("rejects stats output inside a Git worktree and the build-only limit argument", async () => {
		await session("stat-cli");
		const repo = join(directory, "repo");
		await mkdir(join(repo, ".git"), { recursive: true });
		await expect(sessionStats({ root, out: join(repo, "cards") })).rejects.toThrow("Git worktrees");
		expect(run("stats", "--root", root, "--out", out, "--limit", "5").status).not.toBe(0);
		expect(run("stats", "--root", root, "--out", out, "--focus").status).not.toBe(0);
	});

	it("builds only suspicious cards for --focus and treats --limit as a card cap", async () => {
		const failing = ["c1", "c2", "c3", "c4", "c5"];
		await session("clean");
		await session("failing", [header("failing"), message("u", null, "user", "SYNTHETIC_REQUEST"),
			assistant("a", "u", [text("SYNTHETIC_REPLY"), ...failing.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} }))])]);
		await trace("failing", failing.flatMap((id) => [
			span("span_start", id, { "pi.tool.call_id_digest": digest(id) }),
			span("span_end", id, { "pi.tool.call_id_digest": digest(id), "pi.tool.outcome": "error", "pi.tool.result_text_bytes": 1 }),
		]));
		await session("huge", [header("huge"), message("u", null, "user", "SYNTHETIC_REQUEST"),
			assistant("a", "u", [text("SYNTHETIC_REPLY"), { type: "toolCall", id: "big", name: "bash", arguments: {} }])]);
		await trace("huge", [
			span("span_start", "big", { "pi.tool.call_id_digest": digest("big") }),
			span("span_end", "big", { "pi.tool.call_id_digest": digest("big"), "pi.tool.outcome": "ok", "pi.tool.result_text_bytes": 60_000 }),
		]);
		await session("textless", [header("textless"), message("u", null, "user", "SYNTHETIC_REQUEST"), assistant("a", "u", [])]);
		await session("provider-error", [header("provider-error"), message("u", null, "user", "SYNTHETIC_REQUEST"),
			assistant("a", "u", [text("SYNTHETIC_REPLY")], { stopReason: "error" })]);
		const capped = await buildCards({ root, out, focus: true, limit: 1 });
		expect(capped).toMatchObject({ generated: 1, focusMatched: 1, skipped: 0 });
		expect(capped.focusScanned).toBeLessThanOrEqual(5);
		expect(Object.values(capped.focusConditions ?? {}).reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(1);
		expect((await readdir(out)).length).toBe(1);
		const all = await buildCards({ root, out, focus: true, limit: 40 });
		expect(all).toMatchObject({ generated: 4, focusMatched: 4, focusScanned: 5 });
		expect(all.focusConditions).toEqual({ toolErrors: 1, ruleHit: 2, endedWithoutFinalText: 1, endedOnProviderError: 1 });
		await expect(card("clean")).rejects.toThrow();
		expect((await readdir(out)).sort()).toEqual(["failing.md", "huge.md", "provider-error.md", "textless.md"].sort());
	});

	it("keeps existing labels when rebuilding in focus mode", async () => {
		const failing = ["c1", "c2", "c3", "c4", "c5"];
		await session("labelled", [header("labelled"), message("u", null, "user", "SYNTHETIC_REQUEST"),
			assistant("a", "u", [text("SYNTHETIC_REPLY"), ...failing.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} }))])]);
		await trace("labelled", failing.flatMap((id) => [
			span("span_start", id, { "pi.tool.call_id_digest": digest(id) }),
			span("span_end", id, { "pi.tool.call_id_digest": digest(id), "pi.tool.outcome": "error", "pi.tool.result_text_bytes": "1" }),
		]));
		await expect(buildCards({ root, out, focus: true, limit: 5 })).resolves.toMatchObject({ generated: 1 });
		const kept = await label("labelled", "pass", "synthetic", "kept");
		await expect(buildCards({ root, out, focus: true, limit: 5 })).resolves.toMatchObject({ generated: 1 });
		expect(await card("labelled")).toContain(kept);
		expect(await collectLabels({ out })).toMatchObject({ labeled: 1, pass: 1 });
	});

});
