/**
 * Tests must run on a clean checkout (review I3).
 *
 * The peer packages (`@earendil-works/pi-*`, `typebox`) belong to Pi, not to this
 * package: they are declared as peers and are not installed here. A static value
 * import in `src/` therefore makes the whole module graph unloadable under
 * `node --test`, which is exactly how `cu-v2-tools.test.ts` used to fail. Type-only
 * imports are erased by the loader and stay allowed; a lazy `import()` stays
 * allowed too, because it is only reached when the module actually needs Pi.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const peerPrefixes = ["@earendil-works/", "typebox"];

function sourceFiles(directory: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			out.push(...sourceFiles(full));
			continue;
		}
		if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) out.push(full);
	}
	return out;
}

test("no src module statically imports a peer package", () => {
	const offenders: string[] = [];
	for (const file of sourceFiles(sourceRoot)) {
		const text = readFileSync(file, "utf8");
		// `import type { … } from "…"` is erased by the type stripper; drop it first so
		// a multi-line type import cannot be mistaken for a runtime dependency.
		const withoutTypeImports = text.replace(/\bimport\s+type\b[\s\S]*?from\s+"[^"]*";/g, "");
		for (const peer of peerPrefixes) {
			if (new RegExp(`from\\s+"${peer.replace("/", "\\/")}`).test(withoutTypeImports)) {
				offenders.push(`${path.relative(sourceRoot, file)} imports ${peer}`);
			}
		}
	}
	assert.deepEqual(offenders, [], "these modules would fail to load without the peer package installed");
});
