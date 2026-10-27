import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiCodingAgentInput, PiCodingAgentStep } from "./pi-harness.ts";

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const candidate = part as Record<string, unknown>;
			return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
		})
		.join("");
}

export function normalizeSteps(input: PiCodingAgentInput): PiCodingAgentStep[] {
	if (typeof input === "string") return [{ type: "prompt", content: input }];
	return Array.isArray(input) ? input : input.steps;
}

// Distinguish a persisted incomplete response from setup, grading or cleanup failures.
export class IncompleteAssistantResponseError extends Error {}

export function latestAssistantResponse(session: AgentSession, previousEntryCount: number, allowEmpty = false): string {
	const assistant = session.sessionManager.getBranch()
		.slice(previousEntryCount)
		.reverse()
		.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [])[0];
	if (!assistant) throw new Error("Agent run completed without an assistant message.");
	if (assistant.stopReason !== "stop") {
		throw new IncompleteAssistantResponseError(assistant.errorMessage ?? `Agent run ended with unexpected stop reason: ${assistant.stopReason}.`);
	}
	const output = contentText(assistant.content);
	if (!output && !allowEmpty) throw new Error("Agent run produced no assistant text.");
	return output;
}

export function createCustomMessageWaiter(session: AgentSession, customType: string) {
	let received = false;
	let notify: (() => void) | undefined;
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "message_end" || event.message.role !== "custom" || event.message.customType !== customType) return;
		received = true;
		notify?.();
	});
	return {
		async wait(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
			if (received) return;
			await new Promise<void>((resolveWait, rejectWait) => {
				const cleanup = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					notify = undefined;
				};
				const onAbort = () => {
					cleanup();
					rejectWait(signal?.reason ?? new Error("Eval custom-message wait aborted."));
				};
				const timer = setTimeout(() => {
					cleanup();
					rejectWait(new Error(`Timed out waiting for custom message ${customType} after ${String(timeoutMs)}ms.`));
				}, timeoutMs);
				notify = () => {
					cleanup();
					resolveWait();
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
		cancel(): void {
			unsubscribe();
			notify = undefined;
		},
	};
}

export async function promptAgent(session: AgentSession, input: string, signal: AbortSignal | undefined, allowEmpty = false,
	continuePrompt?: () => string | undefined | Promise<string | undefined>): Promise<string> {
	let next: string | undefined = input;
	let response = "";
	while (next !== undefined) {
		signal?.throwIfAborted();
		const previousEntryCount = session.sessionManager.getBranch().length;
		await session.prompt(next);
		await session.waitForIdle();
		response = latestAssistantResponse(session, previousEntryCount, allowEmpty);
		if (!continuePrompt) break;
		signal?.throwIfAborted();
		next = await continuePrompt();
	}
	return response;
}
