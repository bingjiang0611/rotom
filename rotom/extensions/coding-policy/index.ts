import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piRuntimeDriftDiagnosis } from "./pi-runtime-drift.ts";
import { toolErrorRepairHint } from "./repair-hints.ts";

export const CODING_EXECUTION_HYGIENE_POLICY = `Coding execution hygiene:
- Before the first code command or edit, establish the exact target Git repository root and effective cwd; never assume an aggregate launcher workspace is the target repository.
- Preflight every referenced file, directory, script, and the target package's actual package.json scripts before invoking a command that depends on them.
- After moving or renaming files, update all affected validation, test, and config paths before running those commands; never validate an obsolete path.
- Treat ripgrep exit 1 as “no matches”, distinct from exit 2, syntax errors, and I/O failures; do not retry or report infrastructure failure without stderr evidence.
- Before edit, read enough surrounding context to prove the intended match is unique; if it is ambiguous, narrow or re-read instead of issuing a broad replacement.
- After a timeout, inspect partial output, process state, command scope/cwd, and whether work is still progressing before deciding to retry; never blindly repeat the same command.`;

const CODING_TOOLS = new Set(["bash", "edit", "write"]);

export default function codingPolicy(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const selectedTools = Array.isArray(event.systemPromptOptions?.selectedTools) ? event.systemPromptOptions.selectedTools : [];
		if (!selectedTools.some((tool) => CODING_TOOLS.has(tool))) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${CODING_EXECUTION_HYGIENE_POLICY}` };
	});
	// Attach evidence to the two coding failures that otherwise dead-end into a
	// blind retry. The hint is additive: original tool output and isError stay.
	pi.on("tool_result", (event, ctx) => {
		if (!event.isError) return undefined;
		const hint = toolErrorRepairHint(event.toolName, event.input, event.content, ctx?.cwd);
		if (!hint) return undefined;
		return { content: [...event.content, { type: "text" as const, text: hint }] };
	});
	// Re-attribute the one runtime failure whose raw message names a file instead
	// of the cause. Everything else keeps its provider-reported error verbatim.
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
		if (!message || message.role !== "assistant" || message.stopReason !== "error") return undefined;
		const diagnosis = piRuntimeDriftDiagnosis(message.errorMessage);
		if (!diagnosis) return undefined;
		return { message: { ...event.message, errorMessage: diagnosis } };
	});
}
