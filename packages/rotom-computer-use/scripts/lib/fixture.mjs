/**
 * Fixture runs for the real-machine scripts (A8).
 *
 * LaunchServices keys an app by its bundle identity: launching "the same" copy from
 * a second path can attach to the already-running instance (`-10825`), which would
 * mean a script that believes it started its own process is actually operating the
 * operator's. Every run therefore copies the fixture to a fresh directory, gives it
 * a new bundle id (`com.example.cu-fixture.<timestamp>`), re-signs the copy ad hoc,
 * and deletes it afterwards.
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
export function prepareFixtureRun({ sourceApp, runRoot, stamp = String(Date.now()), sign = true }) {
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

	// Ad-hoc signature: an unsigned copy is killed by the OS, and a re-signed copy is
	// what makes the new bundle identity real. Skipped only by the layout dry run.
	if (sign) execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundlePath], { stdio: "pipe" });
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
