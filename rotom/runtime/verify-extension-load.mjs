/**
 * Load smoke for a packed release: import every built-in extension entry from the artifact and
 * report what the product's own extension loader says. Loading runs the extension factories, so a
 * module that a packed extension imports but that the package never shipped fails here, before the
 * artifact can reach an install. No provider request is made.
 *
 * Usage: node runtime/verify-extension-load.mjs --release <packed directory>
 */
import { realpathSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Every `extensions/<name>/index.ts` the artifact actually carries. */
export async function extensionEntries(release) {
	const directory = join(release, "extensions");
	const entries = [];
	for (const name of await readdir(directory)) {
		const entry = join(directory, name, "index.ts");
		const present = await access(entry).then(() => true, () => false);
		if (present) entries.push(entry);
	}
	return entries.sort();
}

/** The product's own loader, taken from the artifact under test rather than from the machine. */
export function loaderUrl(release) {
	return pathToFileURL(join(release, "runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")).href;
}

export async function verifyExtensionLoad(release) {
	const entries = await extensionEntries(release);
	if (entries.length === 0) throw new Error(`No extension entry found in ${join(release, "extensions")}`);
	const { loadExtensions } = await import(loaderUrl(release));
	const result = await loadExtensions(entries, release);
	const errors = (result.errors ?? []).map((item) => `${item.path}: ${item.error}`);
	if (errors.length) throw new Error(`Extension load failed:\n${errors.join("\n")}`);
	if (result.extensions.length !== entries.length) throw new Error(`Loaded ${result.extensions.length} of ${entries.length} extensions`);
	return { entries: entries.length, loaded: result.extensions.length };
}

/** True when this file is the script node was asked to run, through any symlinked path. */
function isEntryPoint() {
	if (!process.argv[1]) return false;
	const here = realpathSync(fileURLToPath(import.meta.url));
	const invoked = realpathSync(resolve(process.argv[1]));
	return here === invoked;
}

if (isEntryPoint()) {
	const index = process.argv.indexOf("--release");
	const release = index === -1 ? undefined : process.argv[index + 1];
	if (!release) {
		console.error("Usage: node runtime/verify-extension-load.mjs --release <packed directory>");
		process.exitCode = 2;
	} else {
		verifyExtensionLoad(resolve(release)).then(
			(result) => console.log(JSON.stringify(result)),
			(error) => {
				console.error(error.message);
				process.exitCode = 1;
			},
		);
	}
}
