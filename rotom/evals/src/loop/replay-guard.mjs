/**
 * The decision the replay guard extension makes. Plain JavaScript, imported by a generated
 * extension file and by the tests directly, so the rule that runs and the rule that is tested are
 * one function instead of a copy.
 */
import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Marker the transcript carries when the sandbox refuses a call; the runner scans for it. */
export const GUARD_MARKER = "replay-isolation: refused";

/** Tool names whose path arguments the guard checks. */
export const PATH_TOOLS = ["read", "edit", "write", "multiedit", "grep", "find", "ls"];

/** Input keys that carry a filesystem path for those tools. */
const PATH_KEYS = ["path", "paths", "file", "filePath", "files", "dir", "directory", "target"];

/** Every absolute path the arguments name. A relative path stays inside the workspace by definition. */
export function pathArguments(toolName, input) {
	if (!PATH_TOOLS.includes(toolName)) return [];
	const found = [];
	for (const key of PATH_KEYS) {
		const value = input[key];
		const list = Array.isArray(value) ? value : [value];
		for (const item of list) if (typeof item === "string" && item.startsWith("/")) found.push(item);
	}
	return found;
}

/** Resolve a path through every symlink, including for a file that does not exist yet. */
export function resolveReal(path) {
	let current = resolve(path);
	const rest = [];
	for (;;) {
		try {
			return join(realpathSync(current), ...rest.slice().reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			rest.push(current.slice(parent.length).replace(/^\/+/u, ""));
			current = parent;
		}
	}
}

/** The refusal text for a call that leaves the sandbox, or undefined when the call is inside it. */
export function decideFileAccess(toolName, input, roots) {
	const resolved = roots.map((root) => resolveReal(root));
	for (const named of pathArguments(toolName, input ?? {})) {
		const real = resolveReal(named);
		const inside = resolved.some((root) => real === root || real.startsWith(`${root}${sep}`));
		if (!inside) return `${GUARD_MARKER} ${toolName} ${real} (outside the replay sandbox)`;
	}
	return undefined;
}
