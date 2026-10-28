// Freezing a failure set: synthetic sessions only, no model, no spawn.
//
// The decision this file protects is whether a person can trust the set: a changed
// session must be reported instead of silently re-anchored, and a stored set must not
// be editable without invalidating it.
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixtureSession } from "../../extensions/observability/eval-fixtures.mjs";
import { readAnnotations, writeAnnotation } from "../../extensions/observability/eval/annotations.mjs";
import { readReplayCases, replayCaseKey, writeReplayCase } from "../../extensions/observability/eval/replay.mjs";
import {
	armIdentity, buildRegressionSet, readRegressionSet, regressionSetDigest, regressionSetPath, resolveSetPath, selectReplayCases, sessionIndex, writeRegressionSet,
} from "../scripts/regression-set.mjs";
import { frozenSet, point, workspace } from "./regression-helpers.mjs";

test("selector picks saved points, and an explicit key list never silently shrinks", () => {
	const labels = new Map([["a", { verdict: "fail", failSet: true }], ["b", { verdict: "fail", failSet: false }], ["c", { verdict: "pass", failSet: false }]]);
	const cases = ["a", "b", "c"].map((sessionId) => ({ sessionId, key: `${sessionId}-x` }));
	assert.deepEqual(selectReplayCases(cases, labels, "all").map((item) => item.sessionId), ["a", "b", "c"]);
	assert.deepEqual(selectReplayCases(cases, labels, "fail").map((item) => item.sessionId), ["a", "b"]);
	assert.deepEqual(selectReplayCases(cases, labels, "failSet").map((item) => item.sessionId), ["a"]);
	assert.deepEqual(selectReplayCases(cases, labels, { cases: ["c"] }).map((item) => item.sessionId), ["c"]);
	assert.throws(() => selectReplayCases(cases, labels, { cases: ["gone"] }), /unknown_replay_point/u);
	assert.throws(() => selectReplayCases(cases, labels, "everything"), /invalid_selector/u);
});

test("freezing keeps valid points and reports every reason it dropped one", async () => {
	const { sessions, directory } = await workspace();
	const good = await point({ sessions, directory, id: "synthetic-good" });
	const passing = await point({ sessions, directory, id: "synthetic-pass", verdict: "pass", failSet: false });
	// A session edited after review must not be re-anchored behind the person's back.
	const edited = await point({ sessions, directory, id: "synthetic-edited" });
	await writeFile(edited.path, (await readFile(edited.path, "utf8")) + JSON.stringify({ type: "message", id: "entry-late", parentId: edited.pinnedId, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "补充一句" } }) + "\n");
	// A point whose session is gone is dropped with a reason, not counted as passing.
	await writeReplayCase(directory, { sessionId: "synthetic-missing", cutEntryId: "entry-9", expected: "存在但不可读", check: { mode: "model" } }, "a".repeat(64));

	const { set } = await frozenSet({ sessions, directory, selector: "all" });
	assert.equal(set.schema, "rotom-replay-set/v1");
	assert.deepEqual(set.cases.map((item) => replayCaseKey(item.sessionId, item.cutEntryId)).sort(), [
		replayCaseKey("synthetic-good", good.cutEntryId), replayCaseKey("synthetic-pass", passing.cutEntryId),
	].sort());
	assert.deepEqual(set.excluded.map((item) => item.reason).sort(), ["session_unreadable: session_not_indexed", "source_changed"]);
	assert.equal(set.scan.replayPoints, 4);
	assert.equal(set.scan.included, 2);
	assert.equal(set.scan.indexComplete, true);
	assert.equal(regressionSetDigest(set), set.digest);
});

test("a frozen set is private, cannot escape its directory, and rejects a tampered body", async () => {
	const { root, sessions, directory } = await workspace();
	await point({ sessions, directory });
	const { set } = await frozenSet({ sessions, directory });
	const saved = await writeRegressionSet(directory, set);
	assert.match(saved.path, /evals\/replay\/sets\/failures\.json$/u);
	const round = await readRegressionSet(directory, "failures");
	assert.equal(round.digest, set.digest);
	assert.equal(round.cases.length, 1);
	await assert.rejects(() => writeRegressionSet(directory, set), /set_exists/u);
	const refrozen = { ...set, repeats: 2 };
	await writeRegressionSet(directory, { ...refrozen, digest: regressionSetDigest(refrozen) }, { overwrite: true });

	// Changing what a run would do without changing the digest must fail closed.
	const tampered = JSON.parse(await readFile(saved.path, "utf8"));
	tampered.cases[0].expected = "改成另一条期望";
	await writeFile(saved.path, JSON.stringify(tampered) + "\n");
	await assert.rejects(() => readRegressionSet(directory, "failures"), /set_digest_mismatch/u);

	assert.throws(() => regressionSetPath(directory, "../escape"), /invalid_set_name/u);
	assert.throws(() => resolveSetPath(directory, join(root, "elsewhere.json")), /set_outside_private_storage/u);

	// A symlinked sets directory is never followed.
	const other = await workspace();
	await mkdir(join(other.directory, "replay"), { recursive: true });
	await symlink(join(directory, "replay", "sets"), join(other.directory, "replay", "sets"));
	const renamed = { ...set, name: "other" };
	await assert.rejects(() => writeRegressionSet(other.directory, { ...renamed, digest: regressionSetDigest(renamed) }), /Symlink/u);
});

test("session index finds nested sessions, drops an ambiguous id, and reports bounds", async () => {
	const { sessions } = await workspace();
	await fixtureSession(join(sessions, "project-a"), "index-one");
	await fixtureSession(join(sessions, "project-b"), "index-two");
	const index = await sessionIndex(sessions);
	assert.deepEqual([...index.paths.keys()].sort(), ["index-one", "index-two"]);
	assert.equal(index.complete, true);
	await fixtureSession(join(sessions, "project-b"), "index-one");
	const ambiguous = await sessionIndex(sessions);
	assert.equal(ambiguous.paths.has("index-one"), false);
	assert.deepEqual(ambiguous.duplicates, ["index-one"]);
	assert.equal((await sessionIndex(sessions, { maximum: 1 })).complete, false);
});

test("index resolution keeps sessions beyond the dashboard's newest-candidate window reachable", async () => {
	const { sessions, directory } = await workspace();
	// The dashboard lists only the newest 500 sessions. A frozen set must still find
	// an older point, so the index resolves by id and never trusts that cap.
	const target = await point({ sessions, directory, id: "synthetic-old" });
	for (let index = 0; index < 3; index++) await fixtureSession(join(sessions, "project-b"), `filler-${index}`);
	const index = await sessionIndex(sessions);
	assert(index.paths.has("synthetic-old"));
	const { set } = await frozenSet({ sessions, directory });
	assert.equal(set.cases.length, 1);
	assert.equal(set.cases[0].sessionId, "synthetic-old");
	assert.equal(set.cases[0].cutEntryId, target.cutEntryId);
	const labels = await readAnnotations(directory);
	assert.equal(labels.get("synthetic-old").verdict, "fail");
	assert.equal((await readReplayCases(directory)).length, 1);
});

test("a large session is still indexed, and duplicate ids stay ambiguous", async () => {
	const { sessions } = await workspace();
	const big = await fixtureSession(join(sessions, "project-a"), "index-big");
	// Long sessions are supported up to the product's own size boundary; a smaller
	// index-only cap would drop a usable point as "not indexed".
	await writeFile(big, (await readFile(big, "utf8")) + JSON.stringify({ type: "message", id: "entry-pad", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "补".repeat(400_000) } }) + "\n");
	const index = await sessionIndex(sessions);
	assert(index.paths.has("index-big"), "a multi-megabyte session must still resolve");
	// Three copies: the id must never become resolvable again after the second.
	for (const folder of ["project-b", "project-c"]) await fixtureSession(join(sessions, folder), "index-big");
	const third = await sessionIndex(sessions);
	assert.equal(third.paths.has("index-big"), false);
	assert.deepEqual(third.duplicates, ["index-big"]);
});

test("product identity follows content, not the path, and skips installed dependencies", async () => {
	const { root } = await workspace();
	const product = join(root, "product");
	await mkdir(join(product, "runtime", "pi", "node_modules", "huge"), { recursive: true });
	await writeFile(join(product, "runtime", "product-config.mjs"), "export default 1;\n");
	await writeFile(join(product, "runtime", "pi", "package.json"), "{}\n");
	await writeFile(join(product, "runtime", "pi", "node_modules", "huge", "dist.js"), "first");
	const initial = await armIdentity(product);
	assert(initial.files >= 2);
	// Installed dependencies are pinned by the lock/fork files, not re-hashed.
	await writeFile(join(product, "runtime", "pi", "node_modules", "huge", "dist.js"), "second");
	assert.equal((await armIdentity(product)).digest, initial.digest);
	// Editing a product file at the same path does change the identity.
	await writeFile(join(product, "runtime", "product-config.mjs"), "export default 2;\n");
	assert.notEqual((await armIdentity(product)).digest, initial.digest);
});
