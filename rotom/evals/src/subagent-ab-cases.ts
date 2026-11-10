/**
 * Subagent on/off pairing (optimization plan P1-4). Both arms run the same product and
 * the same read-only tools; the candidate arm also has `subagent` and `subagent_wait`.
 * The tasks are the kind delegation is meant for — wide read-only search and review —
 * and their answers are fixed by a generated fixture, so a run is right or wrong
 * without a model judge. Cost and time are recorded beside the score, not inside it.
 */

export const BASE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const SUBAGENT_TOOLS = ["subagent", "subagent_wait"] as const;

const SERVICE_COUNT = 24;
// Deterministic pseudo-random choices: the fixture must be identical on every run.
const pick = (index: number, modulo: number) => (index * 7 + 3) % modulo;

function serviceName(index: number): string {
	return `svc-${String(index + 1).padStart(2, "0")}`;
}

/** Services that still call `legacyFetch`, with their configured retry limit. */
function inventoryKey(): { name: string; retryLimit: number }[] {
	const key: { name: string; retryLimit: number }[] = [];
	for (let index = 0; index < SERVICE_COUNT; index++) {
		if (pick(index, 5) === 0) key.push({ name: serviceName(index), retryLimit: 2 + pick(index, 6) });
	}
	return key;
}

function inventoryFixture(): Record<string, string> {
	const files: Record<string, string> = {
		"README.md": "Each service lives in services/<name>/ with client.ts and config.json. legacyFetch is deprecated; httpClient.get is its replacement.\n",
	};
	const legacy = new Set(inventoryKey().map((item) => item.name));
	for (let index = 0; index < SERVICE_COUNT; index++) {
		const name = serviceName(index);
		const usesLegacy = legacy.has(name);
		// Decoys: a comment that mentions legacyFetch and a wrapper named legacyFetchCompat.
		const decoy = pick(index, 4) === 2 ? "// migrated from legacyFetch in 2025\n" : pick(index, 4) === 3 ? "import { legacyFetchCompat } from '../../shared/compat';\n" : "";
		files[`services/${name}/client.ts`] = `${decoy}import { httpClient } from '../../shared/http';\n${usesLegacy ? "import { legacyFetch } from '../../shared/legacy';\n" : ""}\nexport async function load(id: string) {\n  ${usesLegacy ? "return legacyFetch(`/" + name + "/${id}`);" : "return httpClient.get(`/" + name + "/${id}`);"}\n}\n`;
		files[`services/${name}/config.json`] = `${JSON.stringify({ service: name, retryLimit: 2 + pick(index, 6), timeoutMs: 500 + pick(index, 9) * 100 }, null, 2)}\n`;
	}
	return files;
}

/** Seeded review defects: file and function, the unit a reviewer can name reliably. */
const REVIEW_KEY = [
	{ file: "src/billing/convert.ts", function: "toSeconds" },
	{ file: "src/billing/invoice.ts", function: "dueDate" },
	{ file: "src/search/paginate.ts", function: "pageCount" },
	{ file: "src/sync/flush.ts", function: "flushAll" },
];

function reviewFixture(): Record<string, string> {
	return {
		"README.md": "Durations are milliseconds unless a function name says otherwise. Dates are UTC. Every async write must be awaited before reporting success.\n",
		"src/billing/convert.ts": "export function toSeconds(ms: number): number {\n  return ms / 100;\n}\n\nexport function toMinutes(ms: number): number {\n  return ms / 60_000;\n}\n",
		"src/billing/invoice.ts": "export function dueDate(issued: Date, days: number): Date {\n  const due = new Date(issued);\n  due.setDate(due.getDate() + days);\n  return due;\n}\n\nexport function total(lines: number[]): number {\n  return lines.reduce((sum, line) => sum + line, 0);\n}\n",
		"src/search/paginate.ts": "export function pageCount(total: number, size: number): number {\n  return Math.floor(total / size);\n}\n\nexport function offset(page: number, size: number): number {\n  return page * size;\n}\n",
		"src/sync/flush.ts": "import { write } from './store';\n\nexport async function flushAll(items: string[]): Promise<number> {\n  for (const item of items) write(item);\n  return items.length;\n}\n\nexport async function flushOne(item: string): Promise<void> {\n  await write(item);\n}\n",
		"src/sync/store.ts": "export async function write(item: string): Promise<void> {\n  if (!item) throw new Error('empty');\n}\n",
		"src/search/rank.ts": "export function rank(scores: number[]): number[] {\n  return [...scores].sort((a, b) => b - a);\n}\n",
	};
}

export type SubagentAbCase = {
	id: "subagent-ab-legacy-inventory" | "subagent-ab-seeded-review";
	label: string;
	prompt: string;
	fixture: () => Record<string, string>;
	score: (answer: unknown) => Record<string, boolean>;
};

function parseAnswer(response: string): unknown {
	const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/u)?.[1] ?? response;
	const start = fenced.indexOf("{");
	const end = fenced.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		return JSON.parse(fenced.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

export const subagentAbCases: SubagentAbCase[] = [
	{
		id: "subagent-ab-legacy-inventory",
		label: "list every service that still calls legacyFetch, with its retry limit",
		prompt: "列出 services/ 下仍然调用 legacyFetch 的全部服务，并给出每个服务 config.json 里的 retryLimit。注释里提到或只导入兼容封装的不算。不要修改文件。最后只回一个 JSON：{\"services\":[{\"name\":\"svc-NN\",\"retryLimit\":数字}]}，按 name 升序。",
		fixture: inventoryFixture,
		score: (answer) => {
			const services = record(answer).services;
			const expected = inventoryKey();
			const actual = Array.isArray(services) ? services.map((item) => ({ name: record(item).name, retryLimit: record(item).retryLimit })) : [];
			return {
				answerParsed: Array.isArray(services),
				exactServiceSet: JSON.stringify(actual.map((item) => item.name)) === JSON.stringify(expected.map((item) => item.name)),
				exactRetryLimits: JSON.stringify(actual) === JSON.stringify(expected),
			};
		},
	},
	{
		id: "subagent-ab-seeded-review",
		label: "review src/ against the README rules and name each defective function",
		prompt: "按 README.md 的约定审查 src/ 下的全部代码，找出违反约定或有明确缺陷的函数。不要修改文件。最后只回一个 JSON：{\"findings\":[{\"file\":\"src/...\",\"function\":\"名字\"}]}。",
		fixture: reviewFixture,
		score: (answer) => {
			const findings = record(answer).findings;
			const keyOf = (item: unknown) => `${String(record(item).file)}#${String(record(item).function)}`;
			const actual = new Set(Array.isArray(findings) ? findings.map(keyOf) : []);
			const expected = new Set(REVIEW_KEY.map(keyOf));
			return {
				answerParsed: Array.isArray(findings),
				allDefectsFound: [...expected].every((key) => actual.has(key)),
				noFalsePositives: [...actual].every((key) => expected.has(key)),
			};
		},
	},
];

export function scoreSubagentAbCase(id: string, response: string): { passed: boolean; checks: Record<string, boolean> } {
	const item = subagentAbCases.find((candidate) => candidate.id === id);
	if (!item) throw new Error(`Unknown Subagent A/B case: ${id}`);
	const checks = item.score(parseAnswer(response));
	return { passed: Object.values(checks).every(Boolean), checks };
}

/** Exposed so the oracle can prove the answer key matches the generated fixture. */
export const subagentAbKeys = { inventory: inventoryKey, review: () => REVIEW_KEY.map((item) => ({ ...item })) };
