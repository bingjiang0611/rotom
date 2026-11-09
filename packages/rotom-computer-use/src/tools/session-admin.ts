import path from "node:path";
import { takeoverCopy } from "../constants/copy.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { BrokerRequestError } from "../broker/client.ts";
import { exportTraceMarkdown } from "../trace/report.ts";
import type { DesktopToolDeps } from "./desktop-deps.ts";
import { toolProblem, unsupportedToolResult } from "./results.ts";

export function createCuSessionTool(deps: DesktopToolDeps) {
	return async function performCuSession(
		params: { action: "status" | "release" | "transfer" | "trace_export" | "takeover" | "release_takeover"; toAgentId?: string; resourceKey?: string; pid?: number },
		signal?: AbortSignal,
	): Promise<AgentToolResult<Record<string, unknown>>> {
		if (params.action === "trace_export") {
			const recorder = deps.trace();
			if (!recorder) return unsupportedToolResult("cu_session", "trace_export", "Tracing is disabled for this session.");
			const markdown = exportTraceMarkdown(recorder.sessionDir, path.basename(recorder.filePath));
			return {
				content: [{ type: "text", text: markdown }],
				details: { tool: "cu_session", action: "trace_export", status: "ok", path: recorder.filePath },
			};
		}
		if (params.action === "takeover" || params.action === "release_takeover") {
			const takeover = deps.takeover();
			if (!takeover) return unsupportedToolResult("cu_session", params.action, "Foreground takeover is not available on this platform.");
			if (params.action === "release_takeover") {
				const ended = await takeover.end();
				return {
					content: [{ type: "text", text: ended.released ? `Released the foreground (pid ${ended.pid}).` : "This session did not hold the foreground." }],
					details: { tool: "cu_session", action: "release_takeover", status: "ok", released: ended.released, pid: ended.pid },
				};
			}
			if (!Number.isFinite(params.pid)) return toolProblem("cu_session", "takeover requires the pid of the app to drive.");
			const started = await takeover.start(Math.trunc(params.pid!), signal);
			if (!started.ok) {
				return {
					content: [{ type: "text", text: `Takeover refused: ${started.message}` }],
					details: { tool: "cu_session", action: "takeover", status: "denied", code: started.code, ...(started.holder ? { holder: started.holder } : {}) },
				};
			}
			return {
				content: [{
					type: "text",
					text: takeoverCopy.started(started.app.appName, started.pid, new Date(started.expiresAt).toISOString()),
				}],
				details: {
					tool: "cu_session",
					action: "takeover",
					status: "ok",
					pid: started.pid,
					app: { appName: started.app.appName, bundleId: started.app.bundleId },
					leaseId: started.leaseId,
					expiresAt: started.expiresAt,
				},
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
					const handed = await session.client.transfer(lease.leaseId, params.toAgentId);
					moved.push(lease.resourceKey);
					// The user asks "who moved my app": ids only, never content.
					deps.trace()?.record({
						tool: "cu_session",
						status: "ok",
						transfer: { action: "transfer", toAgentId: params.toAgentId, resourceKey: lease.resourceKey, oldLeaseId: lease.leaseId, newLeaseId: handed.leaseId },
					});
				} catch (error) {
					if (!(error instanceof BrokerRequestError)) throw error;
					deps.trace()?.record({
						tool: "cu_session",
						status: error.code === "resource_busy" ? "lease_conflict" : "error",
						evidence: error.code,
						transfer: { action: "transfer", toAgentId: params.toAgentId, resourceKey: lease.resourceKey, oldLeaseId: lease.leaseId },
					});
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
