import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeAgreement, renderAgreementMarkdown, type AgreementRow, type SignalStatus } from "../scripts/agreement.mjs";

const cli = fileURLToPath(new URL("../scripts/session-cards.mjs", import.meta.url));
const row = (sessionId: string, verdict: string, signals: Record<string, SignalStatus>, categories: string[] = []): AgreementRow => ({ sessionId, verdict, signals, categories });
const fourCells = () => [
	row("private-tp-session", "fail", { "future-judge": "hit" }, ["covered"]),
	row("private-fp-session", "pass", { "future-judge": "hit" }),
	row("private-fn-session", "fail", { "future-judge": "clear" }, ["missed"]),
	row("private-tn-session", "pass", { "future-judge": "clear" }),
];
const signalLine = (report: string, name: string) => report.split("\n").find((line) => line.startsWith(`| ${name} |`))!;

describe("computeAgreement", () => {
	it("computes all four cells and ratios for an unregistered signal name", () => {
		const result = computeAgreement(fourCells());
		expect(result.totalRows).toBe(4);
		expect(result.evaluatedRows).toBe(4);
		expect(result.ignoredVerdicts).toBe(0);
		expect(result.signals).toEqual({ "future-judge": { tp: 1, fp: 1, fn: 1, tn: 1, unknown: 0, precision: 0.5, recall: 0.5, specificity: 0.5 } });
		expect(result.reviewSessions["future-judge"]).toEqual({ fp: ["private-fp-session"], fn: ["private-fn-session"] });
		const report = renderAgreementMarkdown(result);
		expect(signalLine(report, "future-judge")).toBe("| future-judge | 1 | 1 | 1 | 1 | 0 | 50.00% (n<10) | 50.00% (n<10) | 50.00% (n<10) |");
		expect(report).toContain("- FP：private-fp-session");
		expect(report).toContain("- FN：private-fn-session");
	});

	it("uses distinct denominators for asymmetric counts", () => {
		const cells = [[2, "fail", "hit"], [1, "pass", "hit"], [3, "fail", "clear"], [4, "pass", "clear"]] as const;
		const rows = cells.flatMap(([count, verdict, status], group) => Array.from({ length: count }, (_, index) => row(`${group}-${index}`, verdict, { asymmetric: status })));
		const result = computeAgreement(rows);
		expect(result.signals.asymmetric).toEqual({ tp: 2, fp: 1, fn: 3, tn: 4, unknown: 0, precision: 2 / 3, recall: 0.4, specificity: 0.8 });
		expect(signalLine(renderAgreementMarkdown(result), "asymmetric")).toBe("| asymmetric | 2 | 1 | 3 | 4 | 0 | 66.67% (n<10) | 40.00% (n<10) | 80.00% (n<10) |");
	});

	it("excludes unknown and absent signals from the four cells and ignores other verdicts", () => {
		const result = computeAgreement([
			...fourCells(), row("unknown", "fail", { "future-judge": "unknown" }), row("absent", "pass", {}),
			row("ignored", "pending", { "ignored-signal": "hit" }, ["ignored-category"]),
			row("blank", "", {}),
		]);
		expect(result).toMatchObject({ totalRows: 8, evaluatedRows: 6, ignoredVerdicts: 2 });
		expect(result.signals).toEqual({ "future-judge": { tp: 1, fp: 1, fn: 1, tn: 1, unknown: 2, precision: 0.5, recall: 0.5, specificity: 0.5 } });
		expect(result.categories).not.toHaveProperty("ignored-category");
	});

	it("returns null and n/a for zero denominators", () => {
		const result = computeAgreement([row("unknown", "fail", { fresh: "unknown" })]);
		expect(result.signals.fresh).toEqual({ tp: 0, fp: 0, fn: 0, tn: 0, unknown: 1, precision: null, recall: null, specificity: null });
		expect(signalLine(renderAgreementMarkdown(result), "fresh")).toBe("| fresh | 0 | 0 | 0 | 0 | 1 | n/a | n/a | n/a |");
	});

	it.each([9, 10])("marks each ratio by its own denominator at n=%s", (count) => {
		const failing = Array.from({ length: count }, (_, index) => row(`f-${index}`, "fail", { fresh: "hit" }));
		const passing = [row("p", "pass", { fresh: "clear" })];
		const line = signalLine(renderAgreementMarkdown(computeAgreement([...failing, ...passing])), "fresh");
		const rate = count < 10 ? "100.00% (n<10)" : "100.00%";
		expect(line).toBe(`| fresh | ${count} | 0 | 0 | 1 | 0 | ${rate} | ${rate} | 100.00% (n<10) |`);
	});

	it("counts fail categories once per row and lists categories with no hits", () => {
		const result = computeAgreement([
			row("a", "fail", { alpha: "hit", beta: "clear" }, ["covered", "covered"]),
			row("b", "fail", { alpha: "unknown" }, ["missed"]),
			row("c", "fail", { alpha: "clear", beta: "clear" }, ["missed"]),
			row("d", "fail", { alpha: "clear", beta: "hit" }, ["covered"]),
			row("e", "pass", { alpha: "hit" }, ["pass-only"]),
		]);
		expect(result.categories).toEqual({
			covered: { fail: 2, hits: { alpha: 1, beta: 1 } },
			missed: { fail: 2, hits: { alpha: 0, beta: 0 } },
			"pass-only": { fail: 0, hits: { alpha: 0, beta: 0 } },
		});
		expect(result.uncoveredCategories).toEqual(["missed", "pass-only"]);
		const report = renderAgreementMarkdown(result);
		expect(report).toContain("| 类别 | fail 会话数 | alpha | beta |");
		expect(report).toContain("| covered | 2 | 1 | 1 |");
		expect(report).toContain("## 没有信号 hit 的类别\n\n- missed\n- pass-only");
	});

	it("supports arbitrary own signal/category keys without inherited values", () => {
		const signals = JSON.parse('{"__proto__":"hit","constructor":"clear"}');
		const result = computeAgreement([row("one", "fail", signals, ["__proto__"]), row("two", "pass", {})]);
		expect(result.signals["__proto__"]).toMatchObject({ tp: 1, unknown: 1 });
		expect(result.signals.constructor).toMatchObject({ fn: 1, unknown: 1 });
		expect(result.categories["__proto__"].hits["__proto__"]).toBe(1);
	});

	it("does not mutate inputs or results and escapes Markdown metadata", () => {
		const rows = [...fourCells(), row("odd-session", "fail", { "judge|new": "clear" }, ["<category>\n|name"])];
		const before = JSON.stringify(rows);
		const result = computeAgreement(rows);
		const beforeRender = JSON.stringify(result);
		const report = renderAgreementMarkdown(result);
		expect(JSON.stringify(rows)).toBe(before);
		expect(JSON.stringify(result)).toBe(beforeRender);
		expect(report).toContain("judge\\|new");
		expect(report).not.toContain("<category>");
	});

	it("handles empty input without inventing signals or a score", () => {
		expect(computeAgreement([])).toEqual({ totalRows: 0, evaluatedRows: 0, ignoredVerdicts: 0, signals: {}, categories: {}, uncoveredCategories: [], reviewSessions: {} });
		expect(renderAgreementMarkdown(computeAgreement([]))).toContain("输入 0 行；有效 0 行；忽略 verdict 0 行。");
	});

	it("rejects invalid statuses rather than counting them as clear", () => {
		expect(() => computeAgreement([row("bad", "fail", { fresh: "invalid" as SignalStatus })])).toThrow("Invalid agreement row");
	});
});

let directory: string;
let out: string;
const run = (...args: string[]) => spawnSync(process.execPath, [cli, "agreement", ...args], { encoding: "utf8" });
async function labels(rows = fourCells()) {
	const path = join(dirname(out), "labels.jsonl");
	const content = rows.map(({ signals, ...entry }) => JSON.stringify({ ...entry, findings: signals, note: "PRIVATE_NOTE", cardPath: "/synthetic/private/card.md" })).join("\n") + "\n";
	await writeFile(path, content, { mode: 0o600 });
	return { path, content };
}

describe("agreement CLI", () => {
	beforeEach(async () => {
		directory = await realpath(await mkdtemp(join(tmpdir(), "rotom-agreement-test-")));
		out = join(directory, "private", "cards");
		await mkdir(out, { recursive: true, mode: 0o700 });
	});
	afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
	it("prints only aggregate data and writes private FP/FN IDs without changing labels", async () => {
		const input = await labels();
		const destination = join(dirname(out), "agreement.md");
		await writeFile(destination, "old report");
		await chmod(destination, 0o644);
		const result = run("--out", out);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		const summary = JSON.parse(result.stdout);
		expect(summary).toMatchObject({ totalRows: 4, evaluatedRows: 4, ignoredVerdicts: 0, uncoveredCategories: 1 });
		expect(summary.signals["future-judge"]).toEqual({ tp: 1, fp: 1, fn: 1, tn: 1, unknown: 0, precision: 0.5, recall: 0.5, specificity: 0.5 });
		expect(summary).not.toHaveProperty("reviewSessions");
		for (const entry of fourCells()) expect(result.stdout).not.toContain(entry.sessionId);
		for (const hidden of ["PRIVATE_NOTE", "/synthetic/private", "sessionId", "cardPath"]) expect(result.stdout).not.toContain(hidden);
		const report = await readFile(destination, "utf8");
		expect(report).toContain("private-fp-session");
		expect(report).toContain("private-fn-session");
		expect(report).not.toContain("PRIVATE_NOTE");
		expect((await stat(destination)).mode & 0o777).toBe(0o600);
		expect(await readFile(input.path, "utf8")).toBe(input.content);
	});

	it.each(["directory", "file"])("rejects a Git worktree with .git as a %s, including aliases", async (kind) => {
		const repo = join(directory, "repo");
		await mkdir(repo);
		if (kind === "directory") await mkdir(join(repo, ".git"));
		else await writeFile(join(repo, ".git"), "gitdir: synthetic");
		const alias = join(directory, "repo-alias");
		await symlink(repo, alias);
		for (const root of [repo, alias]) expect(run("--out", join(root, "cards")).status).not.toBe(0);
		await expect(stat(join(repo, "agreement.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fails without a partial report on malformed labels or invalid findings", async () => {
		const input = await labels();
		const destination = join(dirname(out), "agreement.md");
		await writeFile(destination, "KEEP_REPORT");
		for (const content of [input.content + "{PRIVATE_BROKEN_JSON\n", JSON.stringify({ sessionId: "private-bad", verdict: "fail", findings: { fresh: "invalid" } })]) {
			await writeFile(input.path, content);
			const result = run("--out", out);
			expect(result.status).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toMatch(/PRIVATE_BROKEN_JSON|private-bad/);
			expect(await readFile(destination, "utf8")).toBe("KEEP_REPORT");
		}
	});

	it("supports empty labels and treats missing findings as unknown for observed names", async () => {
		const path = join(dirname(out), "labels.jsonl");
		await writeFile(path, "");
		expect(JSON.parse(run("--out", out).stdout)).toEqual({ totalRows: 0, evaluatedRows: 0, ignoredVerdicts: 0, signals: {}, categories: {}, uncoveredCategories: 0, judge: { tp: 0, fp: 0, fn: 0, tn: 0, n: 0 } });
		await writeFile(path, [
			{ sessionId: "old-private", verdict: "fail" },
			{ sessionId: "new-private", verdict: "pass", findings: { future: "clear" } },
			{ sessionId: "pending-private", verdict: "pending" },
		].map((entry) => JSON.stringify(entry)).join("\n"));
		const result = run("--out", out);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ totalRows: 3, evaluatedRows: 2, ignoredVerdicts: 1, signals: { future: { tp: 0, fp: 0, fn: 0, tn: 1, unknown: 1 } } });
	});

	it("rejects symlink reports and labels without altering their targets", async () => {
		const input = await labels();
		const target = join(directory, "untouched");
		await writeFile(target, "KEEP_TARGET");
		const destination = join(dirname(out), "agreement.md");
		await symlink(target, destination);
		expect(run("--out", out).status).not.toBe(0);
		await rm(destination);
		await rm(input.path);
		await symlink(target, input.path);
		expect(run("--out", out).status).not.toBe(0);
		expect(await readFile(target, "utf8")).toBe("KEEP_TARGET");
		await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("adds the latest successful definite judge/human matrix without exposing sessions", async () => {
		const rows = [
			{ sessionId: "synthetic-tp", verdict: "fail", suggested: "fail" },
			{ sessionId: "synthetic-fp", verdict: "pass", suggested: "fail" },
			{ sessionId: "synthetic-fn", verdict: "fail", suggested: "pass" },
			{ sessionId: "synthetic-tn", verdict: "pass", suggested: "pass" },
			{ sessionId: "synthetic-unsure", verdict: "pass", suggested: "unsure" },
		];
		await writeFile(join(dirname(out), "labels.jsonl"), rows.map(({ sessionId, verdict }) => JSON.stringify({ sessionId, verdict })).join("\n"));
		for (const row of rows) {
			const folder = join(dirname(out), "judgments", row.sessionId);
			await mkdir(folder, { recursive: true, mode: 0o700 });
			await writeFile(join(folder, "2026-01-01T00-00-00.000Z.json"), JSON.stringify({ schema: "rotom-eval-judgment/v1", sessionId: row.sessionId, status: "ok", result: { suggestedVerdict: row.suggested } }), { mode: 0o600 });
		}
		const result = run("--out", out);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout).judge).toEqual({ tp: 1, fp: 1, fn: 1, tn: 1, n: 4 });
		expect(result.stdout).not.toContain("synthetic-");
		expect(await readFile(join(dirname(out), "agreement.md"), "utf8")).toContain("| 4* | 1 | 1 | 1 | 1 |");
	});

	it("does not accept build-only flags", async () => {
		await labels();
		expect(run("--out", out, "--limit", "1").status).not.toBe(0);
		await expect(stat(join(dirname(out), "agreement.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
