import { getComputerUseConfig } from "../../config.ts";
import { parseLookResponse, type LookResponse } from "../../outline.ts";
import { cursorColorFor } from "../../cursor-colors.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import type { HelperLease, ComputerUsePlatformBackend, FramePoints, HelperActResult, PlatformActRequest, PlatformApp, PlatformAppLaunchResult, PlatformAppQuitResult, PlatformClipboardRead, PlatformClipboardRestore, PlatformClipboardSnapshot, PlatformClipboardWrite, PlatformDisplay, PlatformFocusWindowResult, PlatformFrontmostResult, PlatformObserveRequest, PlatformReadTextRequest, PlatformReadTextResponse, PlatformRoot, PlatformRootKind, PlatformRootQuery, PlatformSystemSurface, PlatformSystemSurfaceName, PlatformTakeoverInput, PlatformTarget, PlatformUserActivity, PlatformWaitForRequest, PlatformWaitForResponse, PlatformWindowMutationResult } from "../types.ts";
import { macosHelper } from "./helper.ts";

function parseApps(result: unknown): PlatformApp[] {
	const array = Array.isArray(result) ? result : (result as any)?.apps;
	if (!Array.isArray(array)) return [];

	return array
		.map((raw) => {
			const pid = Math.trunc(toFiniteNumber((raw as any)?.pid, NaN));
			if (!Number.isFinite(pid) || pid <= 0) return undefined;
			const appName = toOptionalString((raw as any)?.appName) ?? "Unknown App";
			return {
				appName,
				bundleId: toOptionalString((raw as any)?.bundleId),
				pid,
				isFrontmost: toBoolean((raw as any)?.isFrontmost),
			} as PlatformApp;
		})
		.filter((item): item is PlatformApp => Boolean(item));
}

function parseFramePoints(raw: unknown): FramePoints {
	const frame = (raw as any)?.framePoints ?? {};
	return {
		x: toFiniteNumber(frame.x, 0),
		y: toFiniteNumber(frame.y, 0),
		w: Math.max(1, toFiniteNumber(frame.w, 1)),
		h: Math.max(1, toFiniteNumber(frame.h, 1)),
	};
}

function parseRoots(result: unknown): PlatformRoot[] {
	const array = Array.isArray(result) ? result : (result as any)?.roots;
	if (!Array.isArray(array)) return [];

	return array.map((raw) => {
		const metadata = typeof (raw as any)?.metadata === "object" && (raw as any).metadata !== null ? (raw as any).metadata as Record<string, unknown> : {};
		const kind = ["window", "menu", "sheet", "popover", "dialog"].includes((raw as any)?.kind) ? (raw as any).kind as PlatformRootKind : "window";
		return {
			kind,
			rootRef: toOptionalString((raw as any)?.rootRef ?? (raw as any)?.windowRef),
			windowRef: toOptionalString((raw as any)?.windowRef ?? (raw as any)?.rootRef),
			windowId: Number.isFinite((raw as any)?.windowId) ? Math.trunc((raw as any).windowId) : undefined,
			pid: Number.isFinite((raw as any)?.pid) ? Math.trunc((raw as any).pid) : undefined,
			appName: toOptionalString((raw as any)?.appName),
			bundleId: toOptionalString((raw as any)?.bundleId),
			title: toOptionalString((raw as any)?.title) ?? "",
			role: toOptionalString((raw as any)?.role),
			subrole: toOptionalString((raw as any)?.subrole),
			framePoints: parseFramePoints(raw),
			scaleFactor: Math.max(1, toFiniteNumber((raw as any)?.scaleFactor, 1)),
			zOrder: Math.trunc(toFiniteNumber((raw as any)?.zOrder, 0)),
			isMinimized: toBoolean((raw as any)?.isMinimized),
			isOnscreen: toBoolean((raw as any)?.isOnscreen),
			isMain: toBoolean((raw as any)?.isMain),
			isFocused: toBoolean((raw as any)?.isFocused),
			isModal: toBoolean((raw as any)?.isModal),
			metadata,
		};
	});
}

function helperAction(request: PlatformActRequest): Record<string, unknown> {
	if (!("focus" in request.target)) return { ...request };
	return { ...request, target: request.target.focus, params: { ...request.params, preserveFocus: true } };
}

function parseUserActivity(result: any): PlatformUserActivity {
	return {
		lastUserInputAt: toFiniteNumber(result?.lastUserInputAt, 0),
		idleSeconds: toFiniteNumber(result?.idleSeconds, -1),
		listening: toBoolean(result?.listening),
		userEventCount: Math.trunc(toFiniteNumber(result?.userEventCount, 0)),
		agentEventCount: Math.trunc(toFiniteNumber(result?.agentEventCount, 0)),
	};
}

function parseClipboard(result: any): PlatformClipboardRead {
	return {
		text: toOptionalString(result?.text) ?? "",
		truncated: toBoolean(result?.truncated),
		available: toBoolean(result?.available),
		changeCount: Math.trunc(toFiniteNumber(result?.changeCount, 0)),
	};
}

export const macosBackend: Pick<ComputerUsePlatformBackend, "listApps" | "listRoots" | "getFrontmost" | "focusWindow" | "observe" | "act" | "actBatch" | "readText" | "waitFor" | "userActivity" | "clipboardGet" | "clipboardSet" | "clipboardClear" | "clipboardSnapshot" | "clipboardRestore" | "manageApps" | "manageWindow" | "systemSurfaces"> = {
	async listApps(signal?: AbortSignal): Promise<PlatformApp[]> {
		return parseApps(await macosHelper.command<unknown>("listApps", {}, { signal }));
	},

	async listRoots(query: PlatformRootQuery, signal?: AbortSignal): Promise<PlatformRoot[]> {
		return parseRoots(await macosHelper.command<unknown>("listRoots", {
			...(Number.isFinite(query.pid) ? { pid: Math.trunc(query.pid!) } : {}),
			...(query.title?.trim() ? { title: query.title.trim() } : {}),
		}, { signal }));
	},

	async getFrontmost(signal?: AbortSignal): Promise<PlatformFrontmostResult> {
		const result = await macosHelper.command<any>("getFrontmost", {}, { signal });
		const pid = Math.trunc(toFiniteNumber(result?.pid, NaN));
		if (!Number.isFinite(pid) || pid <= 0) {
			throw new Error("No frontmost app was available for screenshot targeting.");
		}
		return {
			appName: toOptionalString(result?.appName) ?? "Unknown App",
			bundleId: toOptionalString(result?.bundleId),
			pid,
			windowTitle: toOptionalString(result?.windowTitle),
			windowId: Number.isFinite(result?.windowId) ? Math.trunc(result.windowId) : undefined,
		};
	},

	async focusWindow(target: PlatformTarget, signal: AbortSignal | undefined, lease: HelperLease): Promise<PlatformFocusWindowResult> {
		return await macosHelper.command<PlatformFocusWindowResult>("focusWindow", { ...target, lease }, { signal });
	},

	async observe(request: PlatformObserveRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<LookResponse> {
		return parseLookResponse(await macosHelper.command("look", {
			baseLookId: request.baseLookId,
			windowId: request.target.windowId,
			windowRef: request.target.rootRef,
			maxDimension: request.maxDimension,
			readText: request.readText,
			scopeRef: request.scopeRef,
			includeImage: request.includeImage,
		}, options));
	},

	async act(request: PlatformActRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult> {
		return await macosHelper.command<HelperActResult>(
			"act",
			{
				...helperAction(request),
				cursorOverlay: getComputerUseConfig().cursor_overlay,
				...(request.cursorAgentId ? { agentId: request.cursorAgentId, cursorColor: cursorColorFor(request.cursorAgentId) } : {}),
			},
			options,
		);
	},

	async actBatch(requests: PlatformActRequest[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<HelperActResult> {
		const cursorOverlay = getComputerUseConfig().cursor_overlay;
		return await macosHelper.command<HelperActResult>("actBatch", { actions: requests.map((request) => ({ ...helperAction(request), cursorOverlay })) }, options);
	},

	async readText(args: PlatformReadTextRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformReadTextResponse> {
		return await macosHelper.command("axReadText", { ...args }, options);
	},

	async waitFor(args: PlatformWaitForRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<PlatformWaitForResponse> {
		return await macosHelper.command("axWaitFor", { ...args }, options);
	},

	async userActivity(signal?: AbortSignal): Promise<PlatformUserActivity> {
		return parseUserActivity(await macosHelper.command<any>("userActivity", {}, { signal }));
	},

	async takeoverBegin(input: PlatformTakeoverInput, signal?: AbortSignal): Promise<void> {
		await macosHelper.command<any>("takeoverBegin", {
			pid: input.pid,
			label: input.label,
			agentId: input.agentId,
			...(input.lease ? { lease: input.lease } : {}),
		}, { signal });
	},

	async takeoverEnd(signal?: AbortSignal): Promise<void> {
		await macosHelper.command<any>("takeoverEnd", {}, { signal });
	},

	async clipboardGet(signal?: AbortSignal): Promise<PlatformClipboardRead> {
		return parseClipboard(await macosHelper.command<any>("clipboardGet", {}, { signal }));
	},

	async clipboardSet(text: string, signal?: AbortSignal, lease?: HelperLease): Promise<PlatformClipboardWrite> {
		const result = await macosHelper.command<any>("clipboardSet", { text, ...(lease ? { lease } : {}) }, { signal });
		return {
			changed: toBoolean(result?.changed),
			changeCount: Math.trunc(toFiniteNumber(result?.changeCount, 0)),
			length: Math.trunc(toFiniteNumber(result?.length, 0)),
		};
	},

	async clipboardSnapshot(signal?: AbortSignal): Promise<PlatformClipboardSnapshot> {
		const result = await macosHelper.command<any>("clipboardSnapshot", {}, { signal });
		const items = Array.isArray(result?.items)
			? result.items.map((raw: any) => ({
				types: (Array.isArray(raw?.types) ? raw.types : []).map((entry: any) => ({ type: String(entry?.type ?? ""), dataBase64: String(entry?.dataBase64 ?? "") })),
			}))
			: [];
		return { changeCount: Math.trunc(toFiniteNumber(result?.changeCount, 0)), totalBytes: Math.trunc(toFiniteNumber(result?.totalBytes, 0)), items };
	},

	async clipboardRestore(snapshot: PlatformClipboardSnapshot, signal: AbortSignal | undefined, lease: HelperLease): Promise<PlatformClipboardRestore> {
		const result = await macosHelper.command<any>("clipboardRestore", { items: snapshot.items, lease }, { signal });
		return {
			restored: toBoolean(result?.restored),
			changeCount: Math.trunc(toFiniteNumber(result?.changeCount, 0)),
			items: Math.trunc(toFiniteNumber(result?.items, 0)),
		};
	},

	async clipboardClear(signal?: AbortSignal, lease?: HelperLease): Promise<PlatformClipboardWrite> {
		const result = await macosHelper.command<any>("clipboardClear", { ...(lease ? { lease } : {}) }, { signal });
		return { cleared: toBoolean(result?.cleared), changeCount: Math.trunc(toFiniteNumber(result?.changeCount, 0)) };
	},

	async manageApps(request: any, signal?: AbortSignal): Promise<PlatformAppLaunchResult | PlatformAppQuitResult> {
		const result = await macosHelper.command<any>("manageApps", { ...request }, { signal });
		if (request.mode === "quit") {
			return {
				quitRequested: toBoolean(result?.quitRequested),
				terminated: toBoolean(result?.terminated),
				forced: toBoolean(result?.forced),
				unsavedChangesMayBlock: toBoolean(result?.unsavedChangesMayBlock),
			};
		}
		return {
			launched: toBoolean(result?.launched),
			alreadyRunning: toBoolean(result?.alreadyRunning),
			pending: toBoolean(result?.pending),
			pid: Number.isFinite(result?.pid) ? Math.trunc(result.pid) : undefined,
			activated: toBoolean(result?.activated),
		};
	},

	async manageWindow(request: any, signal?: AbortSignal): Promise<PlatformWindowMutationResult | PlatformRoot[] | PlatformDisplay[]> {
		const result = await macosHelper.command<any>("manageWindow", { ...request }, { signal });
		if (request.mode === "list") return parseRoots(result);
		if (request.mode === "list_displays") {
			const displays = Array.isArray(result?.displays) ? result.displays : [];
			return displays.map((raw: any) => ({
				displayId: Math.trunc(toFiniteNumber(raw?.displayId, 0)),
				name: toOptionalString(raw?.name) ?? "Unknown display",
				frame: parseFramePoints({ framePoints: raw?.frame }),
				visibleFrame: parseFramePoints({ framePoints: raw?.visibleFrame }),
				scaleFactor: Math.max(1, toFiniteNumber(raw?.scaleFactor, 1)),
				isMain: toBoolean(raw?.isMain),
			})) as PlatformDisplay[];
		}
		const outcome = ["worked", "didnt", "unknown"].includes(result?.outcome) ? result.outcome : "unknown";
		return {
			outcome,
			windowId: Number.isFinite(result?.windowId) ? Math.trunc(result.windowId) : undefined,
			pid: Number.isFinite(result?.pid) ? Math.trunc(result.pid) : undefined,
			before: result?.before,
			after: result?.after,
			activated: toBoolean(result?.activated),
			raised: toBoolean(result?.raised),
		} as PlatformWindowMutationResult;
	},

	async systemSurfaces(surface: PlatformSystemSurfaceName | "all", signal?: AbortSignal): Promise<Record<string, PlatformSystemSurface>> {
		const result = await macosHelper.command<any>("systemSurfaces", { surface }, { signal });
		const surfaces = typeof result?.surfaces === "object" && result.surfaces !== null ? result.surfaces : {};
		const parsed: Record<string, PlatformSystemSurface> = {};
		for (const [name, raw] of Object.entries(surfaces as Record<string, any>)) {
			parsed[name] = {
				available: toBoolean(raw?.available),
				bundleId: toOptionalString(raw?.bundleId) ?? "",
				pid: Number.isFinite(raw?.pid) ? Math.trunc(raw.pid) : undefined,
				roots: parseRoots(raw),
			};
		}
		return parsed;
	},
};
