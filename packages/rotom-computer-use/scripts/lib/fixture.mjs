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

import { createRunAppOwnership, quitRunOwnedApp, rememberRunCopiedFixture, rememberRunLaunch } from "./run-owned-apps.mjs";

export const FIXTURE_BUNDLE_PREFIX = "com.example.cu-fixture.";

/**
 * The macOS the fixture is built for, and the deployment target its binary must carry.
 *
 * These two have to agree. A binary built without `-target` inherits the SDK default, and on
 * 2026-11-07 that produced `minos 28.0` on a macOS 27.3 host: dyld refused to load it and
 * LaunchServices reported only "a miscellaneous error occurred", which cost a whole B0 window
 * and looked exactly like a broken bundle.
 */
export const FIXTURE_MINIMUM_MACOS = "14.0";

/** `otool -l` output -> the `minos` recorded in `LC_BUILD_VERSION`, or undefined. */
export function parseBuildVersionMinos(otoolOutput) {
	const match = /LC_BUILD_VERSION[\s\S]*?\bminos\s+([0-9.]+)/.exec(String(otoolOutput ?? ""));
	return match?.[1];
}

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
	return { bundlePath, bundleId, dir, sourceApp, startedPids: createRunAppOwnership() };
}

/**
 * Quit only pids whose launch result proved this run created them, then delete the copy.
 * The unique bundle id finds candidates; it never grants quit authority by itself.
 */
export async function disposeFixtureRun(handle, backend, { record } = {}) {
	const quit = [];
	const refused = [];
	const apps = await backend.listApps();
	for (const app of apps) {
		if (app.bundleId !== handle.bundleId) continue;
		const result = await quitRunOwnedApp({ backend, ownedPids: handle.startedPids, pid: app.pid, record, area: "cleanup", action: "fixture copy" });
		if (result.refused) refused.push(app.pid);
		else if (result.stopped) quit.push(app.pid);
	}
	const remaining = (await backend.listApps()).filter((app) => app.bundleId === handle.bundleId).map((app) => app.pid);
	const removed = remaining.length === 0;
	if (removed) rmSync(handle.dir, { recursive: true, force: true });
	else record?.("cleanup", "fixture copy removal", "fail", `kept ${handle.dir}; still running pid=${remaining.join(",")}`);
	return { quit, refused, remaining, removed };
}

/**
 * Wait for the fixture's window, without inventing an activation path.
 *
 * The fixture's explicit startup mode orders its window behind the user's windows without
 * activating the application. Polling is all that is left: either AX sees that window or
 * the step fails. There is no `osascript` or focus-stealing fallback.
 */
export const FIXTURE_WINDOW_TIMEOUT_MS = 6000;

/**
 * The fixture was listed as running a moment ago. If it is gone now the launch failed after
 * the process appeared; if it is alive without a window the window itself never got built.
 * Both look identical in the archive otherwise (2026-11-08 22:14 could not tell them apart).
 */
export async function explainWindowTimeout(backend, target) {
	const apps = await backend.listApps().catch(() => undefined);
	if (!apps) return "listApps failed, so the process state is unknown";
	return apps.some((app) => app.pid === target.pid)
		? `pid=${target.pid} is still running without a window`
		: `pid=${target.pid} exited before drawing a window`;
}

export async function ensureFixtureWindow(backend, target, { timeoutMs = FIXTURE_WINDOW_TIMEOUT_MS, intervalMs = 250 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const root = (await backend.listRoots({ pid: target.pid })).find((candidate) => candidate.kind === "window");
		if (root) return root;
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** Select a copied fixture only through its exact recorded ownership proof. */
export function selectFixtureForRun(apps, { run, startedByThisRun }) {
	if (run) return apps.find((app) => app.bundleId === run.bundleId && run.startedPids.has(app.pid));
	return apps.find((app) => isFixtureBundleId(app.bundleId) && startedByThisRun(app))
		?? apps.find((app) => app.bundleId === "com.example.cu-fixture")
		?? apps.find((app) => /fixture/i.test(app.appName ?? ""));
}

/**
 * Start the run's own fixture copy without taking the foreground.
 *
 * The fixture's explicit startup mode orders its own window behind the user's windows
 * without activating the application. LaunchServices therefore never needs to steal focus.
 */
export async function launchFixture(backend, handle, { pendingTimeoutMs = 8_000, pendingIntervalMs = 200 } = {}) {
	const canProveCopiedFixture = handle.startedPids && isFixtureBundleId(handle.bundleId);
	const beforePids = canProveCopiedFixture
		? new Set((await backend.listApps()).map((app) => Number(app.pid)).filter((pid) => Number.isInteger(pid) && pid > 0))
		: undefined;
	const result = await backend.manageApps({
		mode: "launch",
		path: handle.bundlePath,
		bundleId: handle.bundleId,
		activates: false,
		arguments: ["--show-without-activation"],
	});
	if (!canProveCopiedFixture || rememberRunLaunch(handle.startedPids, result) || result?.pending !== true) return result;

	const deadline = Date.now() + pendingTimeoutMs;
	for (;;) {
		const candidates = (await backend.listApps()).filter((app) => app.bundleId === handle.bundleId && !beforePids.has(Number(app.pid)));
		if (candidates.length === 1) {
			const pid = rememberRunCopiedFixture(handle.startedPids, { bundleId: handle.bundleId, beforePids, app: candidates[0] });
			if (pid) return { ...result, pid };
		}
		// More than one new process with the supposedly unique id is ambiguous and
		// therefore grants no quit authority.
		if (candidates.length > 1 || Date.now() >= deadline) return result;
		await new Promise((resolve) => setTimeout(resolve, pendingIntervalMs));
	}
}

/** The bundle metadata, exported so a test can check the keys without a Mac build. */
export function fixtureInfoPlist({ bundleId = "com.example.cu-fixture", version = "1" } = {}) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Fixture</string>
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
	<key>CFBundleName</key>
	<string>CU Fixture</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>LSMinimumSystemVersion</key>
	<string>${FIXTURE_MINIMUM_MACOS}</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`;
}

/**
 * Copy, sign, launch the run's own fixture and wait for its window.
 *
 * This is the sequence that has cost the most windows, so it lives in one place with one
 * behaviour: a copy amfid refuses throws (the caller refuses the run), an already-running
 * copy that this run did not start is reported and never touched, and a launch that produces
 * no window is a recorded result rather than a crash.
 */
export async function bringUpFixture({ backend, fixturePath, runRoot, preparedRun, sign, identity, startedByThisRun, record }) {
	let run = preparedRun;
	let launchPath = run?.bundlePath ?? fixturePath;
	if (runRoot && !run) {
		run = prepareFixtureRun({ sourceApp: fixturePath, runRoot, sign, identity });
		launchPath = run.bundlePath;
		record("fixture", "fresh copy", "pass", `bundle=${run.bundleId} path=${launchPath}`);
	} else if (run) {
		record("fixture", "prepared copy", "pass", `bundle=${run.bundleId} path=${launchPath}`);
	}
	// The fixture orders its own window behind the user's windows without activating. There is no `open -n`
	// fallback: an ad-hoc launch command is not part of a frozen script, and a window that
	// never appears is a result.
	await launchFixture(backend, run ?? { bundlePath: launchPath }).catch((error) => record("fixture", "launch", "fail", error instanceof Error ? error.message : String(error)));
	await new Promise((resolve) => setTimeout(resolve, 1500));
	const apps = await backend.listApps();
	let fixture = selectFixtureForRun(apps, { run, startedByThisRun });
	const unownedCopy = run && !fixture ? apps.find((app) => app.bundleId === run.bundleId) : undefined;
	if (unownedCopy) {
		record("fixture", "present", "skipped", `pid=${unownedCopy.pid} has the copied bundle id but no launch ownership proof`);
	} else if (fixture && !run && !startedByThisRun(fixture)) {
		record("fixture", "present", "skipped", `pid=${fixture.pid} was already running before this run; quit it so the check can launch its own copy`);
		fixture = undefined;
	} else if (fixture) {
		record("fixture", "present", "pass", `pid=${fixture.pid} bundle=${fixture.bundleId}`);
	} else {
		record("fixture", "present", "fail", "the fixture app is not running and could not be launched");
	}
	return { fixture, run, launchPath };
}
