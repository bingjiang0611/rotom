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
 * The staging directory is not a scratch space anyone may write to: it is inside
 * the broker's own private root (`$ROTOM_CU_BROKER_SOCKET`'s directory, 0700,
 * symlinks rejected), replaced atomically by rename, and every import re-checks
 * the staged bytes against the source fingerprint. A predictable directory name
 * must not be enough for another user to get code executed here.
 *
 * Plain JavaScript on purpose: this file itself must run from `node_modules`.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function hashFiles(root, files) {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(root, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex").slice(0, 16);
}

function assertNotSymlink(target) {
	if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
		throw new Error(`${target} is a symlink; refusing to stage broker sources through it.`);
	}
}

/** Create a 0700 directory, mirroring `ensurePrivateDir` without importing it. */
function ensurePrivateDir(dir) {
	assertNotSymlink(dir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stats = lstatSync(dir);
	if (!stats.isDirectory()) throw new Error(`${dir} is not a directory.`);
	if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** The broker's private root: the socket's directory, so tests isolate it too. */
function privateRoot(environment) {
	const configured = environment.ROTOM_CU_BROKER_SOCKET?.trim();
	const socketPath = configured ? path.resolve(configured) : path.join(os.homedir(), "Library", "Caches", "rotom-computer-use", "broker.sock");
	return path.dirname(socketPath);
}

/**
 * Whether a staged copy still matches the sources it came from. Recomputed from
 * the staged bytes, so a file edited after staging is detected before import.
 */
function stagedIsIntact(stagedRoot, relativeFiles, expectedFingerprint) {
	try {
		for (const relative of relativeFiles) {
			const staged = path.join(stagedRoot, relative);
			assertNotSymlink(staged);
			if (!existsSync(staged) || !statSync(staged).isFile()) return false;
		}
		return hashFiles(stagedRoot, relativeFiles.map((relative) => path.join(stagedRoot, relative))) === expectedFingerprint;
	} catch {
		return false;
	}
}

/**
 * Stage the daemon sources under the broker's private root and return the staged
 * entry path plus the directory that was used.
 */
/** Write the sources beside the final name; never importable while incomplete. */
function writeStagedCopy(stagingRoot, relativeFiles) {
	const temporary = path.join(stagingRoot, `.tmp-${process.pid}-${Date.now().toString(36)}`);
	rmSync(temporary, { recursive: true, force: true });
	mkdirSync(temporary, { recursive: true, mode: 0o700 });
	for (const relative of relativeFiles) {
		const destination = path.join(temporary, relative);
		mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
		writeFileSync(destination, readFileSync(path.join(srcRoot, relative)));
	}
	return temporary;
}

/**
 * One attempt at making `stagedRoot` a verified copy.
 *
 * A verified tree is never touched: another process may be importing from it right
 * now, and removing it takes that process down. A tree that fails verification is
 * moved aside (never deleted in place), and if it turns out to have been valid
 * after all — because a peer staged it between our check and our rename — it is put
 * back and used.
 */
function ensureStaged(stagedRoot, stagingRoot, relativeFiles, fingerprint) {
	if (stagedIsIntact(stagedRoot, relativeFiles, fingerprint)) return;
	const temporary = writeStagedCopy(stagingRoot, relativeFiles);
	// Re-check after writing ours: a peer may have staged a valid copy meanwhile.
	if (stagedIsIntact(stagedRoot, relativeFiles, fingerprint)) {
		rmSync(temporary, { recursive: true, force: true });
		return;
	}
	if (existsSync(stagedRoot)) {
		const discard = path.join(stagingRoot, `.discard-${process.pid}-${Date.now().toString(36)}-${fingerprint}`);
		let moved = false;
		try {
			renameSync(stagedRoot, discard);
			moved = true;
		} catch {
			// A peer moved it first; the rename below decides who wins.
		}
		if (moved && stagedIsIntact(discard, relativeFiles, fingerprint)) {
			try {
				renameSync(discard, stagedRoot);
			} catch {
				// Someone else already put a copy in place; fall through to verify it.
			}
			if (stagedIsIntact(stagedRoot, relativeFiles, fingerprint)) {
				rmSync(temporary, { recursive: true, force: true });
				return;
			}
		}
	}
	try {
		renameSync(temporary, stagedRoot);
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		if (!stagedIsIntact(stagedRoot, relativeFiles, fingerprint)) throw error;
	}
}

export function stageDaemonSources(environment = process.env) {
	const files = ENTRIES.flatMap((entry) => collect(path.join(srcRoot, entry)));
	const relativeFiles = files.map((file) => path.relative(srcRoot, file));
	const fingerprint = hashFiles(srcRoot, files);
	const root = privateRoot(environment);
	const stagingRoot = path.join(root, "stage");
	ensurePrivateDir(root);
	ensurePrivateDir(stagingRoot);

	const stagedRoot = path.join(stagingRoot, fingerprint);
	// Concurrent launchers converge on one directory. A peer can move a copy aside
	// while this process reads it, so a failed verification is retried rather than
	// reported: the retry sees the converged state and stops.
	for (let attempt = 0; attempt < 3; attempt += 1) {
		ensureStaged(stagedRoot, stagingRoot, relativeFiles, fingerprint);
		if (stagedIsIntact(stagedRoot, relativeFiles, fingerprint)) {
			return { entry: path.join(stagedRoot, "broker", "daemon.ts"), stagedRoot, fingerprint };
		}
	}
	throw new Error(`Staged broker sources in ${stagedRoot} do not match the installed package; refusing to run them.`);
}

/** Compare real paths: `/tmp` and `/var` are symlinks on macOS. */
function invokedDirectly() {
	const candidate = process.argv[1];
	if (!candidate) return false;
	try {
		return realpathSync(candidate) === realpathSync(import.meta.filename);
	} catch {
		return false;
	}
}


if (invokedDirectly()) {
	const { entry } = stageDaemonSources();
	await import(pathToFileURL(entry).href);
}
