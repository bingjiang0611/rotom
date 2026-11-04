#!/usr/bin/env node
/**
 * Broker daemon launcher that also works from inside `node_modules`.
 *
 * Node refuses to strip TypeScript types for files under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and the product installs this
 * package at `rotom/extensions/third-party/node_modules/@injaneity/pi-computer-use/`.
 * Spawning `daemon.ts` directly therefore fails in every installed copy. This
 * launcher stages the daemon's small source tree into a private directory outside
 * `node_modules` and runs it there, so one code path serves both a source checkout
 * and an installed package without a bundled transpiler.
 *
 * Plain JavaScript on purpose: this file itself must run from `node_modules`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const brokerDir = import.meta.dirname;
const srcRoot = path.dirname(brokerDir);

/** Only the daemon's own dependency closure; keep this list in sync with daemon.ts. */
const ENTRIES = ["broker", "policy", "trace", "config.ts", "runtime.ts"];

function collect(target, found = []) {
	const stats = statSync(target);
	if (stats.isDirectory()) {
		for (const name of readdirSync(target).sort()) {
			if (name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
			collect(path.join(target, name), found);
		}
		return found;
	}
	if (/\.(ts|mjs|js|json)$/.test(target)) found.push(target);
	return found;
}

function fingerprint(files) {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(srcRoot, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 16);
}

/** Stage the sources outside `node_modules` and return the staged entry path. */
function stage() {
	const files = ENTRIES.flatMap((entry) => collect(path.join(srcRoot, entry)));
	const fingerprintValue = fingerprint(files);
	const staged = path.join(os.tmpdir(), `rotom-cu-broker-stage-${fingerprintValue}`, "src");
	const marker = path.join(staged, ".complete");
	if (!existsSync(marker)) {
		for (const file of files) {
			const destination = path.join(staged, path.relative(srcRoot, file));
			mkdirSync(path.dirname(destination), { recursive: true });
			writeFileSync(destination, readFileSync(file));
		}
		writeFileSync(marker, `${files.length}\n`);
	}
	return path.join(staged, "broker", "daemon.ts");
}

const entry = stage();
await import(pathToFileURL(entry).href);
