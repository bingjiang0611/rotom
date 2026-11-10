import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { scoreSubagentAbCase, subagentAbCases, subagentAbKeys } from "../src/subagent-ab-cases.ts";
import { SUBAGENT_AB_ARMS, subagentAbHarness, subagentAbStoreRoot } from "../src/subagent-ab-harness.ts";
import { defaultProductAgentDir } from "../src/product-runtime.ts";

// Oracle for plan P1-4. It proves the answer keys match the generated fixtures, that the
// scorer separates right from wrong answers, and that the two arms differ only by the
// Subagent tools in a real product session. Child runs need a live model, so delegation
// itself is not exercised here.
afterEach(() => vi.unstubAllGlobals());

const inventory = subagentAbCases.find((item) => item.id === "subagent-ab-legacy-inventory")!;
const review = subagentAbCases.find((item) => item.id === "subagent-ab-seeded-review")!;

it("the inventory key is what the fixture actually contains, decoys included", () => {
	const files = inventory.fixture();
	const derived = Object.entries(files)
		.filter(([path, body]) => path.endsWith("/client.ts") && /^\s*return legacyFetch\(/mu.test(body))
		.map(([path]) => {
			const name = path.split("/")[1]!;
			return { name, retryLimit: JSON.parse(files[`services/${name}/config.json`]!).retryLimit };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
	expect(derived).toEqual(subagentAbKeys.inventory());
	expect(derived.length).toBeGreaterThanOrEqual(4);
	const decoys = Object.entries(files).filter(([path]) => path.endsWith("/client.ts") && !derived.some((item) => path.includes(item.name)));
	expect(decoys.some(([, body]) => body.includes("// migrated from legacyFetch"))).toBe(true);
	expect(decoys.some(([, body]) => body.includes("legacyFetchCompat"))).toBe(true);
	expect(JSON.stringify(inventory.fixture())).toBe(JSON.stringify(files));
});

it("every review finding names a real function, and correct functions exist beside them", () => {
	const files = review.fixture();
	for (const { file, function: name } of subagentAbKeys.review()) expect(files[file], file).toMatch(new RegExp(`function ${name}\\(`, "u"));
	for (const [file, name] of [["src/billing/convert.ts", "toMinutes"], ["src/search/paginate.ts", "offset"], ["src/sync/flush.ts", "flushOne"]]) expect(files[file]).toContain(`function ${name}(`);
});

it("the scorer separates correct, incomplete, over-reported and decoy-fooled answers", () => {
	const key = subagentAbKeys.inventory();
	const answer = (services: unknown) => JSON.stringify({ services });
	expect(scoreSubagentAbCase(inventory.id, answer(key)).passed).toBe(true);
	expect(scoreSubagentAbCase(inventory.id, `Here you go:\n\`\`\`json\n${answer(key)}\n\`\`\``).passed).toBe(true);
	expect(scoreSubagentAbCase(inventory.id, answer(key.slice(1))).checks.exactServiceSet).toBe(false);
	expect(scoreSubagentAbCase(inventory.id, answer([...key, { name: "svc-04", retryLimit: 3 }].sort((a, b) => a.name.localeCompare(b.name)))).passed).toBe(false);
	expect(scoreSubagentAbCase(inventory.id, answer(key.map((item, index) => index === 0 ? { ...item, retryLimit: item.retryLimit + 1 } : item))).checks).toMatchObject({ exactServiceSet: true, exactRetryLimits: false });
	expect(scoreSubagentAbCase(inventory.id, "no json here").checks.answerParsed).toBe(false);

	const findings = subagentAbKeys.review();
	expect(scoreSubagentAbCase(review.id, JSON.stringify({ findings: [...findings].reverse() })).passed).toBe(true);
	expect(scoreSubagentAbCase(review.id, JSON.stringify({ findings: findings.slice(1) })).checks.allDefectsFound).toBe(false);
	expect(scoreSubagentAbCase(review.id, JSON.stringify({ findings: [...findings, { file: "src/search/rank.ts", function: "rank" }] })).checks.noFalsePositives).toBe(false);
});

it("in a real product session the arms differ only by the Subagent tools", async () => {
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in this oracle"); }));
	const productDir = defaultProductAgentDir();
	const piPackage = join(productDir, "runtime/pi/node_modules/@earendil-works/pi-coding-agent");
	const metadata = JSON.parse(await readFile(join(piPackage, "package.json"), "utf8"));
	const storeRoot = await subagentAbStoreRoot();
	const activeTools: Record<string, string[]> = {};
	for (const arm of ["baseline", "candidate"] as const) {
		const harness = subagentAbHarness({
			arm, productAgentDir: productDir, storeRoot, model: { provider: "subagent-ab-fixture", id: "fixture" },
			extra: {
				piExecutable: join(piPackage, metadata.bin.pi),
				environment: { PI_SUBAGENTS_EXECUTION_SCOPE: "owned-process-groups-v2", PI_SUBAGENTS_TEMP_ROOT: storeRoot, ROTOM_QODER: "0", ROTOM_OBSERVABILITY: "0" },
				noContextFiles: true,
				async modelRuntimeFactory({ product, configDir }) {
					const { fauxAssistantMessage, fauxProvider, getCurrentTools } = await import(pathToFileURL(join(product.verified.packageRoot, "../pi-ai/dist/index.js")).href);
					const faux = fauxProvider({ provider: "subagent-ab-fixture", models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 1024 }] });
					faux.setResponses([(context: { messages: unknown[] }) => {
						activeTools[arm] = getCurrentTools(context.messages).map((tool: { name: string }) => tool.name).sort();
						return fauxAssistantMessage("{\"services\":[]}");
					}]);
					const runtime = await product.runtime.ModelRuntime.create({ authPath: join(configDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
					runtime.registerNativeProvider(faux.provider);
					return runtime;
				},
			},
		});
		await harness.run({ id: inventory.id, steps: [{ type: "prompt", content: inventory.prompt }] }, { artifacts: {}, setArtifact() {} });
	}
	expect(activeTools.baseline).toEqual([...SUBAGENT_AB_ARMS.baseline].sort());
	expect(activeTools.candidate).toEqual([...SUBAGENT_AB_ARMS.candidate].sort());
}, 120_000);
