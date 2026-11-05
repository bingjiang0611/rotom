import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** A capability the platform does not provide: reported, never faked. */
export function unsupportedToolResult(tool: string, action: string, message: string): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text: `${tool} ${action} is unavailable: ${message}` }], details: { tool, action, status: "unsupported" } };
}

/** Invalid arguments the model can fix; nothing was dispatched. */
export function toolProblem(tool: string, message: string): AgentToolResult<Record<string, unknown>> {
	return { content: [{ type: "text", text: `${tool}: ${message}` }], details: { tool, status: "invalid_args", message } };
}
