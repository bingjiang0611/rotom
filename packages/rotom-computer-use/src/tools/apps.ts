import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { currentPlatformBackend } from "../platform/index.ts";
import type { DesktopToolDeps } from "./desktop-deps.ts";
import { appIntent } from "./intents.ts";
import { toolProblem, unsupportedToolResult } from "./results.ts";

/**
 * Resolve the app identity the policy layer needs. Without it the broker can only
 * apply the anonymous-resource rule, which is a deliberate relaxation for
 * headless targets that have no identity at all.
 */
export async function describeApp(pid?: number, bundleId?: string): Promise<{ appName: string; bundleId?: string } | undefined> {
	try {
		const apps = await currentPlatformBackend.listApps();
		const match = apps.find((app) => (pid !== undefined ? app.pid === pid : false) || (bundleId ? app.bundleId === bundleId : false));
		if (!match) return bundleId ? { appName: bundleId, bundleId } : undefined;
		return { appName: match.appName, ...(match.bundleId ? { bundleId: match.bundleId } : {}) };
	} catch {
		return bundleId ? { appName: bundleId, bundleId } : undefined;
	}
}

export function createAppTool(deps: DesktopToolDeps) {
	return async function performManageApp(params: { action: "list" | "launch" | "quit"; bundleId?: string; path?: string; pid?: number; force?: boolean }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
		const backend = currentPlatformBackend;
		if (params.action === "list") {
			const apps = await currentPlatformBackend.listApps();
			const lines = apps.map((app) => `${app.appName}${app.bundleId ? ` (${app.bundleId})` : ""} pid=${app.pid}${app.isFrontmost ? " frontmost" : ""}`);
			return {
				content: [{ type: "text", text: lines.length ? lines.join("\n") : "No applications are running." }],
				details: { tool: "manage_app", action: "list", status: "ok", apps },
			};
		}
		if (!backend.manageApps) return unsupportedToolResult("manage_app", params.action, "This platform cannot manage applications.");
		const scheduler = deps.scheduler();
		if (params.action === "quit") {
			if (params.pid === undefined && !params.bundleId) return toolProblem("manage_app", "quit requires pid or bundleId.");
			const appInfo = await describeApp(params.pid, params.bundleId);
			const intent = appIntent("quit", appInfo, params.pid, params.force === true);
			const result = await scheduler.write(intent.resourceKey, scheduler.epoch(intent.resourceKey), async () =>
				await backend.manageApps!({ mode: "quit", pid: params.pid, bundleId: params.bundleId, force: params.force === true }), {
				action: intent.action,
				...(intent.app ? { app: intent.app } : {}),
			}).then((outcome) => outcome.value);
			const quit = result as { terminated?: boolean; quitRequested?: boolean; unsavedChangesMayBlock?: boolean };
			const status = quit.terminated ? "worked" : quit.unsavedChangesMayBlock ? "unknown" : "didnt";
			return {
				content: [{
					type: "text",
					text: quit.terminated
						? "The application quit."
						: quit.quitRequested
							? "The quit request was accepted but the application is still running; it may be waiting on unsaved changes."
							: "The application refused to quit.",
				}],
				details: { tool: "manage_app", action: "quit", status, ...quit },
			};
		}
		if (!params.bundleId && !params.path) return toolProblem("manage_app", "launch requires bundleId or path.");
		const launchIntent = appIntent("launch", await describeApp(params.pid, params.bundleId), params.pid);
		const launched = await scheduler.write(launchIntent.resourceKey, scheduler.epoch(launchIntent.resourceKey), async () =>
			await backend.manageApps!({ mode: "launch", bundleId: params.bundleId, path: params.path, activates: false }), {
			action: launchIntent.action,
			...(launchIntent.app ? { app: launchIntent.app } : {}),
		}).then((outcome) => outcome.value);
		const launch = launched as { launched?: boolean; alreadyRunning?: boolean; pending?: boolean; pid?: number };
		return {
			content: [{
				type: "text",
				text: launch.launched
					? `Launched the application${launch.alreadyRunning ? " (it was already running)" : ""} without activating it${launch.pid ? `, pid ${launch.pid}` : ""}.`
					: launch.pending
						? "The launch is still in progress; nothing is active yet."
						: "The application did not launch.",
			}],
			details: { tool: "manage_app", action: "launch", status: launch.launched ? "ok" : launch.pending ? "unknown" : "didnt", ...launch },
		};
	};
}
