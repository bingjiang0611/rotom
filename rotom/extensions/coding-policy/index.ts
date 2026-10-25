import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyEditError } from "./edit-error-code.mjs";
import { piRuntimeDriftDiagnosis } from "./pi-runtime-drift.ts";
import { textOf, toolErrorRepairHint } from "./repair-hints.ts";

export const CODING_EXECUTION_HYGIENE_POLICY = `Coding execution hygiene:
- Before the first code command or edit, establish the exact target Git repository root and effective cwd; never assume an aggregate launcher workspace is the target repository. Reuse that evidence until cwd or repository changes.
- Preflight every referenced file, directory and the target package's actual package.json scripts by locating them before dependent commands; do not guess paths or script names. Reuse observed paths unless moves, deletions, branch changes or failed generation invalidate them.
- After moving or renaming files, update all affected validation, test, and config paths before running those commands; never validate an obsolete path.
- Treat ripgrep exit 1 as “no matches”, distinct from exit 2, syntax errors, and I/O failures; do not retry or report infrastructure failure without stderr evidence.
- Before edit, read enough surrounding context to prove the intended match is unique; if it is ambiguous, narrow or re-read instead of issuing a broad replacement. After a rejected edit, use its block index/location hint to read current text and rebuild the match, not replay stale oldText.
- After a timeout, inspect partial output, process state, command scope/cwd, and whether work is still progressing before deciding to retry; never blindly repeat the same command. A failed response may follow a successful write: inspect the original target, and never replay an applied mutation merely because its follow-up check failed.
- Keep output proportional to the question: inspect large diffs by changed file after a file/stat overview; query only relevant processes and aggregate counts/resource use, not whole-machine command arguments. For noisy checks, retain the full log and return status plus a bounded excerpt; read the relevant failure region before diagnosing. Preserve exit status when filtering output; a successful filter is not a successful check.
- Scope completion claims to the verified scenario and artifact/version: report evidence, unverified cases/limits, and commit/install/push status separately when applicable. A build, passing short fixture, tool dispatch, or earlier version's test does not prove the current end-to-end workflow; unproven business outcomes remain unknown. Do not execute extra external actions merely to fill this report.
- Distinguish full-file parsing, full-content reading, and targeted sampling. A parsed record count, summary, head/tail excerpt, or first recalled page is not a full read; complete the source's pagination before claiming full-content coverage, otherwise state the inspected scope.`;

// Users saw turns end at the first plausible explanation: a list of "not yet
// determined" gaps that available tools could have closed, and no next step.
// The evidence rules above say what not to claim; this says when not to stop.
export const FOLLOW_THROUGH_POLICY = `Investigation follow-through:
- The user's goal is the finish line, not the first plausible explanation. This applies to investigations and tasks, not to simple questions answered directly. Before ending a turn, put every open question into one bucket: resolved with evidence; checkable now with available tools inside the request, so check it now instead of listing it; or blocked, naming what was tried and the exact access, system, or decision that is missing.
- "Not yet determined", "possibly A or B", or "only read the beginning" is not a conclusion when a read, search, query, or run available now could decide it. Follow the call chain, data, and config to the deciding evidence, and read the rest of any source the conclusion depends on.
- Keep going through next steps the request already covers, including edits and tests when the user asked for a change. A standing instruction such as "don't stop until it is done" covers every step needed to finish, across turns and after compaction, until the user revokes it or the work is done. A status question or a finished milestone does not revoke it: answer briefly, then keep working. Stop and ask only for decisions the user owns, missing access, or actions the request did not authorize, such as external writes, deploys, cost, or data loss; existing authorization and unknown-result rules still apply.
- Something remains open when a diagnosed bug is not fixed yet, even if the user asked only for diagnosis or said not to edit yet (then offer the fix and wait for approval), a plan has open or pending-confirmation items, or an item is blocked. Each open item needs one concrete owner and action, a specific question for the user or the action you propose next; never end with a list of gaps that has no owner.`;

// Distilled from final reports users found clear: outcome first, then what
// changed, what was and was not verified, and what is left. Kept separate from
// the hygiene constant because evals parse that one as flat rule bullets.
export const FINAL_REPORT_POLICY = `Final report:
- A final report ends your turn. Write it only when the request is done or the remaining work needs the user: a decision they own, missing access, or an action the request did not authorize. When the next step is yours and the request already covers it, do that step instead of reporting it.
- Scale the final message to the work. Answer a simple question directly. After work that changed files or state, investigated a problem, or ran verification, write a structured report. Concise means no filler and no repetition; it does not mean omitting changes, evidence, gaps, or decisions the user needs.
- Open with one or two sentences: the outcome and how far it is verified, for example "tests pass; not yet verified on the real device".
- Then use short bold-labeled sections in this order, and only those that have content:
  - What changed: each change with its purpose, its user-visible effect, and the files or modules involved.
  - Verification: the checks actually run and their results, with commands, counts, and environment or version. Say what new tests cover. When available, report a control showing the check can fail, such as the test failing with the fix reverted. Report failures unrelated to this change separately, with the evidence that they are unrelated.
  - Not verified / known limitations: each untested path, accepted limitation, open risk, or unresolved issue, with the reason and what would verify or fix it. Label conclusions from code reading or inference as unverified.
  - Final state: commit, push, install, or deploy status, and any processes, temporary resources, or logs left behind.
  - Needs your decision / next steps: required, and last, whenever anything remains open or the user's goal still needs work, such as an unfixed diagnosed bug, open plan items, or a blocked item. Give one concrete question or proposed action and say whether it needs approval. Do not list a step you can do now under authorization you already have; do it first. Omit it only when the goal is fully done.
- Use a table (item | result | evidence) when three or more checks or items share the same fields.
- Use plain language: short sentences, one point each, consistent terms, and explain project jargon on first use. Do not add empty sections, generic caveats, or restated instructions.`;

const CODING_TOOLS = new Set(["bash", "edit", "write"]);

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * A failed edit carries its cause only in message text, which the trace must not
 * record. Translate it to a fixed enum code and leave the text untouched; an
 * unclassified message keeps no code so `(none)` stays honest.
 */
export function editFailureCode(event: { toolName: string; details?: unknown; content?: readonly unknown[] }): string | undefined {
	if (event.toolName !== "edit") return undefined;
	const existing = recordOf(event.details);
	if (typeof existing?.code === "string" && existing.code) return undefined;
	return classifyEditError(textOf(event.content));
}

// Read the producer's versioned evidence, never infer effects from display text.
// Tool-reported execution evidence is not file readback or business verification.
export function codingResultPhases(event: { toolName: string; input: Record<string, unknown>; details?: unknown; isError: boolean }) {
	const { toolName, input } = event;
	if ((toolName !== "edit" && toolName !== "write") || !input.then_run) return undefined;
	const phases = (event.details as { actionFusion?: { version?: unknown; mutation?: unknown; followup?: unknown } } | undefined)?.actionFusion;
	if (phases?.version !== 1 || phases.mutation !== "applied"
		|| (phases.followup !== "succeeded" && phases.followup !== "failed" && phases.followup !== "skipped")
		|| event.isError !== (phases.followup !== "succeeded")) return undefined;
	return { mutation: "applied" as const, followup: phases.followup, source: "tool-reported" as const };
}

export default function codingPolicy(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		const selectedTools = Array.isArray(event.systemPromptOptions?.selectedTools) ? event.systemPromptOptions.selectedTools : [];
		if (!selectedTools.some((tool) => CODING_TOOLS.has(tool))) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${CODING_EXECUTION_HYGIENE_POLICY}\n\n${FOLLOW_THROUGH_POLICY}\n\n${FINAL_REPORT_POLICY}` };
	});
	// Attach evidence to the two coding failures that otherwise dead-end into a
	// blind retry. The hint is additive: original tool output and isError stay.
	pi.on("tool_result", (event, ctx) => {
		const phases = codingResultPhases(event);
		if (phases) return {
			details: { ...event.details, codingPhases: phases },
			...(phases.followup !== "succeeded" ? { content: [...event.content, { type: "text" as const, text: "The tool reports that the file mutation was applied; then_run failed or was skipped. Inspect the command error and current file. Do not replay the successful mutation or treat it as rolled back. Command exit status is not business verification." }] } : {}),
		};
		if (!event.isError) return undefined;
		// The code and the hint are independent: the code makes past and future
		// failures countable, the hint stays the existing repairable evidence.
		const code = editFailureCode(event);
		const hint = toolErrorRepairHint(event.toolName, event.input, event.content, ctx?.cwd);
		if (!code && !hint) return undefined;
		return {
			...(code ? { details: { ...recordOf(event.details), code } } : {}),
			...(hint ? { content: [...event.content, { type: "text" as const, text: hint }] } : {}),
		};
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
