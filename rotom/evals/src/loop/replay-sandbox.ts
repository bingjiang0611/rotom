/**
 * The replay sandbox: a replay has to be able to read the incident's code without being able to
 * touch the machine it runs on. Two layers do that.
 *
 * File tools are checked by a generated extension that imports `replay-guard.mjs`: every absolute
 * path a `read`, `edit`, `write`, `grep`, `find` or `ls` call names is resolved through its real
 * path, so a symlink inside the copy cannot smuggle the host in, and anything outside the run
 * directory is refused with a marker the transcript records.
 *
 * Shell commands run under `sandbox-exec`, which denies writes outside the run directory and denies
 * the network. The product's own model requests leave from the product process, not from this
 * sandbox, so denying network access to tool children does not cut the run off.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { GUARD_MARKER, decideFileAccess, resolveReal } from "./replay-guard.mjs";

export { GUARD_MARKER, decideFileAccess, resolveReal };

/** Where the guard lives at run time: the same module the tests exercise. */
const GUARD_MODULE = resolve(import.meta.dirname, "replay-guard.mjs");

/** The sandbox profile: no network, and writes only where the run may write. */
export function sandboxProfile(base: string): string {
	const root = resolveReal(base);
	// Nothing outside the run is writable. TMPDIR points inside it, so a tool's temp files are covered.
	const writable = [root, "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/fd", "/dev/tty"].filter((path) => path === root || existsSync(path));
	return [
		"(version 1)",
		"(allow default)",
		"; Tool children must not reach the network; the product's own requests leave outside this sandbox.",
		"(deny network*)",
		"(deny file-write*)",
		"(allow file-write*",
		...writable.map((path) => `  (subpath "${path}")`),
		"; git shells out through xcrun, which caches its tool lookup in the Darwin temp dir, not TMPDIR.",
		'  (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db")',
		")",
		"",
	].join("\n");
}

/** The shell Pi runs tool commands with: the same bash, behind the sandbox. */
export function sandboxShell(profilePath: string): string {
	return ["#!/bin/bash", `exec /usr/bin/sandbox-exec -f "${profilePath}" /bin/bash "$@"`, ""].join("\n");
}

/** The generated guard extension: inline roots, one imported decision. */
export function guardExtensionSource(roots: readonly string[]): string {
	return [
		`import { decideFileAccess } from ${JSON.stringify(GUARD_MODULE)};`,
		`const ROOTS = ${JSON.stringify(roots.map((root) => resolveReal(root)))};`,
		"",
		"export default function (pi) {",
		'\tpi.on("tool_call", async (event) => {',
		"\t\tconst reason = decideFileAccess(event.toolName, event.input ?? {}, ROOTS);",
		"\t\treturn reason ? { block: true, reason } : undefined;",
		"\t});",
		"}",
		"",
	].join("\n");
}

/**
 * Install both layers into one run directory. Returns the environment additions the product needs:
 * its settings point the shell tool at the wrapper, and its extensions directory holds the guard.
 */
export async function installReplaySandbox(options: { base: string; home: string; agent: string; workspace: string }): Promise<{ env: Record<string, string> }> {
	const base = resolveReal(options.base);
	const profilePath = join(options.home, "sandbox.sbpl");
	const shellPath = join(options.home, "sandbox-shell");
	const tmp = join(options.base, "tmp");
	const extensions = join(options.agent, "extensions");
	await mkdir(tmp, { recursive: true, mode: 0o700 });
	await mkdir(extensions, { recursive: true, mode: 0o700 });
	await writeFile(profilePath, sandboxProfile(base), { mode: 0o600 });
	await writeFile(shellPath, sandboxShell(profilePath), { mode: 0o700 });
	await writeFile(join(extensions, "replay-isolation.ts"), guardExtensionSource([options.base, options.home, options.workspace]), { mode: 0o600 });
	// `shellPath` is how Pi names the shell it spawns for the bash tool; without it, /bin/bash wins.
	await writeFile(join(options.agent, "settings.json"), `${JSON.stringify({ shellPath }, null, 2)}\n`, { mode: 0o600 });
	return { env: { TMPDIR: tmp } };
}
