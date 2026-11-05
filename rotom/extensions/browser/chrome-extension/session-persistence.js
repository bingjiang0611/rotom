// Per-session persistence for `chrome.storage.session`.
//
// One key per relay session (`browserRelayStateV3:<sessionId>`) instead of one
// document that every session rewrites. Writes are coalesced in a short window
// and diffed against what was last written, so a burst of operations touches one
// key once and unchanged sessions are never rewritten.
//
// Legacy keys stay readable: `browserRelayStateV2` (one document, many sessions)
// is migrated key by key and then removed; `browserRelayStateV1` keeps its old
// single-tab shape.

export const SESSION_STATE_KEY_PREFIX_V3 = "browserRelayStateV3:";
export const LEGACY_SESSION_STATE_KEY_V2 = "browserRelayStateV2";
export const LEGACY_SESSION_STATE_KEY_V1 = "browserRelayStateV1";
export const SESSION_PERSIST_MERGE_MS = 100;

export function sessionStateKeyV3(sessionId) {
	return `${SESSION_STATE_KEY_PREFIX_V3}${sessionId}`;
}

export function isSessionStateKeyV3(key) {
	return typeof key === "string" && key.startsWith(SESSION_STATE_KEY_PREFIX_V3) && key.length > SESSION_STATE_KEY_PREFIX_V3.length;
}

/** Serialized shape of one session, including its browser principal and tabs. */
export function serializeSessionStateV3(state) {
	return {
		schemaVersion: 3,
		sessionId: state.sessionId,
		agentId: state.agentId,
		rootSessionId: state.rootSessionId,
		...(state.leaseToken === undefined ? {} : { leaseToken: state.leaseToken }),
		generation: state.generation,
		keepTabs: state.keepTabs === true,
		currentTabName: state.currentTabName,
		tabs: [...state.tabsByName.entries()].map(([name, item]) => ({
			name,
			tabId: item.tabId,
			targetId: item.targetId,
			documentGeneration: item.documentGeneration,
			url: item.url,
			status: item.status,
			ownership: item.ownership,
			...(item.transferredFrom === undefined ? {} : { transferredFrom: item.transferredFrom }),
			...(item.restoreAutoDiscardable === undefined ? {} : { restoreAutoDiscardable: item.restoreAutoDiscardable }),
		})),
	};
}

/** Sessions carried by an older `browserRelayStateV2` document. */
export function legacyV2Sessions(storedV2) {
	if (!storedV2 || typeof storedV2 !== "object" || Array.isArray(storedV2) || storedV2.schemaVersion !== 2 || !Array.isArray(storedV2.sessions)) return [];
	return storedV2.sessions.filter((session) => session && typeof session === "object" && !Array.isArray(session));
}

/** The single session carried by the oldest `browserRelayStateV1` document. */
export function legacyV1Sessions(storedV1) {
	if (!storedV1 || typeof storedV1 !== "object" || Array.isArray(storedV1) || storedV1.schemaVersion !== 1 || !Array.isArray(storedV1.tabs)) return [];
	const active = storedV1.activeSession;
	if (!active || typeof active !== "object" || Array.isArray(active) || typeof active.sessionId !== "string") return [];
	return [{ sessionId: active.sessionId, currentTabName: storedV1.currentTabName, tabs: storedV1.tabs }];
}

/**
 * Coalescing, diffing writer. `entries()` returns a `Map<storageKey, value>` for
 * every session the extension currently holds; the writer stores only keys whose
 * encoded value changed since the last successful write.
 */
export function createMergedSessionWriter({ entries, write, remove, mergeWindowMs = SESSION_PERSIST_MERGE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
	let timer;
	let pending;
	let settle;
	let lastWritten = new Map();
	// One diff, used both to decide whether a schedule has anything to wait for and by
	// the flush itself. A read-only operation usually changes nothing, and sleeping
	// through the merge window only to write nothing is pure latency.
	const collect = () => {
		const current = entries();
		const payload = {};
		const encodedChanges = [];
		for (const [key, value] of current) {
			const encoded = JSON.stringify(value);
			if (lastWritten.get(key) === encoded) continue;
			payload[key] = value;
			encodedChanges.push([key, encoded]);
		}
		const dropped = [...lastWritten.keys()].filter((key) => !current.has(key));
		return { payload, encodedChanges, dropped };
	};
	const flush = async () => {
		timer = undefined;
		const { payload, encodedChanges, dropped } = collect();
		for (const [key, encoded] of encodedChanges) lastWritten.set(key, encoded);
		const awaiting = settle;
		pending = undefined;
		settle = undefined;
		try {
			if (Object.keys(payload).length > 0) await write(payload);
			if (dropped.length > 0) {
				await remove(dropped);
				for (const key of dropped) lastWritten.delete(key);
			}
			awaiting?.resolve();
		} catch (error) {
			// Keep the keys dirty so the next flush retries them; the caller still
			// learns that ownership was not recorded.
			for (const key of Object.keys(payload)) lastWritten.delete(key);
			awaiting?.reject(error);
			throw error;
		}
	};
	return {
		/** Mark the current state dirty and resolve once a flush covering it finished. */
		schedule() {
			// Nothing changed, so there is nothing to write and nothing to wait for:
			// resolve now instead of idling for the merge window.
			const probe = collect();
			if (Object.keys(probe.payload).length === 0 && probe.dropped.length === 0) return Promise.resolve();
			if (!pending) pending = new Promise((resolve, reject) => { settle = { resolve, reject }; });
			if (timer === undefined) timer = setTimer(() => { void flush().catch(() => undefined); }, mergeWindowMs);
			return pending;
		},
		/** Write now, ignoring the merge window (extension shutdown, migration). */
		async flushNow() {
			if (timer !== undefined) { clearTimer(timer); timer = undefined; }
			await flush();
		},
		writtenKeys: () => [...lastWritten.keys()],
	};
}
