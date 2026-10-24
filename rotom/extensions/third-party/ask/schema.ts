import { ASK_OPTION_CONTINUATION_DESCRIPTION } from "./continuation.ts";

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; [key: string]: unknown };

export class UnsupportedAskSchemaError extends Error {}

function node(value: unknown, type: "object" | "array", path: string): Schema {
	if (!value || typeof value !== "object" || Array.isArray(value) || (value as Schema).type !== type
		|| (type === "object" && (!(value as Schema).properties || typeof (value as Schema).properties !== "object" || Array.isArray((value as Schema).properties)))) {
		throw new UnsupportedAskSchemaError(`Unsupported ask_user_question schema at ${path}; expected ${type}. Continuation disabled; using the original Ask tool.`);
	}
	return value as Schema;
}

// Ask is a pinned external package, not an owned fork. Adapt only its validated
// shape; retain all validation and TypeBox metadata without mutating the source.
export function askContinuationParameters(parameters: unknown) {
	const base = node(parameters, "object", "parameters");
	const questions = node(base.properties!.questions, "array", "questions");
	const question = node(questions.items, "object", "questions.items");
	const options = node(question.properties!.options, "array", "options");
	const option = node(options.items, "object", "options.items");
	return { ...base, properties: { ...base.properties, questions: { ...questions, items: {
		...question, properties: { ...question.properties, options: { ...options, items: {
			...option, properties: { ...option.properties, continueExecution: { type: "boolean", description: ASK_OPTION_CONTINUATION_DESCRIPTION } },
		} } },
	} } } };
}
