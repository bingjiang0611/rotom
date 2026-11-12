/**
 * Host exclusion.
 *
 * The agent must never observe or act on the terminal (or IDE) it runs inside:
 * driving the host would let it type into its own output, and excluding it keeps
 * `find_roots` from returning the session's own window as a target.
 *
 * The host app is identified by pid ancestry, which needs no native support: the
 * broker registration already records the ancestor pids.
 */
export interface HostAppInfo {
	pid: number;
	appName: string;
	bundleId?: string;
}

export interface AppCandidate {
	pid: number;
	appName: string;
	bundleId?: string;
}

export interface RootCandidate {
	pid?: number;
	appName?: string;
	bundleId?: string;
}

/**
 * Resolve the host application from the agent's ancestor pids.
 *
 * Ancestors are nearest-first, so the first app in that order is the most
 * specific host (an IDE between the agent and the terminal wins).
 */
export function resolveHostApp(apps: readonly AppCandidate[], pidChain: readonly number[]): HostAppInfo | undefined {
	for (const pid of pidChain) {
		const app = apps.find((candidate) => candidate.pid === pid);
		if (app) return { pid: app.pid, appName: app.appName, bundleId: app.bundleId };
	}
	return undefined;
}

export function isHostRoot(root: RootCandidate, host: HostAppInfo | undefined): boolean {
	if (!host) return false;
	if (typeof root.pid === "number" && root.pid === host.pid) return true;
	if (root.bundleId && host.bundleId && root.bundleId.toLowerCase() === host.bundleId.toLowerCase()) return true;
	if (root.appName && root.appName.toLowerCase() === host.appName.toLowerCase()) return true;
	return false;
}

export function excludeHostRoots<T extends RootCandidate>(roots: readonly T[], host: HostAppInfo | undefined): T[] {
	return roots.filter((root) => !isHostRoot(root, host));
}

/**
 * Drop windows owned by processes that are part of the tool itself.
 *
 * The helper owns the agent cursor overlay and the takeover border, and the Pi
 * process may own a window of its own. Offering or photographing those would make
 * the agent observe its own drawing instead of the user's screen.
 */
export function excludeInternalRoots<T extends RootCandidate>(roots: readonly T[], internalPids: readonly number[]): T[] {
	const pids = new Set(internalPids.filter((pid) => Number.isFinite(pid) && pid > 0));
	if (pids.size === 0) return [...roots];
	return roots.filter((root) => !(typeof root.pid === "number" && pids.has(root.pid)));
}

/** Refusal message for an explicit attempt to target the host app. */
export function hostTargetRefusal(host: HostAppInfo): string {
	return `${host.appName} is the application hosting this session and is excluded from Computer Use. Choose a different root.`;
}
