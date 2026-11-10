import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeSession } from "../src/loop/harvest.ts";
import { harvest, weeklyMetrics } from "../src/loop/harvest-run.ts";

let counter = 0;
type Line = Record<string, unknown>;

function session(lines: Line[]): string[] {
	return [JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: "2026-11-03T10:00:00.000Z", cwd: "/work/app" }), ...lines.map((line) => JSON.stringify(line))];
}

/** Linear chain: each entry's parent is the previous one unless given. */
function chain(messages: (Record<string, unknown> & { entryType?: string })[]): Line[] {
	let parentId: string | null = null;
	return messages.map((item) => {
		const id = `e${++counter}`;
		const { entryType, ...rest } = item;
		const entry: Line = entryType ? { type: entryType, id, parentId, timestamp: `2026-11-03T10:${String(counter % 60).padStart(2, "0")}:00.000Z`, ...rest } : { type: "message", id, parentId, timestamp: `2026-11-03T10:${String(counter % 60).padStart(2, "0")}:00.000Z`, message: rest };
		parentId = id;
		return entry;
	});
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const reply = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, provider: "qoder", model: "dfmodel", timestamp: 0 });

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("loop harvest output", () => {
	const roots: string[] = [];
	afterEach(async () => {
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	it("writes a private report, skips symlinks, traces and subagent stores", async () => {
		const root = await mkdtemp(join(tmpdir(), "loop-harvest-"));
		roots.push(root);
		const sessions = join(root, "sessions", "--work-app--");
		await mkdir(join(sessions, "observability"), { recursive: true });
		await mkdir(join(sessions, "subagent-artifacts"), { recursive: true });
		const lines = session(chain([user("修 bug"), reply("done"), user("不对，你没有跑测试")]));
		await writeFile(join(sessions, "2026-11-03_s-1.jsonl"), `${lines.join("\n")}\n{"torn`);
		await writeFile(join(sessions, "observability", "2026-11-03_s-1.trace.jsonl"), `${JSON.stringify({ kind: "span_end", name: "pi.session.compaction", status: "error", spanId: "t" })}\n`);
		await writeFile(join(sessions, "subagent-artifacts", "child.jsonl"), lines.join("\n"));
		await writeFile(join(root, "elsewhere.jsonl"), lines.join("\n"));
		await symlink(join(root, "elsewhere.jsonl"), join(sessions, "linked.jsonl"));

		const out = join(root, "loop");
		const result = await harvest({ sessionsDir: join(root, "sessions"), outRoot: out, since: new Date("2026-01-01T00:00:00Z"), now: new Date("2026-11-09T00:00:00Z"), excerpts: true });
		expect(result.sessions).toHaveLength(1);
		expect(result.incidents.map((incident) => incident.kind).sort()).toEqual(["compaction_failed", "user_correction"]);
		// One symlink plus the trace and subagent subtrees the product writes beside sessions.
		expect(result.skipped).toEqual({ symlink: 1, "artifact-store": 2 });
		expect(((await lstat(result.outDir)).mode & 0o777)).toBe(0o700);
		const files = (await readdir(result.outDir)).sort();
		expect(files).toEqual(["compactions.jsonl", "incidents.jsonl", "report.md", "sessions.jsonl", "summary.json"]);
		for (const file of files) expect(((await lstat(join(result.outDir, file))).mode & 0o777)).toBe(0o600);
		const report = await readFile(join(result.outDir, "report.md"), "utf8");
		expect(report).toContain("| 2026-W45 | 1 | 2 | 1 | 50 | 0–148 | 1 | 50 |");
		expect(JSON.parse(await readFile(join(result.outDir, "summary.json"), "utf8"))).toMatchObject({ schema: "rotom-loop-harvest/v1", sessions: 1, incidents: 2 });
	});

	it("records the versions and the first assistant model a session proves, and layers the report by them", async () => {
		const root = await mkdtemp(join(tmpdir(), "loop-harvest-version-"));
		roots.push(root);
		const sessions = join(root, "sessions", "--work-app--");
		await mkdir(join(sessions, "observability"), { recursive: true });
		const trace = [
			JSON.stringify({ schema: "rotom-local-trace/v1", kind: "span_start", name: "pi.session.runtime", spanId: "t", timestamp: "2026-11-11T09:00:00.000Z", attributes: { "rotom.product.version": "0.1.27", "pi.runtime.version": "1.4.0-rotom.3" } }),
		];
		const lines = session(chain([user("修 bug"), reply("done"), user("继续"), reply("ok")]));
		await writeFile(join(sessions, "2026-11-11_s-1.jsonl"), `${lines.join("\n")}\n`);
		await writeFile(join(sessions, "observability", "2026-11-11_s-1.trace.jsonl"), `${trace.join("\n")}\n`);

		const analyzed = analyzeSession(lines, { sessionFile: "/s.jsonl", excerpts: false, traceLines: trace });
		expect(analyzed?.session).toMatchObject({ productVersion: "0.1.27", runtimeVersion: "1.4.0-rotom.3", firstAssistantModel: "qoder/dfmodel" });
		// No SoL-Pi archive path and no product attribute means unknown, never inferred.
		expect(analyzed?.session.solPiVersion).toBeUndefined();

		const result = await harvest({ sessionsDir: join(root, "sessions"), outRoot: join(root, "loop"), since: new Date("2026-01-01T00:00:00Z"), now: new Date("2026-11-11T12:00:00Z"), excerpts: false, experiment: "default-model" });
		const report = await readFile(join(result.outDir, "report.md"), "utf8");
		expect(report).toContain("### Task size per model");
		expect(report).toContain("### The same rate per model without its largest session");
		expect(report).toContain("### The same rate per product version");
		expect(report).toContain("| 0.1.27 | 2 |");
		expect(report).toContain("### The same rate per SoL-Pi version");
		expect(report).toContain("## Experiment: default model by date parity");
		// Neither default model was used, so both groups are empty and the session is listed instead.
		expect(report).toContain("| openai-codex/gpt-6-astra | 0 | 0 | 0 | N/A | N/A |");
		expect(report).toContain("Never used the day's default model");
	});

	it("counts a conversation copied into a fork once", async () => {
		const root = await mkdtemp(join(tmpdir(), "loop-harvest-fork-"));
		roots.push(root);
		const sessions = join(root, "sessions", "--work-app--");
		await mkdir(sessions, { recursive: true });
		const shared = chain([user("修 bug"), reply("done"), user("不对，你没有跑测试"), reply("好的")]);
		const forkTail = { type: "message", id: "tail", parentId: shared[3].id, timestamp: "2026-11-03T13:00:00.000Z", message: user("继续") };
		const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-03T10:00:00.000Z", cwd: "/work/app" });
		await writeFile(join(sessions, "2026-11-03_s-1.jsonl"), [header("s-1"), ...shared.map((line) => JSON.stringify(line))].join("\n"));
		await writeFile(join(sessions, "2026-11-04_s-2.jsonl"), [header("s-2"), ...shared.map((line) => JSON.stringify(line)), JSON.stringify(forkTail)].join("\n"));

		const result = await harvest({ sessionsDir: join(root, "sessions"), outRoot: join(root, "loop"), since: new Date("2026-01-01T00:00:00Z"), now: new Date("2026-11-09T00:00:00Z"), excerpts: false });
		expect(result.incidents.map((incident) => incident.kind)).toEqual(["user_correction", "bare_continue"]);
		expect(result.sessions.reduce((sum, item) => sum + item.userTurns, 0)).toBe(3);
		expect(result.sessions.reduce((sum, item) => sum + item.interventions, 0)).toBe(2);
	});
});
