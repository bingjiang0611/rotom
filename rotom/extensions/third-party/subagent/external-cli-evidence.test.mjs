import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VERIFIED_THIRD_PARTY_PACKAGES } from "../../../runtime/product-config.mjs";

// Independent regression, not a relaxed replacement for upstream's 2-second marker test.
// Only this fixture's external Node writer is in scope; no arbitrary descendant guarantee.
for (const scenario of ["complete", "stop-direct", "stop-residual"]) test(`exact package external CLI evidence: ${scenario}`, { timeout: 45000 }, (t) => {
	const source = path.resolve(import.meta.dirname, "../node_modules/pi-subagents");
	assert.equal(JSON.parse(fs.readFileSync(path.join(source, "package.json"))).version, VERIFIED_THIRD_PARTY_PACKAGES["pi-subagents"].version);
	assert.ok(process.env.ROTOM_PI, "pin ROTOM_PI to a real Pi executable");
	let piRoot = path.dirname(fs.realpathSync(process.env.ROTOM_PI));
	for (;;) {
		const pkg = path.join(piRoot, "package.json");
		if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg)).name === "@earendil-works/pi-coding-agent") break;
		const parent = path.dirname(piRoot); assert.notEqual(parent, piRoot); piRoot = parent;
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json")));
	const piEntry = path.resolve(piRoot, pkg.exports["."].import);
	assert.ok(fs.existsSync(piEntry));
	const driver = path.join(import.meta.dirname, "../fixtures/subagent-external-cli-evidence.mjs"); assert.ok(fs.existsSync(driver));
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-external-evidence-"));
	const home = path.join(root, "home"); fs.mkdirSync(home);
	const config = path.join(root, "config.json"); fs.writeFileSync(config, JSON.stringify({ source, piEntry, root, scenario, declaredProduct: true }), { mode: 0o600 });
	const fd = fs.openSync(path.join(root, "driver.log"), "wx", 0o600);
	let processResult;
	try {
		processResult = spawnSync(process.execPath, [driver], {
			cwd: root, timeout: 35000, stdio: ["ignore", fd, fd],
			env: { PATH: process.env.PATH, HOME: home, TMPDIR: root,
				NODE_PATH: path.join(piRoot, "node_modules"), PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: piRoot,
				PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), PI_SUBAGENTS_TEMP_ROOT: path.join(root, "runtime"),
				GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ROTOM_EXTERNAL_FIXTURE: config },
		});
	} finally { fs.closeSync(fd); }
	const resultPath = path.join(root, "result.json");
	if (processResult.error || processResult.status !== 0 || !fs.existsSync(resultPath)) {
		t.diagnostic(`Fixture retained (closure unproven): ${root}`);
		assert.fail(`external evidence fixture failed: exit=${processResult.status}; error=${processResult.error?.code ?? "none"}`);
	}
	const result = JSON.parse(fs.readFileSync(resultPath));
	assert.deepEqual(result, { parentStateBeforeRelease: "complete", childStateBeforeRelease: "running", markerBeforeRelease: false,
		childStateAfterRelease: scenario === "complete" ? "complete" : "stopped", externalExitCode: scenario === "complete" ? 0 : null,
		directRunnerClose: "unknown", scopedFixtureClosed: true, modelCalls: 0,
		ownedGroupClosure: "observed", externalDirectClose: true,
		...(scenario === "complete" ? {} : { scenario, residualWriteAfterRunnerClose: false }) });
	t.diagnostic(JSON.stringify(result));
	fs.rmSync(root, { recursive: true, force: true });
});
