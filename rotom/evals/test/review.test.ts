import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCards, collectLabels, reviewCards } from "../scripts/session-cards.mjs";
import { extractSummary, renderSummary, runReview } from "../scripts/review.mjs";

const cli = fileURLToPath(new URL("../scripts/session-cards.mjs", import.meta.url));
const label = (verdict = "", note = "", categories = "") => `<!-- label:begin -->\nverdict: ${verdict}\ncategories:${categories ? ` ${categories}` : ""}\nnote: ${note}\n<!-- label:end -->\n`;
function fixture(name: string, started = "2026-10-24T21:03:00Z", verdict = "") {
	return `---\nstarted: ${JSON.stringify(started)}\nduration: "720000ms"\ntool_calls: 18\ntool_errors: {"error":1,"unknown_outcome":1}\nfindings: {"oversized-tool-result":"hit","schema-errors":"clear"}\n---\n\n## 用户请求\n> ${name}\n\n## 过程\n> SYNTHETIC_PROCESS\n\n## 最终回复\n> SYNTHETIC_FINAL\n\n${label(verdict)}`;
}
function capture(onWrite?: (chunk: string) => void) {
	let text = "";
	return { output: new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); onWrite?.(chunk.toString()); done(); } }), text: () => text };
}
let directory: string;
let out: string;
async function card(name: string, text = fixture(name)) {
	const path = join(out, `${name}.md`);
	await writeFile(path, text, { mode: 0o600 });
	return path;
}
async function review(answers: string, limit?: number) {
	const result = capture();
	const counts = await reviewCards({ out, limit, input: Readable.from([answers]), output: result.output });
	return { counts, text: result.text() };
}
beforeEach(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "rotom-review-test-")));
	out = join(directory, "private", "cards");
	await mkdir(out, { recursive: true, mode: 0o700 });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("review summaries", () => {
	it("extracts card metadata, sections and only hit findings", () => {
		const summary = extractSummary(fixture("SYNTHETIC_REQUEST"));
		expect(summary).toMatchObject({ minutes: 12, tools: 18, errors: 2, hits: ["oversized-tool-result"], request: "SYNTHETIC_REQUEST", final: "SYNTHETIC_FINAL" });
		expect(summary.started).toMatch(/^10-24 \d\d:\d\d$/);
		expect(summary.timestamp).toBe(Date.parse("2026-10-24T21:03:00Z"));
		const text = renderSummary(summary, 3, 40);
		expect(text).toContain("[3/40]");
		expect(text).toContain("规则提示：oversized-tool-result");
		expect(text).not.toContain("schema-errors");
		expect(text.trimEnd().split("\n").length + 1).toBeLessThanOrEqual(8);
	});

	it("flattens and truncates by Unicode characters, strips terminal controls and decodes quoting", () => {
		const source = fixture("x").replace("> x\n", `> &lt; &amp; \u001b[31m${"😀".repeat(200)}\n> SECOND_LINE\n`).replace("> SYNTHETIC_FINAL", `> ${"终".repeat(200)}\n> EXTRA`);
		const summary = extractSummary(source);
		expect(Array.from(summary.request)).toHaveLength(120);
		expect(Array.from(summary.final)).toHaveLength(160);
		expect(summary.request.startsWith("< & 😀")).toBe(true);
		expect(summary.request).not.toMatch(/[\n\r\u001b\ufffd]/);
		expect(renderSummary(summary, 1, 1).trimEnd().split("\n")).toHaveLength(4);
	});

	it("uses ? for missing fields and omits a no-hit rule line", () => {
		const summary = extractSummary("## unrelated\nmissing metadata");
		expect(summary).toEqual({ timestamp: -Infinity, started: "?", minutes: "?", tools: "?", errors: "?", hits: [], request: "?", final: "?" });
		expect(renderSummary(summary, 1, 1)).not.toContain("规则提示");
		const annotationOnly = `NO_METADATA\n${label("", "old note\n## 用户请求\nNOT_A_REQUEST\n## 最终回复\nNOT_A_REPLY")}`;
		expect(extractSummary(annotationOnly)).toMatchObject({ request: "?", final: "?" });
		expect(extractSummary(fixture("x").replace('"oversized-tool-result":"hit"', '"oversized-tool-result":"unknown"')).hits).toEqual([]);
	});
});

describe("review flow", () => {
	it("saves y and both forms of n, skips s, quits q, and reports all remaining cards", async () => {
		for (let index = 1; index <= 6; index++) await card(`case-${index}`, fixture(`REQUEST_${index}`, `2026-10-0${7 - index}T12:00:00Z`));
		const skipped = await readFile(join(out, "case-4.md"));
		const result = await review("y\nn\n回答没有完成任务\nn\n\ns\nq\n");
		expect(result.counts).toEqual({ pass: 1, fail: 2, skipped: 1, remaining: 3, damaged: 0 });
		expect(result.text).toContain("本次 pass 1 / fail 2 / 跳过 1，还剩 3 张未标注，损坏 0 张");
		expect(result.text).not.toContain("REQUEST_6");
		expect(await readFile(join(out, "case-4.md"))).toEqual(skipped);
		expect((await readFile(join(out, "case-1.md"), "utf8")).endsWith(label("pass"))).toBe(true);
		expect((await readFile(join(out, "case-2.md"), "utf8")).endsWith(label("fail", "回答没有完成任务"))).toBe(true);
		expect((await readFile(join(out, "case-3.md"), "utf8")).endsWith(label("fail"))).toBe(true);
	});

	it("re-prompts for invalid input and o without reprinting the summary or opening anything", async () => {
		const path = await card("private  name");
		const before = await readFile(path);
		const result = await review("bad\no\ns\n");
		expect(result.text).toContain(JSON.stringify(path));
		expect(result.text.match(/满意吗？/g)).toHaveLength(3);
		expect(result.text.match(/\[1\/1\]/g)).toHaveLength(1);
		expect(result.counts).toMatchObject({ skipped: 1, remaining: 1 });
		expect(await readFile(path)).toEqual(before);
	});

	it("never presents or changes previously labeled cards", async () => {
		const done = await card("done", fixture("ALREADY_REVIEWED", undefined, "fail"));
		const before = await readFile(done);
		await card("new");
		const result = await review("q\n");
		expect(result.text).not.toContain("ALREADY_REVIEWED");
		expect(result.counts).toMatchObject({ pass: 0, fail: 0, skipped: 0, remaining: 1 });
		expect(await readFile(done)).toEqual(before);
	});

	it("keeps all bytes outside the label block, clears categories and writes 0600", async () => {
		const path = join(out, "bytes.md");
		const prefix = Buffer.concat([Buffer.from(fixture("中文 😀").split("<!-- label:begin -->")[0].replaceAll("\n", "\r\n")), Buffer.from([0xff, 0xfe, 10])]);
		await writeFile(path, Buffer.concat([prefix, Buffer.from(label("", "old", "old-category").replaceAll("\n", "\r\n"))]));
		await chmod(path, 0o644);
		await chmod(out, 0o755);
		await review("y\n");
		const after = await readFile(path);
		expect(after.subarray(0, prefix.length)).toEqual(prefix);
		expect(after.subarray(prefix.length).toString()).toBe(label("pass"));
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(out)).mode & 0o777).toBe(0o700);
	});

	it("skips malformed labels without displaying or overwriting them", async () => {
		const path = await card("broken", fixture("BROKEN_PRIVATE_REQUEST").replace("categories:", "wrong:"));
		const before = await readFile(path);
		await card("valid", `NO_METADATA\n${label()}`);
		const result = await review("y\n");
		expect(result.counts).toEqual({ pass: 1, fail: 0, skipped: 0, remaining: 0, damaged: 1 });
		expect(result.text).toContain("你的请求：?");
		expect(result.text).not.toContain("BROKEN_PRIVATE_REQUEST");
		expect(result.text).toContain("损坏 1 张");
		expect(await readFile(path)).toEqual(before);
	});

	it("sorts by started descending, places missing dates last and applies limit", async () => {
		await card("a", fixture("OLDEST", "2026-01-01T00:00:00Z"));
		await card("b", fixture("NEWEST", "2026-10-01T00:00:00Z"));
		await card("c", fixture("MIDDLE", "2026-05-01T00:00:00Z"));
		await card("d", fixture("MISSING", ""));
		const result = await review("s\ns\n", 2);
		expect(result.text.indexOf("NEWEST")).toBeLessThan(result.text.indexOf("MIDDLE"));
		expect(result.text).not.toMatch(/OLDEST|MISSING/);
		expect(result.counts).toMatchObject({ skipped: 2, remaining: 4 });
	});

	it("defaults to at most 50 cards", async () => {
		for (let index = 0; index < 51; index++) await card(`case-${String(index).padStart(2, "0")}`);
		const result = await review("s\n".repeat(51));
		expect(result.counts).toMatchObject({ skipped: 50, remaining: 51 });
		expect(result.text.match(/满意吗？/g)).toHaveLength(50);
	});

	it("stops on EOF during the reason without partially labeling the current card", async () => {
		const path = await card("one");
		const before = await readFile(path);
		expect((await review("n\n")).counts).toMatchObject({ fail: 0, remaining: 1 });
		expect(await readFile(path)).toEqual(before);
	});

	it("saves before the next prompt and keeps that answer on terminal Ctrl+C", async () => {
		const first = await card("first", fixture("FIRST", "2026-10-24T12:00:00Z"));
		const second = await card("second", fixture("SECOND", "2026-10-23T12:00:00Z"));
		const input = Object.assign(new PassThrough(), { isTTY: true });
		let prompts = 0;
		const output = capture((chunk) => {
			if (!chunk.includes("满意吗？") || !chunk.endsWith("> ")) return;
			prompts++;
			if (prompts === 2) expect(readFileSync(first, "utf8")).toContain("verdict: pass");
			queueMicrotask(() => input.write(prompts === 1 ? "y\n" : "\x03"));
		});
		try {
			const counts = await reviewCards({ out, input, output: output.output });
			expect(counts).toMatchObject({ pass: 1, remaining: 1 });
			expect(await readFile(second, "utf8")).toContain(label());
		} finally { input.destroy(); }
	});

	it("does not retry or report success after a write fails", async () => {
		const content = Buffer.from(fixture("x"));
		let writes = 0;
		const output = capture();
		await expect(runReview([{ path: join(out, "one.md"), content, labelStart: content.indexOf("<!-- label:begin -->") }], {
			limit: 1, input: Readable.from(["y\n"]), output: output.output,
			writeCard: async () => { writes++; throw new Error("synthetic write failure"); },
		})).rejects.toThrow("synthetic write failure");
		expect(writes).toBe(1);
		expect(output.text()).not.toContain("本次 pass 1");
	});

	it("reviews actual build output without reading the source session again", async () => {
		const root = join(directory, "sessions");
		await mkdir(root);
		await writeFile(join(root, "fixture.jsonl"), [
			{ type: "session", version: 3, id: "fixture", timestamp: "2026-10-24T12:00:00Z" },
			{ type: "message", id: "u", parentId: null, timestamp: "2026-10-24T12:00:00Z", message: { role: "user", content: "SYNTHETIC_BUILD_REQUEST" } },
			{ type: "message", id: "a", parentId: "u", timestamp: "2026-10-24T12:01:00Z", message: { role: "assistant", content: "SYNTHETIC_BUILD_REPLY", stopReason: "stop" } },
		].map((entry) => JSON.stringify(entry)).join("\n"));
		await buildCards({ root, out });
		await rm(root, { recursive: true });
		const result = await review("y\n");
		expect(result.text).toContain("你的请求：SYNTHETIC_BUILD_REQUEST");
		expect(result.text).toContain("最终回复：SYNTHETIC_BUILD_REPLY");
		expect(result.counts.pass).toBe(1);
		expect(await collectLabels({ out })).toMatchObject({ labeled: 1, pass: 1 });
		expect(JSON.parse(await readFile(join(dirname(out), "labels.jsonl"), "utf8"))).toMatchObject({ verdict: "pass", categories: [], note: "" });
	});
});

describe("review boundaries", () => {
	it("rejects non-TTY CLI input before changing cards", async () => {
		const path = await card("one");
		const before = await readFile(path);
		const result = spawnSync(process.execPath, [cli, "review", "--out", out], { input: "y\n", encoding: "utf8" });
		expect(result.status).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(await readFile(path)).toEqual(before);
	});

	it.each(["directory", "file"])("rejects Git output with .git as %s and a symlink alias", async (kind) => {
		const repo = join(directory, "repo");
		await mkdir(repo);
		if (kind === "directory") await mkdir(join(repo, ".git"));
		else await writeFile(join(repo, ".git"), "gitdir: synthetic");
		const alias = join(directory, "alias");
		await symlink(repo, alias);
		for (const path of [repo, alias]) await expect(reviewCards({ out: join(path, "cards"), input: Readable.from([]), output: capture().output })).rejects.toThrow();
	});

	it.each([0, -1, 1.5, Infinity])("rejects invalid limit %s", async (limit) => {
		await expect(review("q\n", limit)).rejects.toThrow("Invalid review limit");
	});
});
