import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Load sol-pi.ts through the verified Pi's own jiti, as the product loader does.
function findPiDist(): string {
	for (const candidate of [process.env.ROTOM_VERIFIED_PI_EXECUTABLE, process.env.ROTOM_PI]) {
		if (!candidate || !existsSync(candidate)) continue;
		for (let directory = dirname(realpathSync(candidate)); ; directory = dirname(directory)) {
			if (existsSync(join(directory, "core/extensions/loader.js"))) return directory;
			if (dirname(directory) === directory) break;
		}
	}
	throw new Error("Set ROTOM_PI or ROTOM_VERIFIED_PI_EXECUTABLE to the product Pi.");
}

function findDependency(piDist: string, relativePath: string): string {
	for (let directory = piDist; ; directory = dirname(directory)) {
		const candidate = join(directory, "node_modules", relativePath);
		if (existsSync(candidate)) return candidate;
		if (dirname(directory) === directory) throw new Error(`Cannot resolve ${relativePath} from Pi dist`);
	}
}

test("ROTOM_EVIDENCE_REDUCER switches only the Reducer, over the default or a config file", async (t) => {
	const original = process.env.ROTOM_EVIDENCE_REDUCER;
	t.after(() => {
		if (original === undefined) delete process.env.ROTOM_EVIDENCE_REDUCER;
		else process.env.ROTOM_EVIDENCE_REDUCER = original;
	});
	const workspace = mkdtempSync(join(tmpdir(), "rotom-sol-pi-reducer-"));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const piDist = findPiDist();
	const { createJiti } = await import(pathToFileURL(findDependency(piDist, "jiti/lib/jiti.mjs")).href);
	const jiti = createJiti(pathToFileURL(join(piDist, "core/extensions/loader.js")).href, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": join(piDist, "index.js") } });
	const { loadRotomSolPiConfig } = await jiti.import(join(import.meta.dirname, "sol-pi.ts")) as any;
	const agentDir = join(workspace, "agent");
	mkdirSync(agentDir);
	const ctx = { cwd: workspace, isProjectTrusted: () => false };
	const features = (config: any) => [config.actionFusion, config.observationPack, config.evidencePreservingReducer, config.compactionOffload];
	const warnings: string[] = [];
	t.mock.method(console, "error", (message: string) => warnings.push(message));
	const cases = [
		{ name: "unset keeps the rotom default", env: undefined, config: undefined, expected: [true, true, true, true], warning: false },
		{ name: "0 turns only the Reducer off", env: "0", config: undefined, expected: [true, true, false, true], warning: false },
		{ name: "0 overrides a config file", env: "0", config: { version: 1, actionFusion: true, evidencePreservingReducer: true }, expected: [true, false, false, false], warning: false },
		{ name: "1 overrides a config file", env: "1", config: { version: 1, actionFusion: true }, expected: [true, false, true, false], warning: false },
		{ name: "invalid value keeps the config and warns", env: "off", config: undefined, expected: [true, true, true, true], warning: true },
	];
	for (const scenario of cases) await t.test(scenario.name, () => {
		if (scenario.env === undefined) delete process.env.ROTOM_EVIDENCE_REDUCER;
		else process.env.ROTOM_EVIDENCE_REDUCER = scenario.env;
		if (scenario.config) writeFileSync(join(agentDir, "sol-pi.json"), JSON.stringify(scenario.config));
		else rmSync(join(agentDir, "sol-pi.json"), { force: true });
		warnings.length = 0;
		assert.deepEqual(features(loadRotomSolPiConfig(ctx, agentDir)), scenario.expected);
		assert.equal(warnings.length, scenario.warning ? 1 : 0);
		if (scenario.warning) assert.match(warnings[0]!, /ROTOM_EVIDENCE_REDUCER must be 1 or 0/u);
	});
});
