import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { exportTraceMarkdown } from "../trace/report.ts";
import type { DesktopToolDeps } from "./desktop-deps.ts";
import { unsupportedToolResult } from "./results.ts";

export function createCuSessionTool(deps: DesktopToolDeps) {
	return async function performCuSession(params: { action: "status" | "release" | "trace_export" }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
		if (params.action === "trace_export") {
			const recorder = deps.trace();
			if (!recorder) return unsupportedToolResult("cu_session", "trace_export", "Tracing is disabled for this session.");
			const markdown = exportTraceMarkdown(recorder.sessionDir, path.basename(recorder.filePath));
			return {
				content: [{ type: "text", text: markdown }],
				details: { tool: "cu_session", action: "trace_export", status: "ok", path: recorder.filePath },
			};
		}
		const session = deps.broker();
		if (!session) return unsupportedToolResult("cu_session", params.action, "The Desktop Broker is not attached to this session.");
		if (params.action === "status") {
			const status = await session.client.status();
			const lines = (status.agents ?? []).map((agent) => {
				const held = agent.leases.map((lease) => lease.resourceKey).join(", ");
				return `${agent.agentId}${agent.agentId === session.client.agentId ? " (this session)" : ""}${held ? ` holds ${held}` : " holds nothing"}`;
			});
			return {
				content: [{ type: "text", text: lines.length ? lines.join("\n") : "No agents are attached to the broker." }],
				details: { tool: "cu_session", action: "status", status: "ok", broker: status },
			};
		}
		const status = await session.client.status().catch(() => undefined);
		const held = status?.agents.find((agent) => agent.agentId === session.client.agentId)?.leases ?? [];
		await session.broker.releaseAll();
		return {
			content: [{ type: "text", text: held.length ? `Released ${held.length} lease(s): ${held.map((lease) => lease.resourceKey).join(", ")}.` : "This session held no leases." }],
			details: { tool: "cu_session", action: "release", status: "ok", released: held.map((lease) => lease.resourceKey) },
		};
	};
}
