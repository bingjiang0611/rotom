import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_SCHEMA, runGate, type GateManifest } from "../src/loop/gate.ts";
import { preflightFailure, preflightGate } from "../src/loop/gate-preflight.ts";

const OLD_SOURCE = "1111111111111111111111111111111111111111111111111111111111111111";
const NEW_SOURCE = "65372ac421fa4bd87e2edf0b0acdcf725432f24f45d4945fa2aa2b2d40618cf5";
const REVISION = "4a080252f06caf63a525d7873c5d94d3c23887e0";

function write(path: string, body: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, body);
}

type ForkState = { version?: string; sourceSha256?: string };
type Options = {
	build?: { version: string; sourceSha256: string } | null;
	installedFork?: ForkState | null;
	thirdParty?: { locked: string; installed?: string | null };
};

/** A product directory shaped like a release: identity files plus installed packages. */
function product(root: string, options: Options = {}): string {
	const version = "0.1.27-main.abcdef12";
	const build = options.build === null ? undefined : (options.build ?? { version: "1.4.0-rotom.3", sourceSha256: NEW_SOURCE });
	const fork = options.installedFork === null ? undefined : (options.installedFork ?? { version: build?.version, sourceSha256: build?.sourceSha256 });
	write(join(root, "package.json"), JSON.stringify({ name: "@bingjiang0611/rotom", version }));
	write(join(root, "runtime", "resolve-installed-pi.mjs"), "export {};\n");
	if (build) {
		write(join(root, "runtime", "pi", "fork-build.json"), JSON.stringify({
			schema: "rotom-pi-fork/v1",
			version: build.version,
			upstreamRevision: REVISION,
			sourceSha256: build.sourceSha256,
			artifacts: { "@earendil-works/pi-coding-agent": { version: build.version, integrity: "sha512-x" } },
		}));
	}
	if (fork) {
		write(join(root, "runtime", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: fork.version,
			rotomFork: { sourceSha256: fork.sourceSha256, revision: REVISION },
		}));
	}
	const thirdParty = options.thirdParty ?? { locked: "2.15.0" };
	write(join(root, "extensions", "third-party", "package-lock.json"), JSON.stringify({
		lockfileVersion: 3,
		packages: { "": { dependencies: { "@juicesharp/rpiv-ask-user-question": thirdParty.locked } }, "node_modules/@juicesharp/rpiv-ask-user-question": { version: thirdParty.locked } },
	}));
	if (thirdParty.installed !== null) {
		write(join(root, "extensions", "third-party", "node_modules", "@juicesharp", "rpiv-ask-user-question", "package.json"), JSON.stringify({
			name: "@juicesharp/rpiv-ask-user-question",
			version: thirdParty.installed ?? thirdParty.locked,
		}));
	}
	return root;
}

function workspace(name: string) {
	return mkdtempSync(join(tmpdir(), `gate-preflight-${name}-`));
}

const manifest: GateManifest = {
	schema: GATE_SCHEMA,
	model: { provider: "qoder", model: "dfmodel" },
	repeats: 1,
	cases: [{
		suite: "cases/continuation-regression.eval.ts",
		caseId: "behavior-authorized-follow-through",
		role: "reproduced",
		enableEnv: "ROTOM_EVAL_CONTINUATION",
		caseEnv: "ROTOM_EVAL_CONTINUATION_CASE",
		repeatsEnv: "ROTOM_EVAL_CONTINUATION_REPEATS",
		ledger: "L-2026-11-02-follow-through-recheck",
	}],
};

describe("gate preflight", () => {
	it("passes when both products match their own lock and fork build", () => {
		const root = workspace("ok");
		const result = preflightGate([
			{ product: product(join(root, "baseline")), label: "baseline" },
			{ product: product(join(root, "candidate")), label: "candidate" },
		]);
		expect(result.problems).toEqual([]);
		expect(result.products.map((item) => `${item.label} ${item.version} ${item.fork}`)).toEqual([
			"baseline 0.1.27-main.abcdef12 1.4.0-rotom.3",
			"candidate 0.1.27-main.abcdef12 1.4.0-rotom.3",
		]);
	});

	it("refuses a candidate whose installed fork was built from the previous source", () => {
		// The case from round 6: the same declared version, old bytes already on disk.
		const root = workspace("old-archive");
		const candidate = product(join(root, "candidate"), { installedFork: { version: "1.4.0-rotom.3", sourceSha256: OLD_SOURCE } });
		const result = preflightGate([{ product: product(join(root, "baseline")), label: "baseline" }, { product: candidate, label: "candidate" }]);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]).toMatchObject({ label: "candidate", directory: "runtime/pi" });
		expect(result.problems[0]?.detail).toContain("111111111111");
		expect(result.problems[0]?.detail).toContain("65372ac421fa");
		const message = preflightFailure(result.problems);
		expect(message).toContain("refused before any model call");
		expect(message).toContain(join(candidate, "runtime/pi"));
	});

	it("refuses a product whose installed fork version is not the declared one", () => {
		const root = workspace("old-version");
		const result = preflightGate([{ product: product(join(root, "p"), { installedFork: { version: "1.4.0-rotom.2", sourceSha256: OLD_SOURCE } }), label: "baseline" }]);
		expect(result.problems[0]?.detail).toContain("installed @earendil-works/pi-coding-agent is 1.4.0-rotom.2");
	});

	it("refuses a product whose installed third-party package is older than its lock", () => {
		const root = workspace("third-party");
		const result = preflightGate([{ product: product(join(root, "candidate"), { thirdParty: { locked: "2.15.0", installed: "2.6.2" } }), label: "candidate" }]);
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]).toMatchObject({ label: "candidate", directory: "extensions/third-party" });
		expect(result.problems[0]?.detail).toContain("installed @juicesharp/rpiv-ask-user-question is 2.6.2, the lock pins 2.15.0");
	});

	it("refuses a product that is missing a package the lock pins", () => {
		const root = workspace("missing");
		const result = preflightGate([{ product: product(join(root, "p"), { installedFork: null }), label: "baseline" }]);
		expect(result.problems[0]?.detail).toContain("is not installed, so the runtime cannot start");
	});

	it("refuses a product with no fork build identity at all", () => {
		const root = workspace("no-build");
		const result = preflightGate([{ product: product(join(root, "p"), { build: null }), label: "baseline" }]);
		expect(result.problems[0]).toMatchObject({ directory: "runtime/pi" });
		expect(result.problems[0]?.detail).toContain("fork-build.json is missing");
	});

	it("stops the gate before the first eval process exists", () => {
		const root = workspace("no-spawn");
		const marker = join(root, "spawned");
		const evalsRoot = join(root, "evals");
		write(join(evalsRoot, "bin", "eval"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
		const candidate = product(join(root, "candidate"), { installedFork: { version: "1.4.0-rotom.3", sourceSha256: OLD_SOURCE } });
		expect(() => runGate({
			evalsRoot,
			manifest,
			baselineProduct: product(join(root, "baseline")),
			candidateProduct: candidate,
			outDir: join(root, "out"),
		})).toThrow(/refused before any model call/u);
		expect(existsSync(marker)).toBe(false);
	});
});
