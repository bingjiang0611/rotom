import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getComputerUseConfig } from "../config.ts";
import { currentPlatformBackend } from "../platform/index.ts";
import type { PlatformClipboardSnapshot } from "../platform/types.ts";
import type { DesktopToolDeps } from "./desktop-deps.ts";
import { clipboardIntent } from "./intents.ts";
import { unsupportedToolResult } from "./results.ts";

export const CLIPBOARD_RESTORE_MS = 30_000;

/**
 * Record why a clipboard restore was skipped. The trace is the only place that can
 * answer "did the agent touch my clipboard and leave it alone afterwards?", and it
 * stores a reason code only — never clipboard content.
 */
function recordClipboardRestoreSkip(deps: DesktopToolDeps, reason: "user_changed_clipboard" | "no_snapshot" | "restore_failed"): void {
	deps.trace()?.record({ tool: "clipboard", status: "unknown", evidence: `restore_skipped:${reason}`, clipboardRestoreSkipped: reason });
}

let clipboardRestoreTimer: ReturnType<typeof setTimeout> | undefined;

function clearClipboardRestoreTimer(): void {
	if (clipboardRestoreTimer) clearTimeout(clipboardRestoreTimer);
	clipboardRestoreTimer = undefined;
}

/**
 * Put the user's clipboard back after an agent write.
 *
 * Two rules, both learned from review B4:
 *  1. Restore only while the clipboard still holds exactly what the agent wrote.
 *     If the user copied something in the meantime, overwriting it would be the
 *     very interference this feature exists to avoid, so we leave it alone.
 *  2. The snapshot covers every item and type, so images and file promises come
 *     back too. A clipboard we cannot capture is refused before the write, never
 *     silently dropped afterwards.
 */
export function scheduleClipboardRestore(options: {
	snapshot: PlatformClipboardSnapshot | undefined;
	/** changeCount observed right after the agent's write. */
	writtenChangeCount: number;
	restore: boolean;
	snapshotNow?: () => Promise<PlatformClipboardSnapshot>;
	write: (snapshot: PlatformClipboardSnapshot) => Promise<unknown>;
	onSkip?: (reason: "user_changed_clipboard" | "no_snapshot" | "restore_failed") => void;
	delayMs?: number;
	setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
}): boolean {
	if (!options.restore || !options.snapshot) return false;
	clearClipboardRestoreTimer();
	const delay = options.delayMs ?? CLIPBOARD_RESTORE_MS;
	const setTimer = options.setTimer ?? setTimeout;
	clipboardRestoreTimer = setTimer(() => {
		clipboardRestoreTimer = undefined;
		void (async () => {
			const current = await options.snapshotNow?.().catch(() => undefined);
			if (!current || current.changeCount !== options.writtenChangeCount) {
				options.onSkip?.("user_changed_clipboard");
				return;
			}
			await options.write(options.snapshot as PlatformClipboardSnapshot).catch(() => options.onSkip?.("restore_failed"));
		})();
	}, delay);
	clipboardRestoreTimer.unref?.();
	return true;
}

export function createClipboardTool(deps: DesktopToolDeps) {
	return async function performClipboard(params: { action: "get" | "set" | "clear"; text?: string }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
		const backend = currentPlatformBackend;
		// Clipboard reads and writes are authorized per level and serialized through one
		// lease: an approval card or a running peer must both be respected (review B2).
		const clipboardLease = async <T>(action: "get" | "set" | "clear", work: () => Promise<T>): Promise<T> => {
			const intent = clipboardIntent(action);
			const scheduler = deps.scheduler();
			const baseEpoch = scheduler.epoch(intent.resourceKey);
			const result = await scheduler.write(intent.resourceKey, baseEpoch, async () => await work(), {
				action: intent.action,
				...(intent.app ? { app: intent.app } : {}),
			});
			return result.value;
		};
		if (params.action === "get") {
			if (!backend.clipboardGet) return unsupportedToolResult("clipboard", "get", "This platform cannot read the clipboard.");
			const read = await clipboardLease("get", async () => await backend.clipboardGet!());
			return {
				content: [{ type: "text", text: read.available ? `Clipboard contains ${read.text.length} characters${read.truncated ? " (truncated)" : ""}.` : "Clipboard is empty." }],
				details: { tool: "clipboard", action: "get", status: "ok", ...read },
			};
		}
		if (params.action === "clear") {
			if (!backend.clipboardClear) return unsupportedToolResult("clipboard", "clear", "This platform cannot clear the clipboard.");
			const cleared = await clipboardLease("clear", async () => await backend.clipboardClear!());
			return {
				content: [{ type: "text", text: "Cleared the clipboard." }],
				details: { tool: "clipboard", action: "clear", status: "ok", ...cleared },
			};
		}
		if (!backend.clipboardSet) return unsupportedToolResult("clipboard", "set", "This platform cannot write the clipboard.");
		const text = params.text ?? "";
		// Capture before writing: a clipboard whose types cannot be copied exactly is
		// refused, because a partial restore would destroy the user's content.
		const snapshot = await backend.clipboardSnapshot?.().catch(() => undefined);
		const written = await clipboardLease("set", async () => await backend.clipboardSet!(text));
		const restore = scheduleClipboardRestore({
			snapshot,
			writtenChangeCount: written.changeCount,
			restore: getComputerUseConfig().clipboard_restore,
			snapshotNow: async () => await backend.clipboardSnapshot?.() as PlatformClipboardSnapshot,
			write: async (value) => await backend.clipboardRestore?.(value),
			onSkip: (reason) => recordClipboardRestoreSkip(deps, reason),
		});
		return {
			content: [{
				type: "text",
				text: written.changed === false
					? "The clipboard refused the new text."
					: `Wrote ${[...text].length} characters to the clipboard${restore ? "; the previous clipboard content is restored in 30 seconds unless you copy something else first" : ""}.`,
			}],
			details: { tool: "clipboard", action: "set", status: written.changed === false ? "didnt" : "ok", ...written, restores: restore },
		};
	};
}
