import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import computerUse from "./node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts";
import askUserQuestion from "./node_modules/@juicesharp/rpiv-ask-user-question/index.ts";
import goal from "./node_modules/@narumitw/pi-goal/src/index.ts";
import subagents from "./node_modules/pi-subagents/index.ts";
import contextView from "./node_modules/pi-context-view/src/index.ts";
import { createSolPiExtension } from "./node_modules/sol-pi/src/sol-pi/index.ts";
import { ASK_AUTO_CONTINUATION_MESSAGE, ASK_CONTINUATION_GUIDELINE, createAskContinuationController, selectedOptionsRequireContinuation, stripAskContinuationMetadata } from "./ask/continuation.ts";
import { askContinuationParameters, UnsupportedAskSchemaError } from "./ask/schema.ts";
import { computerUseRecoveryApi } from "./computer-use/recovery.ts";
import { isDeferredByDefault, registerDeferredTools } from "./deferred-tools/register.ts";
import { loadRotomSolPiConfig } from "./sol-pi.ts";
import { subagentPolicyApi } from "./subagent/policy.ts";

function sequentialAskCompatApi(pi: ExtensionAPI, askContinuation: ReturnType<typeof createAskContinuationController>): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
				const sequential = { ...definition, executionMode: "sequential" as const };
				if (definition.name !== "ask_user_question") return target.registerTool(sequential);
				const execute = definition.execute.bind(definition);
				let parameters;
				try { parameters = askContinuationParameters(definition.parameters); }
				catch (error) {
					if (!(error instanceof UnsupportedAskSchemaError)) throw error;
					// Upstream schema drift disables only our optional continuation.
					// Keep the original schema/execute and let all later components load.
					const warning = error.message;
					target.on("session_start", (_event, ctx) => {
						if (ctx.hasUI) ctx.ui.notify(warning, "warning");
						else process.emitWarning(warning, { code: "ROTOM_ASK_SCHEMA" });
					});
					return target.registerTool(sequential);
				}
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
 * product. Owned forks define their own contracts; this layer selects product
 * surfaces and cross-component exposure. All packages remain version-pinned.
 */
export default function thirdPartyRuntime(pi: ExtensionAPI): void {
	// Interactive and lifecycle tools need a model/observation boundary, not a script batch.
	// The SDK applies explicit tool selections after registration, including codemode.
	const controlApi = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => target.registerTool(
				definition.name === "codemode"
					? { ...definition, defaultActive: true }
					: { ...definition, exposure: "model-only", ...(isDeferredByDefault(definition.name) ? { defaultActive: false } : {}) },
			);
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	createCodemodeExtension()(controlApi);
	computerUse(computerUseRecoveryApi(controlApi));
	subagents(subagentPolicyApi(controlApi), { surface: "ephemeral" });
	goal(controlApi);
	const askContinuation = createAskContinuationController();
	const sequentialAskCompat = sequentialAskCompatApi(controlApi, askContinuation);
	askUserQuestion(sequentialAskCompat);
	// SoL-Pi edit/write/obs_recall stay ordinary tools so Codemode can still call them.
	// SoL-Pi registers them on session_start, so its handler must run before the
	// deferred loader restores the startup capability state.
	createSolPiExtension(loadRotomSolPiConfig)(pi);
	contextView(pi);
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
