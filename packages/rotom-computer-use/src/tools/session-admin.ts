import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { BrokerRequestError } from "../broker/client.ts";
import { exportTraceMarkdown } from "../trace/report.ts";
import type { DesktopToolDeps } from "./desktop-deps.ts";
import { toolProblem, unsupportedToolResult } from "./results.ts";

export function createCuSessionTool(deps: DesktopToolDeps) {
	return async function performCuSession(params: { action: "status" | "release" | "transfer" | "trace_export"; toAgentId?: string; resourceKey?: string }, _signal?: AbortSignal): Promise<AgentToolResult<Record<string, unknown>>> {
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
		if (params.action === "transfer") {
			if (!params.toAgentId) return toolProblem("cu_session", "transfer requires toAgentId.");
			const selected = params.resourceKey ? held.filter((lease) => lease.resourceKey === params.resourceKey) : held;
			if (selected.length === 0) {
				return toolProblem(
					"cu_session",
					params.resourceKey ? `This session holds no lease on ${params.resourceKey}.` : "This session holds no leases to hand over.",
				);
			}
			const moved: string[] = [];
			for (const lease of selected) {
				try {
					await session.client.transfer(lease.leaseId, params.toAgentId);
					moved.push(lease.resourceKey);
				} catch (error) {
					if (!(error instanceof BrokerRequestError)) throw error;
					return {
						content: [{
							type: "text",
							text: `Handed over ${moved.length ? moved.join(", ") : "nothing"}; ${lease.resourceKey} was refused: ${error.code}: ${error.message}`,
						}],
						details: {
							tool: "cu_session",
							action: "transfer",
							status: "denied",
							toAgentId: params.toAgentId,
							moved,
							refused: { resourceKey: lease.resourceKey, code: error.code, message: error.message },
						},
					};
				}
			}
			return {
				content: [{ type: "text", text: `Handed ${moved.join(", ")} to ${params.toAgentId}. It returns to this session when that agent exits.` }],
				details: { tool: "cu_session", action: "transfer", status: "ok", toAgentId: params.toAgentId, moved },
			};
		}
		await session.broker.releaseAll();
		return {
			content: [{ type: "text", text: held.length ? `Released ${held.length} lease(s): ${held.map((lease) => lease.resourceKey).join(", ")}.` : "This session held no leases." }],
			details: { tool: "cu_session", action: "release", status: "ok", released: held.map((lease) => lease.resourceKey) },
		};
	};
}
