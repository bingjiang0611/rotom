import { compare, prerelease, valid } from "semver";

const ROTOM_PACKAGE_NAME = "@bingjiang0611/rotom";
const ROTOM_LATEST_API = "https://registry.npmjs.org/%40bingjiang0611%2Frotom/latest";
export const ROTOM_PACKAGE_URL = `https://www.npmjs.com/package/${ROTOM_PACKAGE_NAME}`;
export const ROTOM_UPDATE_GUIDANCE = `Exit every rotom session, run: npm install -g --ignore-scripts ${ROTOM_PACKAGE_NAME}, then start rotom again. Existing sessions and workers do not hot-reload.`;

/** Launcher-owned display metadata, not an executable/resource trust decision. */
export function getRotomVersion(): string | undefined {
	const version = process.env.ROTOM_PRODUCT_VERSION;
	return version && valid(version) === version ? version : undefined;
}

export interface RotomRelease {
	version: string;
}

export function selectRotomPackageUpdate(data: unknown, currentVersion: string): RotomRelease | undefined {
	if (!data || typeof data !== "object" || valid(currentVersion) !== currentVersion) return undefined;
	const metadata = data as { name?: unknown; version?: unknown };
	if (
		metadata.name !== ROTOM_PACKAGE_NAME ||
		typeof metadata.version !== "string" ||
		valid(metadata.version) !== metadata.version
	) {
		return undefined;
	}
	if (prerelease(currentVersion) === null && prerelease(metadata.version) !== null) return undefined;
	return compare(metadata.version, currentVersion) > 0 ? { version: metadata.version } : undefined;
}

/** One bounded public metadata request; no credentials, install, cache or retry. */
export async function checkForNewRotomVersion(currentVersion: string): Promise<RotomRelease | undefined> {
	if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK || process.env.ROTOM_SKIP_VERSION_CHECK) {
		return undefined;
	}
	if (valid(currentVersion) !== currentVersion) return undefined;
	try {
		const response = await fetch(ROTOM_LATEST_API, {
			headers: { accept: "application/json", "User-Agent": `rotom/${currentVersion}` },
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
		return selectRotomPackageUpdate(JSON.parse(Buffer.concat(chunks).toString("utf8")), currentVersion);
	} catch {
		// Optional update discovery must never delay/fail the user's session.
		return undefined;
	}
}
