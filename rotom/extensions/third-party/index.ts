import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import computerUse from "./node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts";
import askUserQuestion from "./node_modules/@juicesharp/rpiv-ask-user-question/index.ts";
import goal from "./node_modules/@narumitw/pi-goal/src/index.ts";
import subagents from "./node_modules/pi-subagents/index.ts";
import { ASK_AUTO_CONTINUATION_MESSAGE, ASK_CONTINUATION_GUIDELINE, ASK_OPTION_CONTINUATION_DESCRIPTION, createAskContinuationController, selectedOptionsRequireContinuation, stripAskContinuationMetadata } from "./ask/continuation.ts";
import { computerUseRecoveryApi } from "./computer-use/recovery.ts";
import { registerDeferredTools } from "./deferred-tools/register.ts";
import { subagentPolicyApi } from "./subagent/policy.ts";

function sequentialAskCompatApi(pi: ExtensionAPI, askContinuation: ReturnType<typeof createAskContinuationController>): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
				const sequential = { ...definition, executionMode: "sequential" as const };
				if (definition.name !== "ask_user_question") return target.registerTool(sequential);
				const execute = definition.execute.bind(definition);
				const baseParameters = definition.parameters as any;
				const questionsSchema = baseParameters.properties?.questions ?? {};
				const questionSchema = questionsSchema.items ?? {};
				const optionsSchema = questionSchema.properties?.options ?? {};
				const optionSchema = optionsSchema.items ?? {};
				const parameters = {
					...baseParameters,
					properties: {
						...(baseParameters.properties ?? {}),
						questions: {
							...questionsSchema,
							items: {
								...questionSchema,
								properties: {
									...(questionSchema.properties ?? {}),
									options: { ...optionsSchema, items: { ...optionSchema, properties: { ...(optionSchema.properties ?? {}), continueExecution: { type: "boolean", description: ASK_OPTION_CONTINUATION_DESCRIPTION } } } },
								},
							},
						},
					},
				};
				return target.registerTool({
					...sequential,
					parameters,
					promptGuidelines: [...(definition.promptGuidelines ?? []), ASK_CONTINUATION_GUIDELINE],
					async execute(...args: Parameters<typeof definition.execute>) {
						const rawParams = args[1];
						const generation = askContinuation.beginAsk();
						const forwarded = [...args] as unknown[]; forwarded[1] = stripAskContinuationMetadata(rawParams);
						const result = await execute(...forwarded as Parameters<typeof definition.execute>);
						return askContinuation.afterAskResult(result, selectedOptionsRequireContinuation(result, rawParams), generation, args[2]);
					},
				});
			};
			if (property === "on") return (event: Parameters<ExtensionAPI["on"]>[0], handler: (...args: any[]) => unknown) => target.on(event as any, ((...args: any[]) => {
				const ctx = args[1];
				if (!ctx || ctx.hasUI) return handler(...args);
				const ui = new Proxy(ctx.ui, { get(uiTarget, uiProperty, uiReceiver) { if (uiProperty === "theme") return { fg: (_color: string, text: string) => text }; const uiValue = Reflect.get(uiTarget, uiProperty, uiReceiver); return typeof uiValue === "function" ? uiValue.bind(uiTarget) : uiValue; } });
				return handler(args[0], new Proxy(ctx, { get(ctxTarget, ctxProperty, ctxReceiver) { if (ctxProperty === "ui") return ui; const ctxValue = Reflect.get(ctxTarget, ctxProperty, ctxReceiver); return typeof ctxValue === "function" ? ctxValue.bind(ctxTarget) : ctxValue; } }));
			}) as any);
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * One explicit composition root for the third-party runtime selected by the
 * product. Package code remains unmodified and version-pinned by the launcher.
 */
export default function thirdPartyRuntime(pi: ExtensionAPI): void {
	computerUse(computerUseRecoveryApi(pi));
	subagents(subagentPolicyApi(pi));
	goal(pi);
	const askContinuation = createAskContinuationController();
	const sequentialAskCompat = sequentialAskCompatApi(pi, askContinuation);
	askUserQuestion(sequentialAskCompat);
	registerDeferredTools(pi);
	pi.on("tool_call", (event) => askContinuation.onToolCall(event.toolName));
	pi.on("session_start", () => askContinuation.reset());
	pi.on("session_shutdown", () => askContinuation.reset());
	pi.on("session_tree", () => askContinuation.reset());
	pi.on("agent_end", (event, ctx) => {
		if (!askContinuation.onAgentEnd(event.messages, ctx.signal)) return;
		pi.sendMessage({ customType: "ask-user-continuation", content: ASK_AUTO_CONTINUATION_MESSAGE, display: false }, { deliverAs: "followUp", triggerTurn: true });
	});
}
