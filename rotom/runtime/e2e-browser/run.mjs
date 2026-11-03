#!/usr/bin/env node

// E2E runner: node --experimental-strip-types rotom/runtime/e2e-browser/run.mjs [suite ...]
//
// Suites are registered in suites/index.mjs. Each suite gets a fresh isolated
// Chromium + native host + fixture site. Exit code is non-zero if any assertion
// failed or any suite threw.

import { createFixtureServer } from "./fixtures/server.mjs";
import { createRecorder, launchHarness, relayRequestFor, waitForRelay } from "./harness.mjs";
import { suites } from "./suites/index.mjs";

const selected = process.argv.slice(2);
const names = selected.length > 0 ? selected : Object.keys(suites);
const unknown = names.filter((name) => !suites[name]);
if (unknown.length > 0) throw new Error(`未知 suite：${unknown.join(", ")}；可用：${Object.keys(suites).join(", ")}`);

const startedAt = Date.now();
const summary = [];
for (const name of names) {
	const suite = suites[name];
	const recorder = createRecorder(name);
	let harness;
	let fixtures;
	process.stdout.write(`# suite ${name} — ${suite.description ?? ""}\n`);
	try {
		harness = await launchHarness();
		await waitForRelay(harness);
		fixtures = await createFixtureServer();
		await suite.run({
			harness,
			fixtures,
			recorder,
			relayRequestFor,
			connect: harness.connect,
		});
	} catch (error) {
		recorder.assert("suite 未抛出", false, error instanceof Error ? `${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}` : String(error));
		if (harness) {
			for (const result of harness.realHomeUntouched()) {
				recorder.assert(`真实 HOME 的 ${result.path} 未被改动`, !result.changed, result.changed ? "隔离契约被破坏：harness 动了操作者真实的产品目录" : undefined);
			}
		}
	} finally {
		if (recorder.failed > 0 && fixtures) {
			process.stdout.write(`# fixture 请求（最多 12 条）：${JSON.stringify(fixtures.requests.slice(-12).map((entry) => [entry.role, entry.method, entry.path]))}\n`);
		}
		await fixtures?.close().catch(() => undefined);
		await harness?.close().catch(() => undefined);
		if (harness && recorder.failed === 0) harness.discard();
		else if (harness) process.stdout.write(`# 保留失败现场：${harness.root}\n`);
	}
	const passed = recorder.results.filter((item) => item.ok).length;
	summary.push({ name, passed, failed: recorder.failed });
	process.stdout.write(`# suite ${name}: ${passed} passed, ${recorder.failed} failed\n`);
}

const failed = summary.reduce((total, item) => total + item.failed, 0);
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, wallTimeMs: Date.now() - startedAt, failed, suites: summary })}\n`);
process.exitCode = failed === 0 ? 0 : 1;
