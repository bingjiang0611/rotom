import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getComputerUseConfig } from "../config.ts";
import { currentPlatformBackend } from "../platform/index.ts";
import type { HelperLease, PlatformRoot } from "../platform/types.ts";
import { describeApp } from "./apps.ts";
import type { DesktopToolDeps } from "./desktop-deps.ts";
import { windowIntent } from "./intents.ts";
import { toolProblem, unsupportedToolResult } from "./results.ts";

export function createWindowTool(deps: DesktopToolDeps) {
	return async function performManageWindow(params: { action: "list" | "move" | "resize" | "minimize" | "restore" | "maximize" | "list_displays"; pid?: number; windowId?: number; x?: number; y?: number; w?: number; h?: number; title?: string }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
		const backend = currentPlatformBackend;
		if (!backend.manageWindow) return unsupportedToolResult("manage_window", params.action, "This platform cannot manage windows.");
		if (params.action === "list" || params.action === "list_displays") {
			const result = await backend.manageWindow(params.action === "list"
				? { mode: "list", pid: params.pid, title: params.title }
				: { mode: "list_displays" });
			if (params.action === "list_displays") {
				const displays = result as Array<{ name: string; frame: { x: number; y: number; w: number; h: number }; isMain: boolean; scaleFactor: number }>;
				const lines = displays.map((display) => `${display.name}${display.isMain ? " (main)" : ""} ${Math.round(display.frame.w)}x${Math.round(display.frame.h)} @${display.scaleFactor}x at ${Math.round(display.frame.x)},${Math.round(display.frame.y)}`);
				return {
					content: [{ type: "text", text: lines.length ? lines.join("\n") : "No displays were reported." }],
					details: { tool: "manage_window", action: "list_displays", status: "ok", displays },
				};
			}
			const roots = result as PlatformRoot[];
			const windows = deps.collectWindows(roots, getComputerUseConfig());
			return {
				content: [{ type: "text", text: windows.length ? windows.map(deps.formatWindowLine).join("\n") : "No windows matched." }],
				details: { tool: "manage_window", action: "list", status: "ok", windows },
			};
		}
		if (params.windowId === undefined || params.pid === undefined) return toolProblem("manage_window", `${params.action} requires pid and windowId.`);
		const intent = windowIntent(params.action, params.pid, params.windowId, await describeApp(params.pid));
		const scheduler = deps.scheduler();
		const result = await scheduler.write(intent.resourceKey, scheduler.epoch(intent.resourceKey), async (_nextEpoch, grant) =>
			await backend.manageWindow!({
				mode: params.action,
				pid: params.pid,
				windowId: params.windowId,
				x: params.x,
				y: params.y,
				w: params.w,
				h: params.h,
				...(grant.token ? { lease: { token: grant.token, resourceKey: intent.resourceKey } } : {}),
			}), {
			action: intent.action,
			...(intent.app ? { app: intent.app } : {}),
		}).then((outcome) => outcome.value);
		const mutation = result as { outcome?: string; before?: unknown; after?: unknown };
		return {
			content: [{
				type: "text",
				text: mutation.outcome === "worked"
					? `Window ${params.windowId}: ${params.action} applied. Never activated or raised.`
					: `Window ${params.windowId}: ${params.action} did not change the window (${mutation.outcome ?? "unknown"}).`,
			}],
			details: { tool: "manage_window", action: params.action, status: mutation.outcome === "worked" ? "ok" : mutation.outcome === "didnt" ? "didnt" : "unknown", ...mutation },
		};
	};
}
