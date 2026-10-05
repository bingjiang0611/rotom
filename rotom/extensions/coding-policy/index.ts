import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piRuntimeDriftDiagnosis } from "./pi-runtime-drift.ts";
import { toolErrorRepairHint } from "./repair-hints.ts";

export const CODING_EXECUTION_HYGIENE_POLICY = `Coding execution hygiene:
- Before the first code command or edit, establish the exact target Git repository root and effective cwd; never assume an aggregate launcher workspace is the target repository.
- Preflight every referenced file, directory, script, and the target package's actual package.json scripts before invoking a command that depends on them.
- After moving or renaming files, update all affected validation, test, and config paths before running those commands; never validate an obsolete path.
- Treat ripgrep exit 1 as “no matches”, distinct from exit 2, syntax errors, and I/O failures; do not retry or report infrastructure failure without stderr evidence.
- Before edit, read enough surrounding context to prove the intended match is unique; if it is ambiguous, narrow or re-read instead of issuing a broad replacement.
- After a timeout, inspect partial output, process state, command scope/cwd, and whether work is still progressing before deciding to retry; never blindly repeat the same command.
- Scope completion claims to the verified scenario and artifact/version: report evidence, unverified cases/limits, and commit/install/push status separately when applicable. A build, passing short fixture, tool dispatch, or earlier version's test does not prove the current end-to-end workflow; unproven business outcomes remain unknown. Do not execute extra external actions merely to fill this report.
- Distinguish full-file parsing, full-content reading, and targeted sampling. A parsed record count, summary, head/tail excerpt, or first recalled page is not a full read; complete the source's pagination before claiming full-content coverage, otherwise state the inspected scope.`;

const CODING_TOOLS = new Set(["bash", "edit", "write"]);

// Some tool hosts compose a file write with then_run and return only one error
// bit. Project their exact leading receipt, never test output or arbitrary prose.
// This is reported execution evidence, not a file readback or business success.
export function codingResultPhases(event: { toolName: string; input: Record<string, unknown>; content: readonly unknown[]; isError: boolean }) {
	const { toolName, input } = event;
	if ((toolName !== "edit" && toolName !== "write") || typeof input.path !== "string"
		|| !input.then_run || typeof input.then_run !== "object") return undefined;
	const first = event.content[0] as { type?: string; text?: string } | undefined;
	if (first?.type !== "text" || typeof first.text !== "string") return undefined;
	const receipt = toolName === "edit" && Array.isArray(input.edits) && input.edits.length > 0
		? `Successfully replaced ${input.edits.length} block(s) in ${input.path}.`
		: toolName === "write" ? `Successfully wrote to ${input.path}` : undefined;
	if (!receipt) return undefined;
	const followup = event.isError ? "failed" : "succeeded";
	if (!first.text.startsWith(`${receipt}\n\n[then_run:${followup}]\n`)) return undefined;
	return { mutation: "applied" as const, followup, source: "tool-reported" as const };
}

export default function codingPolicy(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const selectedTools = Array.isArray(event.systemPromptOptions?.selectedTools) ? event.systemPromptOptions.selectedTools : [];
		if (!selectedTools.some((tool) => CODING_TOOLS.has(tool))) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${CODING_EXECUTION_HYGIENE_POLICY}` };
	});
	// Attach evidence to the two coding failures that otherwise dead-end into a
	// blind retry. The hint is additive: original tool output and isError stay.
	pi.on("tool_result", (event, ctx) => {
		const phases = codingResultPhases(event);
		if (phases) return {
			details: { ...event.details, codingPhases: phases },
			...(phases.followup === "failed" ? { content: [...event.content, { type: "text" as const, text: "The tool reports that the file mutation was applied; only then_run failed. Inspect the command error and current file. Do not replay the successful mutation or treat it as rolled back. Command exit status is not business verification." }] } : {}),
		};
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
