/**
 * Which product a session actually ran, and whether that product contains a given fix.
 *
 * A release string is `<version>-<channel>.<suffix>`. A mainline build names the commit it was cut
 * from, so a fix is present when that commit is the fix or a descendant of it. A local build's
 * suffix is a build hash, not a commit, so the same question has no answer and the session is left
 * out of every acceptance count rather than counted as exposure.
 */

/** The commit a release string can be traced to, or undefined when it cannot be traced. */
export function releaseCommit(release: string | undefined): string | undefined {
	if (typeof release !== "string") return undefined;
	const match = /^(?:0\.\d+\.\d+)-(main|local)\.([0-9a-f]{7,40})$/u.exec(release);
	if (!match || match[1] !== "main") return undefined;
	return match[2];
}

/** True when `descendant` is `ancestor` or comes after it. */
export function containsCommit(ancestor: string, descendant: string, isAncestor: (older: string, newer: string) => boolean): boolean {
	if (ancestor === descendant) return true;
	return isAncestor(ancestor, descendant);
}

export type VersionSegment = { release: string; commit: string | undefined; startsAt: string; endsAt: string; sessions: number; turns: number; switchedBy: "unknown" };

/**
 * The product timeline the harvest can prove: consecutive runs over the sessions it kept, ordered by
 * start time. Who performed a switch is not recorded anywhere, so every segment says unknown.
 */
export function versionTimeline(sessions: readonly { startedAt: string; release?: string; userTurns: number }[]): VersionSegment[] {
	const ordered = sessions
		.filter((session) => typeof session.release === "string")
		.slice()
		.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
	const segments: VersionSegment[] = [];
	for (const session of ordered) {
		const release = session.release as string;
		const last = segments.at(-1);
		if (last && last.release === release) {
			last.endsAt = session.startedAt > last.endsAt ? session.startedAt : last.endsAt;
			last.sessions += 1;
			last.turns += session.userTurns;
			continue;
		}
		segments.push({ release, commit: releaseCommit(release), startsAt: session.startedAt, endsAt: session.startedAt, sessions: 1, turns: session.userTurns, switchedBy: "unknown" });
	}
	return segments;
}

/**
 * A version that cannot load the provider it was installed for is not exposure for anything the
 * provider does. `0.1.27-main.2b4ea53b` shipped a Qoder provider whose catalog module was missing,
 * so its Qoder turns never reached the transport at all.
 */
export const BROKEN_QODER_RELEASES = ["0.1.27-main.2b4ea53b"] as const;

export function qoderUnavailable(release: string | undefined): boolean {
	return typeof release === "string" && (BROKEN_QODER_RELEASES as readonly string[]).includes(release);
}
