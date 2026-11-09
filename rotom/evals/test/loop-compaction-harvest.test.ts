import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCompactions, compactionMetrics } from "../src/loop/compaction-harvest.ts";
import { analyzeSession } from "../src/loop/harvest.ts";
import { harvest } from "../src/loop/harvest-run.ts";

let counter = 0;
type Line = Record<string, unknown>;
const header = (id = "s-c") => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-03T10:00:00.000Z", cwd: "/work/app" });
function chain(items: Line[]): Line[] {
	let parentId: string | null = null;
	return items.map((item) => {
		const id = `c${++counter}`;
		const { entryType, ...rest } = item as Line & { entryType?: string };
		const timestamp = `2026-11-03T11:${String(counter % 60).padStart(2, "0")}:00.000Z`;
		const entry = entryType ? { type: entryType, id, parentId, timestamp, ...rest } : { type: "message", id, parentId, timestamp, message: rest };
		parentId = id;
		return entry;
	});
}
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const reply = (text: string, cacheRead = 0) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", provider: "qoder", model: "dfmodel", usage: { input: 10, output: 5, cacheRead }, timestamp: 0 });
const call = (id: string, name: string, args: Record<string, unknown>, cacheRead = 0) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", provider: "qoder", model: "dfmodel", usage: { input: 10, output: 5, cacheRead }, timestamp: 0 });
const result = (id: string, name: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 });
const compaction = (files: { read?: string[]; modified?: string[] }) => ({ entryType: "compaction", summary: "summary", firstKeptEntryId: "x", tokensBefore: 120000, usage: { input: 90000, output: 4000, cacheRead: 0 }, details: { readFiles: files.read ?? [], modifiedFiles: files.modified ?? [] } });

function observe(entries: Line[]) {
	const lines = [header(), ...entries.map((entry) => JSON.stringify(entry))];
	const analyzed = analyzeSession(lines, { sessionFile: "/s.jsonl", excerpts: false });
	if (!analyzed) throw new Error("not a session");
	return analyzeCompactions(lines, analyzed.incidents);
}

describe("post-compaction harvest", () => {
	it("counts re-reads of listed files, recall use and the cache drop after a compaction", () => {
		const [observation] = observe(chain([
			user("refactor the parser"),
			reply("working", 50000),
			compaction({ read: ["src/a.ts", "src/b.ts"], modified: ["src/c.ts"] }),
			call("t1", "read", { path: "src/a.ts" }, 2000),
			result("t1", "read"),
			call("t2", "read", { path: "src/other.ts" }),
			result("t2", "read"),
			call("t3", "context_recall", { query: "error" }),
			result("t3", "context_recall"),
			call("t4", "read", { path: "src/a.ts" }),
			result("t4", "read"),
			reply("done"),
		]));
		expect(observation).toMatchObject({ tokensBefore: 120000, summaryOutputTokens: 4000, listedFiles: 3, rereadFiles: 1, recallCalls: 1, cacheReadBefore: 50000, cacheReadAfter: 2000 });
	});

	it("only reads inside the window count, and a later compaction closes the window", () => {
		const late = observe(chain([
			user("go"),
			compaction({ read: ["a.ts"] }),
			reply("1"), reply("2"), reply("3"), reply("4"), reply("5"),
			call("t1", "read", { path: "a.ts" }),
		]));
		expect(late[0]?.rereadFiles).toBe(0);
		const closed = observe(chain([
			user("go"),
			compaction({ read: ["a.ts"] }),
			compaction({ read: ["b.ts"] }),
			call("t1", "read", { path: "a.ts" }),
		]));
		expect(closed.map((item) => item.rereadFiles)).toEqual([0, 0]);
	});

	it("attributes interventions in the next three user turns, not later ones", () => {
		const [observation] = observe(chain([
			user("implement retries and do not stop until the tests pass"),
			reply("ok"),
			compaction({}),
			reply("I implemented retries. Shall I continue?"),
			user("继续"),
			reply("done"),
			user("不对，你没有跑测试"),
			reply("ran them"),
			user("thanks"),
			reply("ok"),
			user("不对，还是错的"),
			reply("fixed"),
		]));
		expect(observation).toMatchObject({ userTurnsAfter: 3, interventionsAfter: 2 });
	});

	it("aggregates rates and medians without inventing values", () => {
		expect(compactionMetrics([])).toMatchObject({ compactions: 0, rereadRate: null, interventionsPer100TurnsAfter: null, medianSummaryOutputTokens: null });
		const base = { sessionId: "s", timestamp: "t", tokensBefore: 1, summaryInputTokens: 1, cacheReadBefore: 10, cacheReadAfter: 5, recallCalls: 0, goalPausesAfter: 0 };
		const metrics = compactionMetrics([
			{ ...base, entryId: "a", summaryOutputTokens: 100, listedFiles: 2, rereadFiles: 1, userTurnsAfter: 3, interventionsAfter: 1 },
			{ ...base, entryId: "b", summaryOutputTokens: 300, listedFiles: 1, rereadFiles: 0, userTurnsAfter: 2, interventionsAfter: 0, cacheReadAfter: 20 },
			{ ...base, entryId: "c", summaryOutputTokens: null, listedFiles: 0, rereadFiles: 0, userTurnsAfter: 0, interventionsAfter: 0 },
		]);
		expect(metrics).toMatchObject({ compactions: 3, rereadRate: 0.5, interventionsPer100TurnsAfter: 20, medianSummaryOutputTokens: 200, cacheDrops: 2 });
	});
});

describe("harvest output", () => {
	let root: string | undefined;
	afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

	it("writes compactions.jsonl and an after-compaction section without message text", async () => {
		root = await mkdtemp(join(tmpdir(), "rotom-compaction-harvest-"));
		const sessions = join(root, "sessions", "--work-app--");
		await mkdir(sessions, { recursive: true });
		const entries = chain([user("secret request text"), reply("working", 900), compaction({ read: ["a.ts"] }), call("t1", "read", { path: "a.ts" }, 100), result("t1", "read"), reply("done")]);
		await writeFile(join(sessions, "one.jsonl"), [header("s-out"), ...entries.map((entry) => JSON.stringify(entry))].join("\n"));
		const output = await harvest({ sessionsDir: join(root, "sessions"), outRoot: join(root, "out"), since: new Date(0), now: new Date("2026-11-09T00:00:00Z"), excerpts: false });
		expect(output.compactions).toHaveLength(1);
		const jsonl = await readFile(join(output.outDir, "compactions.jsonl"), "utf8");
		expect(jsonl).not.toContain("secret request text");
		expect(JSON.parse(jsonl.trim())).toMatchObject({ rereadFiles: 1, cacheReadBefore: 900, cacheReadAfter: 100 });
		const report = await readFile(join(output.outDir, "report.md"), "utf8");
		expect(report).toContain("## After compaction");
		expect(report).toContain("| Re-read a listed file | 100% |");
		const summary = JSON.parse(await readFile(join(output.outDir, "summary.json"), "utf8"));
		expect(summary.compactions.compactions).toBe(1);
	});
});
