import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import { formatResumeFirstFailedRunDetail } from "./resume-guidance.ts";
import { readCompletionReplay } from "./completion-replay.ts";
import { writePrivateAtomicJson as writeAtomicJson } from "../../shared/atomic-json.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import {
	DIRS,
	INTERCOM_DETACH_REQUEST_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentState,
	type WaitCompletion,
	type WaitSubscriptionRecord,
} from "../../shared/types.ts";

const SUBSCRIPTION_VERSION = 2;
const MAX_CONTROL_KEYS = 64;
const HEX_KEY = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set(["needs attention", "completed", "failed", "paused", "stopped", "rejected", "timed out", "could not be reconciled", "reconciliation failed"]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
const RECONCILE_INTERVAL_MS = 1_000;
/**
 * How often the subscriptions directory is re-scanned for expired records left
 * by other sessions. Rare compared to RECONCILE_INTERVAL_MS because it costs a
 * directory read, and nothing depends on the sweep being prompt.
 */
const FOREIGN_SWEEP_INTERVAL_MS = 60_000;
/**
 * How far past expiry a record armed by another session is kept before it is
 * swept. The owning session settles its own expired records with a "timed out"
 * notice on the next restore(), so removing one the moment it expires would take
 * that notice away from a session that simply had not resumed yet. A day is long
 * enough for an ordinary return and short enough to bound the directory.
 */
const FOREIGN_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ArmWaitSubscriptionInput {
	targetKind: "async" | "foreground";
	runId: string;
	requestedId: string;
	timeoutMs: number;
}

export interface WaitSubscriptionManager {
	arm(input: ArmWaitSubscriptionInput): WaitSubscriptionRecord;
	restore(): void;
	reconcile(): void;
	dispose(): void;
}

interface WaitSubscriptionManagerOptions {
	asyncDirRoot?: string;
	resultsDir?: string;
	subscriptionsDir?: string;
	now?: () => number;
	pollIntervalMs?: number;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function parseRecord(value: unknown): WaitSubscriptionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<WaitSubscriptionRecord>;
	if ((record.version !== 1 && record.version !== SUBSCRIPTION_VERSION)
		|| typeof record.token !== "string"
		|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.token)
		|| typeof record.sessionId !== "string"
		|| (record.targetKind !== "async" && record.targetKind !== "foreground")
		|| typeof record.runId !== "string"
		|| typeof record.requestedId !== "string"
		|| typeof record.createdAt !== "number"
		|| typeof record.expiresAt !== "number"
		|| !Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt)) return undefined;
	// Unknown/corrupt delivery state must not fall back to a fresh send.
	if (record.lastAttentionKey !== undefined && !HEX_KEY.test(record.lastAttentionKey)) return undefined;
	if (record.controlKey !== undefined && !HEX_KEY.test(record.controlKey)) return undefined;
	if (record.seenControlKeys !== undefined && (!Array.isArray(record.seenControlKeys)
		|| record.seenControlKeys.length > MAX_CONTROL_KEYS || !record.seenControlKeys.every((key) => typeof key === "string" && HEX_KEY.test(key)))) return undefined;
	if (record.delivery !== undefined) {
		const d = record.delivery;
		if (!d || typeof d !== "object" || typeof d.attemptId !== "string" || !UUID.test(d.attemptId)
			|| !OUTCOMES.has(d.outcome) || (d.state !== "unknown" && d.state !== "accepted")
			|| !Number.isFinite(d.attemptedAt)) return undefined;
	}
	return record as WaitSubscriptionRecord;
}

function needsAttention(run: AsyncRunSummary): boolean {
	return run.activityState === "needs_attention" || run.steps.some((step) =>
		step.status === "running" && step.activityState === "needs_attention");
}

function subscriptionFile(dir: string, token: string): string {
	return path.join(dir, `${token}.json`);
}

export function formatWaitSubscriptions(state: Pick<SubagentState, "waitSubscriptions">, now = Date.now()): string | undefined {
	const subscriptions = [...(state.waitSubscriptions?.values() ?? [])].sort((left, right) => left.createdAt - right.createdAt);
	if (subscriptions.length === 0) return undefined;
	const lines = [`Armed wait subscriptions (${subscriptions.length}):`];
	for (const record of subscriptions) {
		lines.push(`- ${record.token}: ${record.targetKind} run ${record.runId}, ${record.delivery
			? `delivery ${record.delivery.state} (${record.delivery.outcome}); awaiting session receipt; no automatic resend; inspect session/status`
			: `timeout in ${Math.max(0, record.expiresAt - now)}ms`}`);
	}
	return lines.join("\n");
}

export function createWaitSubscriptionManager(
	pi: Pick<ExtensionAPI, "events" | "sendMessage">,
	state: SubagentState,
	options: WaitSubscriptionManagerOptions = {},
): WaitSubscriptionManager {
	const asyncDirRoot = options.asyncDirRoot ?? DIRS.async;
	const resultsDir = options.resultsDir ?? DIRS.results;
	const subscriptionsDir = options.subscriptionsDir ?? path.join(path.dirname(asyncDirRoot), "wait-subscriptions");
	const now = options.now ?? Date.now;
	const subscriptions = state.waitSubscriptions ?? new Map<string, WaitSubscriptionRecord>();
	state.waitSubscriptions = subscriptions;
	const unresolvedRestoredForegroundTokens = new Set<string>();
	const inFlight = new Set<string>();
	const quarantinedTargets = new Set<string>();
	const targetKey = (sessionId: string, targetKind: string, runId: string) => digest([sessionId, targetKind, runId]);
	const save = (record: WaitSubscriptionRecord, changes: Partial<WaitSubscriptionRecord>) => {
		const next = { ...record, ...changes, version: SUBSCRIPTION_VERSION } as WaitSubscriptionRecord;
		writeAtomicJson(subscriptionFile(subscriptionsDir, record.token), next);
		Object.assign(record, next);
	};
	let disposed = false;
	let lastForeignSweepAt = 0;

	/**
	 * Remove expired records armed by another session.
	 *
	 * Only the owning session can be woken, so restore() never loads a foreign
	 * record into `subscriptions` and reconcileRecord() returns before its
	 * timeout branch. Nothing reconciles such a record and nothing expires it, so
	 * a session that arms a wait and never comes back (forked, renamed, deleted)
	 * leaves one file here per wait, forever.
	 *
	 * Kept for FOREIGN_SWEEP_GRACE_MS past expiry so an owner that resumes late
	 * still finds its record and gets the timeout notice.
	 *
	 * Runs on the reconcile timer as well as at restore(), because a record that
	 * is still live when another session starts would otherwise never be looked
	 * at again: restore() only fires on session_start, and reconcile() walks the
	 * in-memory map, which holds current-session records only. A host that keeps
	 * one session open for hours is exactly where that gap bites.
	 *
	 * Never throws: it runs from the reconcile timer.
	 */
	const sweepExpiredForeignSubscriptions = (force = false) => {
		const sweptAt = now();
		if (!force && sweptAt - lastForeignSweepAt < FOREIGN_SWEEP_INTERVAL_MS) return;
		lastForeignSweepAt = sweptAt;
		let files: string[];
		try {
			files = fs.readdirSync(subscriptionsDir).filter((file) => file.endsWith(".json"));
		} catch (error) {
			if (!isNotFound(error)) console.error(`Failed to scan wait subscriptions in '${subscriptionsDir}':`, error);
			return;
		}
		for (const file of files) {
			const filePath = path.join(subscriptionsDir, file);
			let record: WaitSubscriptionRecord | undefined;
			try {
				record = parseRecord(JSON.parse(fs.readFileSync(filePath, "utf-8")));
			} catch (error) {
				console.error(`Ignoring invalid wait subscription '${filePath}':`, error);
				continue;
			}
			if (!record || file !== `${record.token}.json`) continue;
			// The owning session keeps its own expired records so reconcileRecord()
			// can still settle them with the "timed out" notice callers expect.
			if (record.sessionId === state.currentSessionId) continue;
			// An unresolved attempt is evidence, not an expired subscription to sweep.
			if (record.delivery) continue;
			if (sweptAt < record.expiresAt + FOREIGN_SWEEP_GRACE_MS) continue;
			try {
				fs.unlinkSync(filePath);
			} catch (error) {
				// Losing this race is harmless: another session may have swept the
				// same expired record. Anything else is reported and retried on the
				// next sweep rather than interrupting the caller.
				if (!isNotFound(error)) console.error(`Failed to remove expired wait subscription '${filePath}':`, error);
			}
		}
	};

	const remove = (record: WaitSubscriptionRecord) => {
		try {
			fs.unlinkSync(subscriptionFile(subscriptionsDir, record.token));
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		subscriptions.delete(record.token);
		unresolvedRestoredForegroundTokens.delete(record.token);
	};

	const finishAccepted = (record: WaitSubscriptionRecord) => {
		if (record.delivery?.outcome === "needs attention") save(record, { delivery: undefined });
		else remove(record);
	};

	const hasReceipt = (record: WaitSubscriptionRecord): boolean => {
		// Queue acceptance is not session visibility. This public readback proves
		// presence, not fsync or model consumption. Missing/truncated/other-branch
		// history never permits retry.
		const ctx = state.lastUiContext;
		const attempt = record.delivery;
		// Match the package's file-first owner identity, not Pi's distinct native UUID.
		if (!attempt || !ctx || resolveCurrentSessionId(ctx.sessionManager) !== record.sessionId) return false;
		return ctx.sessionManager.getBranch().slice(-4096).some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== "subagent-wait-subscription") return false;
			const d = entry.details as Record<string, unknown> | undefined;
			return d?.sessionId === record.sessionId && d.token === record.token && d.runId === record.runId
				&& d.attemptId === attempt.attemptId && d.outcome === attempt.outcome;
		});
	};

	const reconcileDelivery = (record: WaitSubscriptionRecord) => {
		if (!record.delivery || inFlight.has(record.token) || !hasReceipt(record)) return;
		// The receipt is authoritative; an extra persisted queue-acceptance phase
		// adds no recovery evidence. Legacy "accepted" records remain readable.
		finishAccepted(record);
	};

	const settle = (record: WaitSubscriptionRecord, outcome: string, detail: string, completion?: WaitCompletion, attentionKey?: string) => {
		if (disposed || state.currentSessionId !== record.sessionId || record.delivery || inFlight.has(record.token)) return;
		// Persist the attempt BEFORE dispatch. Crashes on either side of sendMessage
		// cannot prove whether Pi accepted it; recovery never blindly resends it.
		inFlight.add(record.token);
		try {
			save(record, {
				delivery: { attemptId: randomUUID(), outcome, state: "unknown", attemptedAt: now() },
				...(attentionKey ? { lastAttentionKey: attentionKey } : {}),
			});
			pi.sendMessage({
				customType: "subagent-wait-subscription",
				content: `Wait subscription ${record.token} fired for run ${record.runId}: ${outcome}. ${detail}`,
				display: true,
				details: {
					token: record.token,
					sessionId: record.sessionId,
					attemptId: record.delivery!.attemptId,
					runId: record.runId,
					outcome,
					...(completion ? { completions: [completion] } : {}),
				},
			}, { triggerTurn: true });
			if (hasReceipt(record)) finishAccepted(record);
		} catch {
			// No error body: dispatch failures may contain message or provider content.
			console.error(`Wait subscription '${record.token}' delivery/settlement unconfirmed; inspect persisted state. No automatic resend.`);
		} finally {
			inFlight.delete(record.token);
		}
	};

	const observeAttention = (record: WaitSubscriptionRecord, shape?: unknown) => {
		if (shape === undefined) {
			if (record.lastAttentionKey || record.controlKey) save(record, { lastAttentionKey: undefined, controlKey: undefined });
			return;
		}
		const key = digest([shape, record.controlKey]);
		if (record.lastAttentionKey === key) return;
		settle(record, "needs attention", "Inspect status and native/external supervisor requests. This subscription remains armed for new attention or completion.", undefined, key);
	};

	const reconcileRecord = (record: WaitSubscriptionRecord) => {
		if (record.sessionId !== state.currentSessionId || inFlight.has(record.token)) return;
		if (record.delivery) {
			reconcileDelivery(record);
			if (record.delivery || !subscriptions.has(record.token)) return;
		}
		if (now() >= record.expiresAt) {
			settle(record, "timed out", "The targeted run may still be active; inspect its status before taking follow-up action.");
			return;
		}
		if (record.targetKind === "foreground") {
			const run = state.foregroundRuns?.get(record.runId);
			if (!run && unresolvedRestoredForegroundTokens.has(record.token)) return;
			if (run) unresolvedRestoredForegroundTokens.delete(record.token);
			if (!run || run.sessionId !== record.sessionId) {
				settle(record, "could not be reconciled", "The remembered foreground run disappeared before completion was confirmed.");
				return;
			}
			const detached = run.children.filter((child) => child.status === "detached");
			const attention = run.children.flatMap((child, index) => child.status === "detached"
				&& child.activityState === "needs_attention" && child.currentTool === "contact_supervisor"
				? [[index, child.currentToolStartedAt]] : []);
			observeAttention(record, attention.length ? attention : undefined);
			if (detached.length === 0) {
				const failed = run.children.some((child) => child.status === "failed");
				settle(record, failed ? "failed" : "completed", "Inspect the run status for its final output.");
			}
			return;
		}

		const runs = listAsyncRuns(asyncDirRoot, {
			sessionId: record.sessionId,
			runId: record.runId,
			exactRunId: true,
			resultsDir,
			kill: options.kill,
			now,
		});
		const run = runs.find((candidate) => candidate.id === record.runId);
		if (!run) {
			settle(record, "could not be reconciled", "The exact async run disappeared before a terminal result was confirmed.");
			return;
		}
		if (run.state === "queued" || run.state === "running") {
			// Ignore counters, tool text and lastUpdate: progress alone is not a new block.
			observeAttention(record, needsAttention(run) ? [run.startedAt, run.currentStep,
				run.activityState === "needs_attention", run.currentTool === "contact_supervisor" ? run.currentToolStartedAt : undefined,
				run.steps.filter((step) => step.status === "running").map((step) => [step.index,
					step.activityState === "needs_attention", step.currentTool === "contact_supervisor" ? step.currentToolStartedAt : undefined]),
			] : undefined);
			return;
		}
		let completion: WaitCompletion | undefined;
		try {
			completion = readCompletionReplay(resultsDir, record.runId, { sessionId: record.sessionId, now: now() })?.completion;
		} catch {
			console.error(`Completion replay unavailable for wait subscription '${record.token}'.`);
		}
		const detail = formatResumeFirstFailedRunDetail(run) ?? "Inspect the run status for its final output.";
		const archiveDetail = completion?.archivePath ? ` Completion archive: ${completion.archivePath}.` : "";
		settle(record, run.state === "complete" ? "completed" : run.state, `${detail}${archiveDetail}`, completion);
	};

	const reconcile = () => {
		if (disposed) return;
		// Before the session check: with no current session every record is
		// foreign, and expired ones should still be cleaned up.
		sweepExpiredForeignSubscriptions();
		if (!state.currentSessionId) return;
		for (const record of [...subscriptions.values()]) {
			try {
				reconcileRecord(record);
			} catch (error) {
				console.error(`Failed to reconcile wait subscription '${record.token}'; inspect persisted state.`);
				settle(record, "reconciliation failed", "The targeted run could not be reconciled. Inspect its status before taking follow-up action.");
			}
		}
	};

	const wakeChannels = [
		INTERCOM_DETACH_REQUEST_EVENT,
		SUBAGENT_ASYNC_COMPLETE_EVENT,
		SUBAGENT_FOREGROUND_COMPLETE_EVENT,
		SUBAGENT_CONTROL_EVENT,
		SUBAGENT_CONTROL_INTERCOM_EVENT,
		SUBAGENT_RESULT_INTERCOM_EVENT,
	];
	const unsubscribes = wakeChannels.map((channel) => pi.events.on(channel, (data: unknown) => {
		// The same immutable control event may arrive over two channels or be replayed.
		// Hash only metadata; keep a bounded replay window per existing subscription.
		if ((channel === SUBAGENT_CONTROL_EVENT || channel === SUBAGENT_CONTROL_INTERCOM_EVENT)
			&& data && typeof data === "object" && "event" in data) {
			const event = (data as { event?: import("../../shared/types.ts").ControlEvent }).event;
			if (event?.type === "needs_attention" && typeof event.runId === "string" && Number.isFinite(event.ts)) {
				const key = digest([event.id, event.runId, event.index, event.nestedRunId, event.nestingPath, event.ts, event.reason]);
				for (const record of subscriptions.values()) {
					if (record.sessionId !== state.currentSessionId || record.runId !== event.runId
						|| record.seenControlKeys?.includes(key)) continue;
					try { save(record, { controlKey: key, seenControlKeys: [...(record.seenControlKeys ?? []), key].slice(-MAX_CONTROL_KEYS) }); }
					catch { /* No acknowledgment on failed persistence; reconciliation stays conservative. */ }
				}
			}
		}
		reconcile();
	}));
	const interval = setInterval(reconcile, options.pollIntervalMs ?? RECONCILE_INTERVAL_MS);
	interval.unref?.();

	return {
		arm(input) {
			const sessionId = state.currentSessionId;
			if (!sessionId) throw new Error("A wait subscription requires an active session identity.");
			if (disposed) throw new Error("Wait subscription manager is disposed.");
			if (quarantinedTargets.has(targetKey(sessionId, input.targetKind, input.runId))) throw new Error("Invalid persisted wait state for this target; inspect it before re-arming.");
			const existing = [...subscriptions.values()].find((record) => record.sessionId === sessionId
				&& record.targetKind === input.targetKind && record.runId === input.runId);
			if (existing?.delivery) throw new Error("Wait delivery is unconfirmed or awaiting settlement. Inspect subscription status/session readback; do not re-arm to replay it.");
			// Re-arm is idempotent, including its original deadline. Attention is an
			// intermediate signal, not consumption of the terminal subscription.
			if (existing) return existing;
			const createdAt = now();
			const record: WaitSubscriptionRecord = {
				version: SUBSCRIPTION_VERSION,
				token: randomUUID(),
				sessionId,
				targetKind: input.targetKind,
				runId: input.runId,
				requestedId: input.requestedId,
				createdAt,
				expiresAt: createdAt + input.timeoutMs,
			};
			fs.mkdirSync(subscriptionsDir, { recursive: true });
			writeAtomicJson(subscriptionFile(subscriptionsDir, record.token), record);
			subscriptions.set(record.token, record);
			return record;
		},
		restore() {
			subscriptions.clear();
			quarantinedTargets.clear();
			unresolvedRestoredForegroundTokens.clear();
			// Unconditional: a process that starts without a session identity should
			// still clear records nobody can act on.
			sweepExpiredForeignSubscriptions(true);
			if (!state.currentSessionId) return;
			let files: string[];
			try {
				files = fs.readdirSync(subscriptionsDir).filter((file) => file.endsWith(".json"));
			} catch (error) {
				if (isNotFound(error)) return;
				throw error;
			}
			for (const file of files) {
				try {
					const raw = JSON.parse(fs.readFileSync(path.join(subscriptionsDir, file), "utf-8"));
					const record = parseRecord(raw);
					if (!record || file !== `${record.token}.json`) {
						if (raw?.sessionId === state.currentSessionId && typeof raw.runId === "string"
							&& (raw.targetKind === "async" || raw.targetKind === "foreground")) {
							quarantinedTargets.add(targetKey(raw.sessionId, raw.targetKind, raw.runId));
						}
						continue;
					}
					if (record.sessionId === state.currentSessionId) {
						subscriptions.set(record.token, record);
						if (record.targetKind === "foreground" && !state.foregroundRuns?.has(record.runId)) unresolvedRestoredForegroundTokens.add(record.token);
					}
				} catch (error) {
					console.error(`Ignoring invalid wait subscription '${path.join(subscriptionsDir, file)}':`, error);
				}
			}
			reconcile();
		},
		reconcile,
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(interval);
			for (const unsubscribe of unsubscribes) {
				try { unsubscribe(); } catch { /* best effort */ }
			}
			subscriptions.clear();
		},
	};
}
