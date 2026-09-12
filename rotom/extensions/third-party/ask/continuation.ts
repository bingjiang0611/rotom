export const ASK_CONTINUATION_GUIDELINE = "When an ask_user_question option means 'continue the pending task with more tool work', set that option's continueExecution field to true. After the user selects such an option, continue in the same agent run and call the next required tool before final text. Leave continueExecution false or omitted for preferences, refusal/stop options, or choices that can be completed directly in text.";
export const ASK_CONTINUATION_RESULT = "Continuation requirement: execute the selected path now. Do not end with only an acknowledgment or plan; call the next required tool before finalizing unless the selected path is blocked.";
export const ASK_AUTO_CONTINUATION_MESSAGE = "The user selected an option explicitly marked as requiring continued tool execution, but no next tool was called. Continue the selected path now and use the next required tool immediately; do not reply with another acknowledgment or plan.";
export const ASK_OPTION_CONTINUATION_DESCRIPTION = "Set true only when selecting this exact option requires the agent to continue the current task with one or more tool calls. Leave false/omitted for preferences, refusal/stop choices, or options answerable directly in text.";

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function hasAnsweredAsk(result: unknown): boolean {
	return record(result) && record(result.details) && result.details.cancelled === false && Array.isArray(result.details.answers) && result.details.answers.length > 0;
}

export function enforceAskContinuationResult<T>(result: T): T {
	if (!hasAnsweredAsk(result) || !record(result) || !Array.isArray(result.content)) return result;
	let appended = false;
	const content = result.content.map((item) => {
		if (appended || !record(item) || item.type !== "text" || typeof item.text !== "string") return item;
		appended = true;
		return { ...item, text: `${item.text}\n\n${ASK_CONTINUATION_RESULT}` };
	});
	return { ...result, content } as T;
}

export function selectedOptionsRequireContinuation(result: unknown, params: unknown): boolean {
	if (!hasAnsweredAsk(result) || !record(result) || !record(result.details) || !Array.isArray(result.details.answers) || !record(params) || !Array.isArray(params.questions)) return false;
	for (const answer of result.details.answers) {
		if (!record(answer) || !Number.isInteger(answer.questionIndex)) continue;
		const question = params.questions[answer.questionIndex as number];
		if (!record(question) || !Array.isArray(question.options)) continue;
		const selected = new Set<string>();
		if (typeof answer.answer === "string") selected.add(answer.answer);
		if (Array.isArray(answer.selected)) for (const label of answer.selected) if (typeof label === "string") selected.add(label);
		if (question.options.some((option) => record(option) && option.continueExecution === true && typeof option.label === "string" && selected.has(option.label))) return true;
	}
	return false;
}

export function stripAskContinuationMetadata(params: unknown): unknown {
	if (!record(params) || !Array.isArray(params.questions)) return params;
	return {
		...params,
		questions: params.questions.map((question) => {
			if (!record(question) || !Array.isArray(question.options)) return question;
			return {
				...question,
				options: question.options.map((option) => {
					if (!record(option)) return option;
					const { continueExecution: _continueExecution, ...packageOption } = option;
					return packageOption;
				}),
			};
		}),
	};
}

export function createAskContinuationController() {
	let armed = false;
	let generation = 0;
	const reset = () => { armed = false; generation += 1; };
	return {
		reset,
		beginAsk(): number { reset(); return generation; },
		afterAskResult<T>(result: T, continueExecution: boolean, askGeneration: number, signal?: AbortSignal): T {
			// A cancelled or old-session dialog may still resolve; it cannot re-arm work.
			if (askGeneration !== generation || signal?.aborted) return result;
			armed = continueExecution && hasAnsweredAsk(result);
			// The model-facing instruction and the fallback must share the same
			// explicit intent. A stop/preference answer must not demand more work.
			return armed ? enforceAskContinuationResult(result) : result;
		},
		onToolCall(toolName: string): void { if (armed && toolName !== "ask_user_question") armed = false; },
		onAgentEnd(messages: readonly unknown[], signal?: AbortSignal): boolean {
			const pending = armed;
			reset();
			// This fallback repairs an acknowledgment-only finish, never a retry,
			// cancellation or Goal safety stop. Do not infer intent from error text.
			const lastAssistant = messages.findLast((message) => record(message) && message.role === "assistant");
			return pending && !signal?.aborted && record(lastAssistant) && lastAssistant.stopReason === "stop";
		},
	};
}
