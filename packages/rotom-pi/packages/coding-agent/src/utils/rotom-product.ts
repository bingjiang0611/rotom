import { compare, prerelease, valid } from "semver";

export const ROTOM_RELEASES_URL = "https://github.com/bingjiang0611/rotom/releases";
const RELEASES_API = "https://api.github.com/repos/bingjiang0611/rotom/releases?per_page=20";
export const ROTOM_UPDATE_GUIDANCE =
	"Get the rotom release bundle. Install to a new prefix while sessions are active; do not use pi update.";

/** Launcher-owned display metadata, not an executable/resource trust decision. */
export function getRotomVersion(): string | undefined {
	const version = process.env.ROTOM_PRODUCT_VERSION;
	return version && valid(version) === version ? version : undefined;
}

export interface RotomRelease {
	version: string;
}

export function selectRotomRelease(data: unknown, currentVersion: string): RotomRelease | undefined {
	if (!valid(currentVersion) || !Array.isArray(data)) return undefined;
	let newest = currentVersion;
	for (const release of data.slice(0, 20)) {
		if (!release || release.draft !== false || typeof release.tag_name !== "string") continue;
		const tag = release.tag_name.replace(/^v/, "");
		// Never render arbitrary release text/URLs or compare malformed tags as versions.
		if (valid(tag) !== tag || (!prerelease(currentVersion) && (prerelease(tag) || release.prerelease === true)))
			continue;
		if (compare(tag, newest) > 0) newest = tag;
	}
	return newest === currentVersion ? undefined : { version: newest };
}

/** One bounded public metadata request; no credentials, install, cache or retry. */
export async function checkForNewRotomVersion(currentVersion: string): Promise<RotomRelease | undefined> {
	if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK || process.env.ROTOM_SKIP_VERSION_CHECK) {
		return undefined;
	}
	if (!valid(currentVersion)) return undefined;
	try {
		const response = await fetch(RELEASES_API, {
			headers: { accept: "application/vnd.github+json", "User-Agent": `rotom/${currentVersion}` },
			signal: AbortSignal.timeout(5000),
			redirect: "error",
		});
		if (!response.ok || !response.body) return undefined;
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 256 * 1024) {
					await reader.cancel();
					return undefined;
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		return selectRotomRelease(JSON.parse(Buffer.concat(chunks).toString("utf8")), currentVersion);
	} catch {
		// Optional update discovery must never delay/fail the user's session.
		return undefined;
	}
}
