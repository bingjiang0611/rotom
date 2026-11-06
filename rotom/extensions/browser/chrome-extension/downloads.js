// Downloads for agent tabs (T22).
//
// Only downloads started by an agent-owned tab are redirected into `rotom/<agentId>/`
// under the user's download directory. Everything else is left exactly where the user
// asked for it: a misclassified download that moves the user's file is worse than an
// agent download that keeps the default name.
//
// That "don't touch what is not provably ours" rule also decides the owner lookup: an
// ambiguous download is skipped, never guessed.

export const DOWNLOAD_ROOT_V1 = "rotom";
export const MAX_DOWNLOAD_AGENT_ID_CHARS_V1 = 64;
export const MAX_DOWNLOAD_NAME_CHARS_V1 = 120;
export const MAX_DOWNLOAD_RECORDS_V1 = 20;
/** Above this the Pi side reports the size but skips hashing; the file is not read twice. */
export const MAX_DOWNLOAD_HASH_BYTES_V1 = 64 * 1024 * 1024;

/** The directory segment for one agent, or undefined when the id cannot be a safe segment. */
export function downloadDirSegmentV1(agentId) {
	if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > MAX_DOWNLOAD_AGENT_ID_CHARS_V1) return undefined;
	return /^[A-Za-z0-9_-]+$/u.test(agentId) ? agentId : undefined;
}

/**
 * `<root>/<agent>/<basename>` for a suggested name. Directory components, `.`/`..`,
 * control characters and over-long names are all refused: Chrome would otherwise happily
 * write outside the intended subdirectory.
 */
export function downloadRelativeFilenameV1(input) {
	const agent = downloadDirSegmentV1(input?.agentId);
	if (agent === undefined) return undefined;
	if (typeof input?.suggestedFilename !== "string") return undefined;
	const basename = input.suggestedFilename.split(/[\\/]/u).pop() ?? "";
	if (basename === "" || basename === "." || basename === ".." || /[\u0000-\u001f]/u.test(basename)) return undefined;
	const bounded = basename.length > MAX_DOWNLOAD_NAME_CHARS_V1 ? basename.slice(basename.length - MAX_DOWNLOAD_NAME_CHARS_V1) : basename;
	return `${DOWNLOAD_ROOT_V1}/${agent}/${bounded}`;
}

/** True when `path` (absolute or relative) is under this agent's download directory. */
export function isAgentDownloadPathV1(path, agentId) {
	const agent = downloadDirSegmentV1(agentId);
	if (agent === undefined || typeof path !== "string") return false;
	const normalized = path.replace(/\\/gu, "/");
	return normalized.includes(`/${DOWNLOAD_ROOT_V1}/${agent}/`) || normalized.startsWith(`${DOWNLOAD_ROOT_V1}/${agent}/`);
}

/** Path relative to the user's download directory, or undefined when it is elsewhere. */
export function downloadRelativePathV1(path, agentId) {
	const agent = downloadDirSegmentV1(agentId);
	if (agent === undefined || typeof path !== "string") return undefined;
	const marker = `/${DOWNLOAD_ROOT_V1}/${agent}/`;
	const index = path.replace(/\\/gu, "/").lastIndexOf(marker);
	if (index < 0) return undefined;
	return `${DOWNLOAD_ROOT_V1}/${agent}/${path.replace(/\\/gu, "/").slice(index + marker.length)}`;
}

/** Bounded, model-safe view of one Chrome download record. */
export function downloadRecordV1(item, agentId) {
	if (!item || typeof item !== "object") return undefined;
	if (!Number.isSafeInteger(item.id)) return undefined;
	const relativePath = downloadRelativePathV1(item.filename, agentId);
	if (relativePath === undefined) return undefined;
	const state = typeof item.state === "string" && ["in_progress", "interrupted", "complete"].includes(item.state) ? item.state : "unknown";
	const bytes = Number.isFinite(item.fileSize) && item.fileSize >= 0 ? item.fileSize : Number.isFinite(item.bytesReceived) ? item.bytesReceived : 0;
	const mimeType = typeof item.mime === "string" && item.mime.length > 0 ? item.mime.slice(0, 128) : "application/octet-stream";
	return {
		id: item.id,
		state,
		relativePath: relativePath.slice(0, 512),
		bytes: Math.min(bytes, Number.MAX_SAFE_INTEGER),
		mimeType,
		// Pi needs the real path to hash the file; it never reaches the model.
		path: typeof item.filename === "string" ? item.filename : "",
		...(state === "interrupted" && typeof item.error === "string" ? { error: item.error.slice(0, 64) } : {}),
	};
}

/**
 * Which session owns this download.
 *
 * `tabId` is used when Chrome provides it. Otherwise the referrer decides, and only when
 * it is unambiguous: exactly one *agent-owned* tab shows that page and no claimed (user)
 * tab shows it. A user downloading from a page the agent also has open is therefore left
 * alone — moving the user's file is the failure this rule prevents.
 */
export function downloadOwnerAgentIdV1(input, tabs) {
	if (!Array.isArray(tabs)) return undefined;
	if (Number.isSafeInteger(input?.tabId)) {
		const match = tabs.find((tab) => tab.tabId === input.tabId);
		if (!match) return undefined;
		return match.ownership === "agent" ? match.agentId : undefined;
	}
	if (typeof input?.referrer !== "string" || input.referrer === "") return undefined;
	const page = pageKeyV1(input.referrer);
	if (page === undefined) return undefined;
	const matching = tabs.filter((tab) => typeof tab.url === "string" && pageKeyV1(tab.url) === page);
	if (matching.length === 0) return undefined;
	if (matching.some((tab) => tab.ownership !== "agent")) return undefined;
	const agents = new Set(matching.map((tab) => tab.agentId));
	return agents.size === 1 ? [...agents][0] : undefined;
}

/** origin + pathname: query/hash differences do not change which page this is. */
function pageKeyV1(url) {
	try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return undefined; }
}
