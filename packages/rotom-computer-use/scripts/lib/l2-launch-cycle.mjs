import { disposeFixtureRun, ensureFixtureWindow, launchFixture, prepareFixtureRun } from "./fixture.mjs";
import { quitRunOwnedApp } from "./run-owned-apps.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForLaunchedApp(backend, run, pid, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const app = (await backend.listApps()).find((candidate) => candidate.pid === pid && candidate.bundleId === run.bundleId);
		if (app) return app;
		await sleep(200);
	}
	return undefined;
}

/** Launch one prepared copy, measure its delay and event delta, then quit only its recorded pid. */
export async function measuredFixtureLaunch({ backend, helper, run, label, record }) {
	const activityBefore = await helper.command("userActivity", {});
	const startedAt = Date.now();
	const launch = await launchFixture(backend, run);
	const elapsedMs = Date.now() - startedAt;
	const pid = Number(launch?.pid);
	const owned = run.startedPids.has(pid);
	const app = owned ? await waitForLaunchedApp(backend, run, pid) : undefined;
	const root = app ? await ensureFixtureWindow(backend, { pid: app.pid }) : undefined;
	const activityAfter = await helper.command("userActivity", {});
	const userDelta = Number(activityAfter.userEventCount ?? 0) - Number(activityBefore.userEventCount ?? 0);
	const agentDelta = Number(activityAfter.agentEventCount ?? 0) - Number(activityBefore.agentEventCount ?? 0);
	const result = owned && app && root ? "recorded" : "fail";
	record("launch twice", label, result, `elapsedMs=${elapsedMs} pid=${pid || "?"} alreadyRunning=${launch?.alreadyRunning === true} window=${root ? "yes" : "no"} userDelta=${userDelta} agentDelta=${agentDelta}`);
	if (!owned) {
		record("cleanup", `${label} fixture`, "fail", `pid=${pid || "?"} was not recorded as a new launch`);
		return { launch, elapsedMs, userDelta, agentDelta, app, root };
	}
	const quit = await quitRunOwnedApp({ backend, ownedPids: run.startedPids, pid, record, area: "cleanup", action: `${label} fixture` });
	await sleep(500);
	const stopped = quit.stopped === true && !(await backend.listApps()).some((candidate) => candidate.pid === pid);
	record("cleanup", `${label} fixture stopped`, stopped ? "pass" : "fail", `pid=${pid}; force=false; readback=${stopped ? "absent" : "still running"}`);
	return { launch, elapsedMs, userDelta, agentDelta, app, root, stopped };
}

export async function recordHidCalibration({ helper, record }) {
	const calibration = await helper.command("calibrateHidEventSource", {}).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
	record("calibration", "marked HID mouseMoved", calibration.found && calibration.agentDelta === 1 ? "recorded" : "fail", calibration.error ? `error=${calibration.error}` : `pid=${calibration.pid} state=${calibration.stateId} type=${calibration.type} agentDelta=${calibration.agentDelta}`);
}

export async function preparePrewarmedFixture({ sourceApp, runRoot, sign, backend, helper, record }) {
	const run = prepareFixtureRun({ sourceApp, runRoot, sign });
	record("fixture", "fresh copy", "pass", `bundle=${run.bundleId} path=${run.bundlePath}`);
	const result = await prewarmFixture({ backend, helper, run, record });
	if (!result.app || !result.root || !result.stopped) throw new Error("prewarm did not launch, show and stop its run-owned fixture");
	return run;
}

export async function prepareLaunchTwiceExperiment({ sourceApp, runRoot, sign, backend, helper, record }) {
	const run = prepareFixtureRun({ sourceApp, runRoot, sign });
	record("fixture", "fresh copy", "pass", `bundle=${run.bundleId} path=${run.bundlePath}`);
	await runLaunchTwiceExperiment({ backend, helper, run, record });
}

/** REVIEW-11 Z2: launch the same copied/signed bundle twice. */
export async function runLaunchTwiceExperiment({ backend, helper, run, record }) {
	const first = await measuredFixtureLaunch({ backend, helper, run, label: "first launch", record });
	const second = first.stopped ? await measuredFixtureLaunch({ backend, helper, run, label: "second launch", record }) : undefined;
	if (!second) record("launch twice", "second launch", "fail", "first launch did not stop cleanly; second launch refused");
	const cleanup = await disposeFixtureRun(run, backend, { record });
	record("cleanup", "fixture copy", cleanup.removed && cleanup.refused.length === 0 ? "pass" : "fail", `quit=${cleanup.quit.join(",") || "none"} refused=${cleanup.refused.join(",") || "none"} remaining=${cleanup.remaining.join(",") || "none"} removed=${cleanup.removed}`);
	return { first, second };
}

/** Prewarm is opt-in: do one measured first launch before the formal quiet gate. */
export async function prewarmFixture({ backend, helper, run, record }) {
	const result = await measuredFixtureLaunch({ backend, helper, run, label: "prewarm", record });
	record("prewarm", "fixture", result.app && result.root ? "pass" : "fail", `elapsedMs=${result.elapsedMs} userDelta=${result.userDelta} agentDelta=${result.agentDelta}`);
	return result;
}
