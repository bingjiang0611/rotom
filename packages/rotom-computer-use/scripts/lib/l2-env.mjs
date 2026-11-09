/**
 * The two "is this environment what the frozen commit produced?" checks (review 8, T3).
 *
 * A frozen commit only constrains the repository. The helper in `~/cu-v2-test` and the
 * fixture bundle beside it are whatever was built last, and an old one of either wastes a
 * whole window: an old helper cannot report event sources (so B0's attribution row is empty),
 * and an old fixture still publishes `clicked`/`idle` (so every click judgement is
 * `inconclusive`). Both are diagnosed here, before anything is launched, and both are a
 * refusal - exit 2, no stop marker, because the step never started.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Written by `scripts/build-fixture.mjs`; not a plist key, so the bundle stays identical. */
export const FIXTURE_SOURCE_DIGEST_FILE = path.join("Contents", "Resources", "source.sha256");

export function sha256Hex(data) {
	return createHash("sha256").update(data).digest("hex");
}

/** The digest a built fixture app carries, or undefined when it carries none. */
export function fixtureSourceDigest(appPath) {
	try {
		return readFileSync(path.join(appPath, FIXTURE_SOURCE_DIGEST_FILE), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** The digest the frozen source must produce. */
export function expectedFixtureSourceDigest(rootDir) {
	return sha256Hex(readFileSync(path.join(rootDir, "native", "macos-fixture", "FixtureApp.swift")));
}

/** `codesign -dv` writes its report to stderr and exits 0 even for an ad-hoc signature. */
function codesignReport(appPath) {
	const done = spawnSync("codesign", ["-dv", "--verbose=2", appPath], { encoding: "utf8" });
	return `${done.stdout ?? ""}${done.stderr ?? ""}`;
}

/** What `codesign` says about a bundle, so signing cannot be assumed from the fact it ran. */
export function signatureOf(appPath, { exec = codesignReport } = {}) {
	let text = "";
	try {
		text = String(exec(appPath));
	} catch (error) {
		text = String(error?.stderr ?? "");
	}
	if (!text.includes("Signature")) return { adhoc: true, authority: undefined, note: "no embedded signature" };
	const adhoc = /flags=\S*\(adhoc\)/.test(text) || /Signature=adhoc/.test(text);
	return { adhoc, authority: /Authority=([^\n]+)/.exec(text)?.[1]?.trim() };
}

/**
 * A copy signed ad hoc is killed by amfid at exec (`AMFI ... -423`), so the run sees an app
 * that launches and then has no window - which is what one window spent its time on. The
 * identity has to be in the environment, because `codesign -s -` is the silent default.
 */
export function checkFixtureSignature({ appPath, identity, willCopy }) {
	if (!willCopy) return { ok: true };
	if (!identity) {
		return { ok: false, reason: "PI_CU_FIXTURE_SIGN_IDENTITY is unset, so the fixture copy would be ad-hoc signed and amfid would kill it at exec; export it and rebuild nothing" };
	}
	const source = signatureOf(appPath);
	if (source.adhoc) {
		return { ok: false, reason: `fixture ${appPath} is ad-hoc signed (${source.note ?? "Signature=adhoc"}); rebuild it with build-fixture.mjs --sign-identity` };
	}
	return { ok: true, authority: source.authority };
}

/** Refuse to drive a fixture built from other source than the checkout under test. */
export function checkFixture({ appPath, rootDir, identity, willCopy }) {
	const actual = fixtureSourceDigest(appPath);
	if (!actual) {
		return { ok: false, reason: `fixture ${appPath} carries no ${FIXTURE_SOURCE_DIGEST_FILE}; rebuild it with scripts/build-fixture.mjs --output <app>` };
	}
	const expected = expectedFixtureSourceDigest(rootDir);
	if (actual !== expected) {
		return { ok: false, reason: `fixture was built from other source (${actual.slice(0, 12)} != ${expected.slice(0, 12)}); rebuild it from this commit` };
	}
	const signature = checkFixtureSignature({ appPath, identity, willCopy });
	if (!signature.ok) return signature;
	return { ok: true, digest: expected };
}

/**
 * The helper must be able to answer the questions B0 exists to ask.
 *
 * `recentEventLimit` is the marker: the ring and its limit shipped together, so a helper that
 * reports one and not the other is not the build this checkout describes.
 */
export function checkHelperSupport({ activity, diagnostics, expectedProtocol }) {
	const protocol = diagnostics?.protocolVersion;
	if (protocol !== expectedProtocol) {
		return { ok: false, reason: `helper protocol ${protocol ?? "?"} != ${expectedProtocol}; rebuild it from this commit` };
	}
	if (!Array.isArray(diagnostics?.invariants) || !diagnostics.invariants.includes("background-delivery-no-cursor-warp")) {
		return { ok: false, reason: "helper does not report background-delivery-no-cursor-warp; rebuild it from this commit" };
	}
	if (!Number.isFinite(activity?.recentEventLimit)) {
		return { ok: false, reason: "helper does not report recentEventLimit, so it cannot attribute events; rebuild it from this commit" };
	}
	if (!Array.isArray(activity?.recentEvents)) {
		return { ok: false, reason: "helper does not report recentEvents, so it cannot attribute events; rebuild it from this commit" };
	}
	if (!Number.isFinite(activity?.agentHidEventCount)) {
		return { ok: false, reason: "helper does not report agentHidEventCount, so it cannot prove background delivery avoided HID; rebuild it from this commit" };
	}
	return { ok: true };
}
