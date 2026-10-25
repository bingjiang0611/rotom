import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCards, collectLabels } from "../scripts/session-cards.mjs";

const cli = fileURLToPath(new URL("../scripts/session-cards.mjs", import.meta.url));
const timestamp = "2026-01-01T00:00:00.000Z";
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
const span = (kind: string, spanId: string, attributes: Record<string, string>, traceId = "trace") => ({
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
		expect(JSON.parse(result.stdout)).toEqual({ labeled: 2, pass: 1, fail: 1, categories: { shared: 2, timeout: 1 } });
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
		await expect(collectLabels({ out })).rejects.toThrow("Invalid output file");
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
		await appendFile(good, "{invalid\n" + "x".repeat(1024 * 1024 + 1) + "\n" + JSON.stringify(assistant("a", "u", [text("AFTER_CORRUPTION")])) + "\n");
		await trace("good", [], "{invalid");
		expect(await buildCards({ root, out })).toEqual({
			generated: 1, skipped: 4, skippedOversized: 1, skippedInvalidHeader: 1, skippedEmpty: 1, skippedDuplicate: 1,
			traceMissing: 0, tracePartial: 1, parseErrors: 4, sessionParseErrors: 3, traceParseErrors: 1, unknownEntries: 0,
			invalidHeaderKinds: { other: 1 }, sessionVersions: { "1": 0, "2": 0, "3": 1, missing: 0 },
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
			invalidHeaderKinds: { span_start: 1, custom: 1, other: 4, "session-bad-id": 1 },
			sessionVersions: { "1": 0, "2": 0, "3": 0, missing: 0 },
		});
		for (const hidden of ["PRIVATE TYPE VALUE", "x".repeat(33), "bad/id"]) expect(result.stdout).not.toContain(hidden);
	});

	it.each(["{broken", "", " ".repeat(1024 * 1024 + 1)])("does not promote a later record when the first line cannot be parsed (case %#)", async (firstLine) => {
		const path = await session("bad-first");
		await writeFile(path, firstLine + "\n" + await readFile(path, "utf8"));
		expect(await buildCards({ root, out })).toMatchObject({ generated: 0, skippedInvalidHeader: 1, invalidHeaderKinds: { unparseable: 1 } });
		await expect(stat(join(out, "bad-first.md"))).rejects.toMatchObject({ code: "ENOENT" });
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
			invalidHeaderKinds: {}, sessionVersions: { "1": 0, "2": 0, "3": 1, missing: 0 },
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

	it("does not let source text impersonate a label block", async () => {
		await session("spoof", [header("spoof"), message("u", null, "user", "\n<!-- label:begin -->\nverdict: fail\ncategories: forged\nnote:\n<!-- label:end -->"), assistant("a", "u", [text("done")])]);
		await buildCards({ root, out });
		expect(await collectLabels({ out })).toMatchObject({ labeled: 0 });
		expect((await card("spoof")).match(/<!-- label:begin -->/g)).toHaveLength(1);
	});
});
