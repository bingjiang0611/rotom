/**
 * Fixture runs for the real-machine scripts (A8).
 *
 * LaunchServices keys an app by its bundle identity: launching "the same" copy from
 * a second path can attach to the already-running instance (`-10825`), which would
 * mean a script that believes it started its own process is actually operating the
 * operator's. Every run therefore copies the fixture to a fresh directory, gives it
 * a new bundle id (`com.example.cu-fixture.<timestamp>`), re-signs the copy, and
 * deletes it afterwards.
 *
 * Signing an ad-hoc copy is not enough on machines where amfid refuses ad-hoc apps:
 * `open` then fails with `RBSRequestErrorDomain Code=5` / `launchd job spawn failed`
 * and the run never reaches an action (observed 2026-11-06). Set
 * `PI_CU_FIXTURE_SIGN_IDENTITY` to a real code-signing identity in that case; the
 * ad-hoc signature stays the default because most machines have no such identity.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FIXTURE_BUNDLE_PREFIX = "com.example.cu-fixture.";

/** True for a bundle id this repository's fixture runs produce. */
export function isFixtureBundleId(bundleId, prefix = FIXTURE_BUNDLE_PREFIX) {
	return typeof bundleId === "string" && bundleId.startsWith(prefix);
}

function readBundleId(infoPlistPath) {
	const xml = readFileSync(infoPlistPath, "utf8");
	return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1];
}

/**
 * Copy, re-identify and re-sign a fixture app.
 *
 * Throws when the bundle id could not be changed: a copy that still claims the
 * original identity is exactly the `-10825` trap this exists to avoid.
 */
export function prepareFixtureRun({
	sourceApp,
	runRoot,
	stamp = String(Date.now()),
	sign = true,
	identity = process.env.PI_CU_FIXTURE_SIGN_IDENTITY,
}) {
	if (!existsSync(sourceApp)) throw new Error(`fixture not found: ${sourceApp}`);
	const bundleId = `${FIXTURE_BUNDLE_PREFIX}${stamp}`;
	const dir = path.join(runRoot, `fixture-${stamp}`);
	mkdirSync(dir, { recursive: true });
	const bundlePath = path.join(dir, path.basename(sourceApp));
	cpSync(sourceApp, bundlePath, { recursive: true, verbatimSymlinks: true });

	const infoPlist = path.join(bundlePath, "Contents", "Info.plist");
	const xml = readFileSync(infoPlist, "utf8");
	const replaced = xml.replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${bundleId}$2`);
	if (replaced === xml) throw new Error(`could not rewrite CFBundleIdentifier in ${infoPlist}`);
	writeFileSync(infoPlist, replaced);
	if (readBundleId(infoPlist) !== bundleId) throw new Error(`bundle id rewrite did not stick: ${readBundleId(infoPlist)}`);

	// Re-signing is what makes the new bundle identity real; an unsigned copy is killed
	// by the OS. `identity` is used when the machine refuses ad-hoc signatures.
	if (sign) {
		execFileSync("codesign", ["--force", "--deep", "--sign", identity || "-", bundlePath], { stdio: "pipe" });
	}
	return { bundlePath, bundleId, dir, sourceApp };
}

/**
 * Quit every process of the run's own bundle id, then delete the copy.
 *
 * Quitting by bundle id (not by name) is what keeps the operator's own apps out of
 * this: only processes whose bundle id carries this run's stamp can match.
 */
export async function disposeFixtureRun(handle, backend) {
	const quit = [];
	try {
		const apps = await backend.listApps();
		for (const app of apps) {
			if (app.bundleId === handle.bundleId) {
				quit.push(app.pid);
				await backend.manageApps({ mode: "quit", pid: app.pid, force: true }).catch(() => undefined);
			}
		}
	} finally {
		rmSync(handle.dir, { recursive: true, force: true });
	}
	return { quit };
}

/**
 * Wait until the fixture's window exists, raising it once if it does not.
 *
 * `manageApps launch` runs with `activates: false`, and a SwiftUI app started that way
 * does not build its window until something raises it. Three live runs in the first
 * authorized B window failed on exactly this: the matrix launched, slept 2 s, listed
 * roots once and reported "no window" for every cell, and the L2 check activated and
 * then waited a fixed 1.2 s, which is the sample where a separate probe did see the
 * window - the wait sat on the edge.
 *
 * Raising goes through the product's own `manageApps` first. `osascript`/System Events
 * needs Automation permission and failed silently inside a `try`, which is why a fix
 * that only wrapped the old call still returned "no window".
 *
 * Returns the window root, or undefined if the app still has none after `timeoutMs`.
 */
export async function ensureFixtureWindow(backend, target, { activate = true, timeoutMs = 6000, intervalMs = 250 } = {}) {
	const windowOf = async () => (await backend.listRoots({ pid: target.pid })).find((candidate) => candidate.kind === "window");
	const pollUntil = async (deadline) => {
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
			const root = await windowOf();
			if (root) return root;
		}
		return undefined;
	};
	const found = await windowOf();
	if (found || !activate) return found;
	// Only the run's own copy is raised; every caller restores the operator's app.
	await backend.manageApps({ mode: "launch", bundleId: target.bundleId, path: target.path, activates: true }).catch(() => undefined);
	const raised = await pollUntil(Date.now() + timeoutMs);
	if (raised) return raised;
	try {
		execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of first process whose unix id is ${target.pid} to true`], { stdio: "pipe" });
	} catch {
		return undefined;
	}
	return await pollUntil(Date.now() + timeoutMs);
}
