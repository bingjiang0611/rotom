// Failure set → local regression set.
//
// A regression set freezes the replay points a person already reviewed, so a newer
// agent build can be checked against the build it is meant to replace. Freezing is
// the point: a session that changed after review is reported as invalid instead of
// being silently re-anchored, and a run names the exact set, models and products it
// compared.
//
// This module is pure local logic: it reads private eval storage, never calls a
// model, and knows nothing about the CLI. The product's npm package deliberately
// excludes `evals/`, so nothing here is a runtime resource.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { assertPrivatePath, readAnnotations, readPrivate, validSessionId } from "../../extensions/observability/eval/annotations.mjs";
import { replayRoot, REPLAY_JUDGE_PROMPT_VERSION, REPLAY_SESSION_MAX_BYTES, readReplayCases, replayCaseInput, replayCaseKey, replaySource } from "../../extensions/observability/eval/replay.mjs";
import { privateWrite, readBounded, statIfPresent } from "../../extensions/observability/eval/session-data.mjs";
import { clampRepeats } from "../../extensions/observability/eval/replay-plan.mjs";

export const REGRESSION_SET_SCHEMA = "rotom-replay-set/v1";
export const REGRESSION_REPORT_SCHEMA = "rotom-replay-report/v1";
export const SELECTORS = ["all", "fail", "failSet"];
const MAX_SET_BYTES = 1_048_576;
const MAX_INDEX_ENTRIES = 20_000;
const MAX_IDENTITY_FILES = 50_000;
const MAX_IDENTITY_BYTES = 256 * 1024 * 1024;
/**
 * Installed dependencies are pinned by the lock/fork files the identity hashes, and
 * `evals/` is not part of the product surface (the release manifest excludes it).
 */
const IDENTITY_SKIPPED = new Set(["node_modules", ".git", "evals"]);

export function setsDir(directory) { return join(replayRoot(directory), "sets"); }
export function reportsDir(directory) { return join(replayRoot(directory), "reports"); }

function validName(name) { return typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(name); }

/** The set path is always inside the private sets directory; a name cannot escape it. */
export function regressionSetPath(directory, name) {
	if (!validName(name)) throw new Error("invalid_set_name");
	return join(setsDir(directory), `${name}.json`);
}

/** Resolve `--set`: a name under the sets directory, or an absolute file inside it. */
export function resolveSetPath(directory, value) {
	if (validName(value)) return regressionSetPath(directory, value);
	const root = resolve(setsDir(directory)) + sep, path = resolve(value ?? "");
	if (!path.startsWith(root)) throw new Error("set_outside_private_storage");
	return path;
}

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value ?? null);
}

export function regressionSetDigest(set) {
	return createHash("sha256").update(canonical({ schema: set?.schema, name: set?.name, selector: set?.selector, repeats: set?.repeats, judgePromptVersion: set?.judgePromptVersion, cases: set?.cases, excluded: set?.excluded, scan: set?.scan })).digest("hex");
}

/** Which saved replay points belong in the set. Explicit keys win over a selector. */
export function selectReplayCases(cases, labels, selector = "all") {
	if (Array.isArray(selector?.cases)) {
		const wanted = selector.cases.map(String);
		const missing = wanted.filter((key) => !cases.some((item) => item.key === key || item.sessionId === key));
		// A point that was deleted must fail loudly: dropping it would shrink the set
		// behind the person's back.
		if (missing.length) throw new Error(`unknown_replay_point: ${missing.join(",")}`);
		return cases.filter((item) => wanted.includes(item.key) || wanted.includes(item.sessionId));
	}
	const kind = selector?.kind ?? selector ?? "all";
	if (!SELECTORS.includes(kind) || typeof kind !== "string") throw new Error("invalid_selector");
	if (kind === "all") return [...cases];
	return cases.filter((item) => labels.get(item.sessionId)?.verdict === "fail" && (kind === "fail" || labels.get(item.sessionId)?.failSet === true));
}

/**
 * Freeze the selected points. Every point is re-read here: its session must still
 * hash to the recorded digest and still contain the pinned assistant message, so a
 * set never claims a cut the session no longer has.
 */
export async function buildRegressionSet({ directory, name, selector = "all", repeats = 1, resolveSource, labels, cases, indexComplete = true, now = () => new Date() }) {
	if (!validName(name)) throw new Error("invalid_set_name");
	const saved = cases ?? await readReplayCases(directory);
	const annotations = labels ?? await readAnnotations(directory);
	const selected = selectReplayCases(saved, annotations, selector);
	const included = [], excluded = [], seen = new Set();
	for (const item of selected) {
		if (seen.has(item.key)) { excluded.push({ key: item.key, sessionId: item.sessionId, cutEntryId: item.cutEntryId, reason: "duplicate_point" }); continue; }
		seen.add(item.key);
		const value = replayCaseInput({ sessionId: item.sessionId, cutEntryId: item.cutEntryId, expected: item.expected, check: item.check });
		let source;
		try { source = await resolveSource(item); }
		catch (error) { excluded.push({ key: item.key, sessionId: item.sessionId, cutEntryId: item.cutEntryId, reason: `session_unreadable: ${message(error)}` }); continue; }
		const frozen = replaySource({ branch: source.branch, sessionContent: source.content, expectedSha256: item.sessionSha256, cutEntryId: item.cutEntryId });
		if (frozen.status !== "ready") { excluded.push({ key: item.key, sessionId: item.sessionId, cutEntryId: item.cutEntryId, reason: frozen.reason }); continue; }
		included.push({
			key: item.key, sessionId: value.sessionId, cutEntryId: value.cutEntryId, sessionSha256: item.sessionSha256,
			expected: value.expected, check: value.check,
			judgePromptVersion: value.check.mode === "model" ? REPLAY_JUDGE_PROMPT_VERSION : null,
		});
	}
	const scan = { replayPoints: saved.length, selected: selected.length, included: included.length, excluded: excluded.length, indexComplete: indexComplete === true };
	const set = {
		schema: REGRESSION_SET_SCHEMA, name, createdAt: now().toISOString(), selector: Array.isArray(selector?.cases) ? { cases: selector.cases.map(String) } : { kind: selector?.kind ?? selector ?? "all" },
		repeats: clampRepeats(repeats), judgePromptVersion: REPLAY_JUDGE_PROMPT_VERSION, cases: included, excluded, scan,
	};
	return { ...set, digest: regressionSetDigest(set) };
}

export async function ensurePrivateFolder(folder) {
	await assertPrivatePath(folder);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	await assertPrivatePath(folder);
	await chmod(folder, 0o700);
}

/**
 * Content identity of one product directory.
 *
 * A path is not a build: editing the candidate in place would otherwise leave a
 * confirmed plan valid. Everything under the directory is hashed except installed
 * `node_modules`, whose exact versions are already pinned by the `package-lock.json`
 * and `fork-build.json` files this digest also covers. Refuse rather than degrade if
 * the tree is too large to hash honestly.
 */
export async function armIdentity(path) {
	const root = resolve(path);
	const files = [];
	let bytes = 0;
	const walk = async (folder) => {
		for (const entry of await readdir(folder, { withFileTypes: true })) {
			const target = join(folder, entry.name);
			// A link is hashed as "path → target": it cannot change silently, and the
			// installed tree's links do not make the whole arm unhashable.
			if (entry.isSymbolicLink()) {
				files.push({ path: relative(root, target), link: await readlink(target) });
				if (files.length > MAX_IDENTITY_FILES) throw new Error("identity_too_large");
				continue;
			}
			if (entry.isDirectory()) { if (!IDENTITY_SKIPPED.has(entry.name)) await walk(target); continue; }
			if (!entry.isFile()) continue;
			const info = await statIfPresent(target);
			if (!info) continue;
			bytes += info.size;
			files.push({ path: relative(root, target), size: info.size });
			if (files.length > MAX_IDENTITY_FILES || bytes > MAX_IDENTITY_BYTES) throw new Error("identity_too_large");
		}
	};
	// A `--extension` argument names a single file, not a tree.
	const info = await statIfPresent(root);
	if (info?.isFile()) {
		if (info.size > MAX_IDENTITY_BYTES) throw new Error("identity_too_large");
		const digest = createHash("sha256").update(await readFile(root)).digest("hex");
		return { path: root, digest, files: 1 };
	}
	if (!info?.isDirectory()) throw new Error("identity_not_a_file_or_directory");
	await walk(root);
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const digest = createHash("sha256");
	for (const file of files) {
		if (file.link !== undefined) { digest.update(`${file.path}\0link\0${file.link}\0`); continue; }
		digest.update(`${file.path}\0${file.size}\0`);
		digest.update(await readFile(join(root, file.path)));
	}
	return { path: root, digest: digest.digest("hex"), files: files.length };
}

/** Write the set; an existing set is only replaced when the caller says so. */
export async function writeRegressionSet(directory, set, { overwrite = false } = {}) {
	const expected = regressionSetDigest(set);
	if (expected !== set.digest) throw new Error("set_digest_mismatch");
	const path = regressionSetPath(directory, set.name);
	await ensurePrivateFolder(setsDir(directory));
	await assertPrivatePath(path);
	if (!overwrite && await statIfPresent(path)) throw new Error("set_exists");
	await privateWrite(path, JSON.stringify(set) + "\n");
	return { ...set, path };
}

export async function readRegressionSet(directory, value) {
	const path = resolveSetPath(directory, value);
	await assertPrivatePath(path);
	const info = await statIfPresent(path);
	if (!info?.isFile()) throw new Error("set_not_found");
	const row = JSON.parse(await readPrivate(path, MAX_SET_BYTES));
	if (row.schema !== REGRESSION_SET_SCHEMA || !validName(row.name) || !Array.isArray(row.cases) || !Array.isArray(row.excluded)) throw new Error("invalid_set");
	// The digest covers exactly the fields a run depends on, so an edited set is
	// rejected instead of quietly changing what gets replayed.
	if (regressionSetDigest(row) !== row.digest) throw new Error("set_digest_mismatch");
	const seen = new Set();
	for (const item of row.cases) {
		const value = replayCaseInput({ sessionId: item.sessionId, cutEntryId: item.cutEntryId, expected: item.expected, check: item.check });
		if (replayCaseKey(value.sessionId, value.cutEntryId) !== item.key) throw new Error("invalid_set");
		if (!/^[0-9a-f]{64}$/u.test(item.sessionSha256) || seen.has(item.key)) throw new Error("invalid_set");
		seen.add(item.key);
	}
	return { ...row, path };
}

function message(error) { return error instanceof Error ? error.message : String(error); }

/**
 * Index every session header under the root. The dashboard's list caps its newest
 * candidates, which can hide an older session a replay point refers to; resolving by
 * id here keeps "the set is complete" honest.
 */
export async function sessionIndex(root, { maximum = MAX_INDEX_ENTRIES } = {}) {
	const paths = new Map(), duplicates = [], ambiguous = new Set();
	let files = 0, truncated = false;
	await assertPrivatePath(root);
	const walk = async (folder) => {
		for (const entry of await readdir(folder, { withFileTypes: true })) {
			if (truncated) return;
			if (entry.isSymbolicLink()) continue;
			const path = join(folder, entry.name);
			if (entry.isDirectory()) { if (entry.name !== "observability") await walk(path); continue; }
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			if (++files > maximum) { truncated = true; return; }
			let header;
			// Header-only, at the session size the rest of the product already supports:
			// a 1 MiB cap here would drop valid long sessions as "not indexed".
			try { header = (await readBounded(path, REPLAY_SESSION_MAX_BYTES, true)).firstRecord; } catch { continue; }
			const id = header?.type === "session" ? header.id : undefined;
			if (!validSessionId(id)) continue;
			// Ambiguity is permanent: a third copy must not make the id resolvable again.
			if (ambiguous.has(id)) continue;
			if (paths.has(id)) { ambiguous.add(id); duplicates.push(id); paths.delete(id); continue; }
			paths.set(id, path);
		}
	};
	await walk(root);
	return { paths, files, duplicates, complete: !truncated };
}

/** Read one session for a frozen point, using the index instead of guessing a path. */
export function sourceReader(index) {
	return async (item) => {
		const path = index.paths.get(item.sessionId);
		if (!path) throw new Error("session_not_indexed");
		const { readFile } = await import("node:fs/promises");
		const { loadSession } = await import("../../extensions/observability/eval/session-data.mjs");
		const loaded = await loadSession(path, { badJson: 0, lineTooLong: 0 }, new Set(), REPLAY_SESSION_MAX_BYTES);
		if (loaded.reason || !loaded.branch) throw new Error(`cannot_read_session: ${loaded.reason ?? "no_branch"}`);
		return { branch: loaded.branch, content: await readFile(path, "utf8") };
	};
}
