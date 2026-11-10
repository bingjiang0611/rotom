#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Every hook this repository owns. A new hook must be linked here as well, otherwise a
// clone that already installed an older version silently keeps running without it.
const HOOKS = ["pre-commit", "pre-push"];

const root = git("rev-parse", "--show-toplevel");
const sources = new Map(HOOKS.map((name) => [name, join(root, ".githooks", name)]));
for (const [name, source] of sources) {
	if (!existsSync(source)) throw new Error(`Missing repository hook: ${source}`);
}
const destination = git(
	"rev-parse",
	"--path-format=absolute",
	"--git-path",
	"rotom-hooks",
);
const config = spawnSync(
	"git",
	["config", "--path", "--get", "core.hooksPath"],
	{ encoding: "utf8" },
);
if (config.error) throw config.error;
if (config.status !== 0 && config.status !== 1) throw new Error(config.stderr);
const configured = config.stdout.trim();
const previous = configured
	? isAbsolute(configured)
		? configured
		: resolve(root, configured)
	: git("rev-parse", "--path-format=absolute", "--git-path", "hooks");

/** A hook name already occupied by something that is not ours is the user's, so stop. */
function refuseOccupied(directory) {
	for (const name of HOOKS) {
		if (existsSync(join(directory, name))) {
			throw new Error(
				`Existing ${name} hook at ${directory}; integrate it explicitly before installing Rotom's hook.`,
			);
		}
	}
}

/** Point the hook name at this repository's copy without replacing a foreign hook. */
function link(name) {
	const source = sources.get(name);
	const target = join(destination, name);
	const installed = lstatSync(target, { throwIfNoEntry: false });
	if (!installed) {
		symlinkSync(source, target);
		return;
	}
	if (realpathSync(target) !== realpathSync(source)) {
		throw new Error(
			`Unexpected ${name} hook at ${destination}; refusing to replace it.`,
		);
	}
}

if (previous !== destination) {
	refuseOccupied(previous);
	// Do not replace global hooks or disable other hooks that are already installed.
	// Links retain their original executable and arguments. New upstream hooks
	// require reinstalling after restoring the previous core.hooksPath.
	if (!existsSync(destination)) mkdirSync(destination);
	if (existsSync(previous)) {
		for (const name of readdirSync(previous)) {
			const target = join(destination, name);
			if (!existsSync(target)) symlinkSync(join(previous, name), target);
		}
	}
	git("config", "--local", "core.hooksPath", destination);
}
for (const name of HOOKS) link(name);
console.log(
	`Rotom ${HOOKS.join(", ")} installed at ${destination}; existing hooks preserved.`,
);
