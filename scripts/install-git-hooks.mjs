#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// Every hook this repository owns. A new hook must be listed here as well, otherwise a
// clone that already installed an older version silently keeps running without it.
const HOOKS = ["pre-commit", "commit-msg", "pre-push"];
/** Written into every installed hook, so a later install can tell a copy from a foreign hook. */
const MARKER = "# rotom-hook-copy";

const root = git("rev-parse", "--show-toplevel");
// A repository with no commit yet cannot name one; the header then says so instead of failing.
const commit = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).stdout.trim() || "unborn";
const destination = git("rev-parse", "--path-format=absolute", "--git-path", "rotom-hooks");

/**
 * The hook body is read from the worktree that runs this installer and copied, never linked.
 *
 * A link would make the hook's behaviour depend on whichever checkout it points at: another
 * session's worktree, a branch that has since moved, or a tree this repository does not
 * control. A link in place of the repository hook is refused for the same reason.
 */
function readSource(name) {
	const path = join(root, ".githooks", name);
	const info = lstatSync(path, { throwIfNoEntry: false });
	if (!info) throw new Error(`Missing repository hook: ${path}`);
	if (info.isSymbolicLink()) throw new Error(`Repository hook is a symlink, not a regular file: ${path}`);
	if (!info.isFile()) throw new Error(`Repository hook is not a regular file: ${path}`);
	return readFileSync(path, "utf8");
}

/** Header names the source commit; a repository hook without a shebang is a hard error. */
function withHeader(name, body) {
	const [shebang, ...rest] = body.split("\n");
	if (!shebang.startsWith("#!")) throw new Error(`Repository hook ${name} has no shebang line`);
	return [
		shebang,
		`${MARKER} from ${root}/.githooks/${name} at commit ${commit}; edit that file and reinstall, not this copy.`,
		// Hook scripts under .git run from the pushing worktree, so relative scripts/ paths stay
		// tied to the tree being pushed rather than to the copy's location.
		`cd "$(git rev-parse --show-toplevel)"`,
		...rest,
	].join("\n");
}

function isOwnCopy(path) {
	try {
		return readFileSync(path, "utf8").includes(MARKER);
	} catch {
		return false;
	}
}

/**
 * The previous scheme linked into `<worktree>/.githooks/<name>`. Such a link is ours to replace;
 * any other file or link is the user's and is left alone. A link is never followed or trusted as
 * an installed hook: it only decides whether replacing it is allowed.
 */
function isObsoleteLink(path, name) {
	if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
	try {
		return realpathSync(path).endsWith(`/.githooks/${name}`);
	} catch {
		// A dangling link is the old scheme after its worktree moved; nothing else could be meant.
		return resolve(destination, readlinkSync(path)).includes(`/.githooks/${name}`);
	}
}

/** A hook name already occupied by something that is not ours is the user's, so stop. */
function refuseOccupied(directory) {
	for (const name of HOOKS) {
		const path = join(directory, name);
		if (lstatSync(path, { throwIfNoEntry: false })) {
			throw new Error(`Existing ${name} hook at ${directory}; integrate it explicitly before installing Rotom's hook.`);
		}
	}
}

const config = spawnSync("git", ["config", "--path", "--get", "core.hooksPath"], { encoding: "utf8" });
if (config.error) throw config.error;
if (config.status !== 0 && config.status !== 1) throw new Error(config.stderr);
const configured = config.stdout.trim();
const previous = configured ? (isAbsolute(configured) ? configured : resolve(root, configured)) : git("rev-parse", "--path-format=absolute", "--git-path", "hooks");

/** Git reports /private/var where the shell says /var; compare the directories, not the spellings. */
function sameDirectory(left, right) {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return left === right;
	}
}

// Two phases: every check runs before the first write, so a refused install leaves the
// repository exactly as it was, with no half-copied hook set left behind.
const bodies = new Map(HOOKS.map((name) => [name, withHeader(name, readSource(name))]));
const occupied = !sameDirectory(previous, destination);
if (occupied) refuseOccupied(previous);
for (const name of HOOKS) {
	const target = join(destination, name);
	const existing = lstatSync(target, { throwIfNoEntry: false });
	if (existing && !isOwnCopy(target) && !isObsoleteLink(target, name)) throw new Error(`Unexpected ${name} hook at ${target}; refusing to replace it.`);
}

if (!existsSync(destination)) mkdirSync(destination, { recursive: true });
if (occupied) {
	// Do not replace global hooks or disable other hooks that are already installed. New upstream
	// hooks require reinstalling after restoring the previous core.hooksPath.
	if (existsSync(previous)) {
		for (const name of readdirSync(previous)) {
			const target = join(destination, name);
			if (!existsSync(target)) symlinkSync(join(previous, name), target);
		}
	}
	git("config", "--local", "core.hooksPath", destination);
}

for (const name of HOOKS) {
	const target = join(destination, name);
	// Same directory, different name, so the rename is atomic and the file is never half written.
	const staged = `${target}.install`;
	writeFileSync(staged, bodies.get(name), { mode: 0o755 });
	chmodSync(staged, 0o755);
	renameSync(staged, target);
	if (lstatSync(target).isSymbolicLink()) throw new Error(`Installed ${name} is still a link: ${target}`);
}
console.log(`Rotom ${HOOKS.join(", ")} installed as copies at ${destination} from ${root}@${commit}; existing hooks preserved.`);
