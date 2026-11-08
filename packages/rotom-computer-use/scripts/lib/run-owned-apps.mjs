/**
 * App process ownership for real-machine scripts (review 11, Z1).
 *
 * A pid belongs to a run only when the helper's launch result says that this call
 * created a new process. Finding an app later, matching a bundle id, or receiving an
 * `alreadyRunning` launch result never grants cleanup authority.
 */
export function createRunAppOwnership() {
	return new Set();
}

export function rememberRunLaunch(ownedPids, result) {
	const pid = Number(result?.pid);
	if (result?.launched === true && result?.alreadyRunning !== true && Number.isInteger(pid) && pid > 0) {
		ownedPids.add(pid);
		return pid;
	}
	return undefined;
}

/**
 * Quit only a pid proven to have been created by this run. B-stage cleanup never
 * escalates to force: an app that does not terminate is evidence, not permission to kill it.
 */
export async function quitRunOwnedApp({ backend, ownedPids, pid, record, area = "cleanup", action = "owned app" }) {
	const numericPid = Number(pid);
	if (!Number.isInteger(numericPid) || !ownedPids.has(numericPid)) {
		record?.(area, action, "fail", `refused to quit pid=${pid}: it was not recorded from a new launch by this run`);
		return { refused: true, pid: numericPid };
	}
	try {
		const result = await backend.manageApps({ mode: "quit", pid: numericPid, force: false });
		const stopped = result?.terminated === true;
		if (stopped) ownedPids.delete(numericPid);
		else record?.(area, action, "fail", `quit pid=${numericPid} did not terminate the app; ownership retained`);
		return { refused: false, pid: numericPid, stopped, result };
	} catch (error) {
		record?.(area, action, "fail", `quit pid=${numericPid} failed: ${error instanceof Error ? error.message : String(error)}`);
		return { refused: false, pid: numericPid, error };
	}
}
