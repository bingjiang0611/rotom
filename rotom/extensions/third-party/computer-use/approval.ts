import type { ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { loadQuestionnaireSession } from "../node_modules/@juicesharp/rpiv-ask-user-question/ask-user-question.ts";
import { approvalDialogCopy } from "./constants/copy.ts";

/** Use Ask's actual questionnaire and overlay, without invoking its model-only tool. */
export async function selectComputerUseApproval(
	ctx: ExtensionContext,
	title: string,
	options: string[],
	opts?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	// RPC has no terminal overlay. Keep its existing dialog protocol, as Ask does.
	if (ctx.mode === "rpc") return ctx.ui.select(title, options, opts);
	const deadline = opts?.timeout === undefined ? Infinity : Date.now() + opts.timeout;
	const expired = () => opts?.signal?.aborted === true || Date.now() >= deadline;
	if (expired()) return undefined;
	const loaded = await loadQuestionnaireSession();
	if (expired()) return undefined;
	if (!loaded.ok) throw new Error(approvalDialogCopy.unavailable);

	let close: (() => void) | undefined;
	const cancel = () => close?.();
	const timer = Number.isFinite(deadline) ? setTimeout(cancel, Math.max(0, deadline - Date.now())) : undefined;
	opts?.signal?.addEventListener("abort", cancel, { once: true });
	try {
		const answer = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
			let settled = false;
			const finish = (choice?: string) => {
				if (settled) return;
				settled = true;
				done(expired() ? undefined : choice);
			};
			close = () => finish();
			const question = {
				question: title,
				header: approvalDialogCopy.header,
				options: options.map((label) => ({ label, description: "" })),
			};
			const session = new loaded.module.QuestionnaireSession({
				tui, theme, keybindings,
				params: { questions: [question] },
				// Permission decisions are closed choices: never offer a free-text grant.
				itemsByTab: [options.map((label) => ({ kind: "option" as const, label, description: "" }))],
				collapseKey: "off",
				editInput: async () => undefined,
				done(result) {
					const selected = result.answers[0];
					finish(!result.cancelled && selected?.kind === "option" && typeof selected.answer === "string" && options.includes(selected.answer)
						? selected.answer : undefined);
				},
			});
			if (expired()) finish();
			return session.component;
		}, {
			overlay: true,
			overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: { left: 0, right: 0, bottom: 0 } },
		});
		return expired() ? undefined : answer;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		opts?.signal?.removeEventListener("abort", cancel);
	}
}

function approvalContext<T extends ExtensionContext>(ctx: T): T {
	return new Proxy(ctx, {
		get(target, property, receiver) {
			if (property !== "ui") return Reflect.get(target, property, receiver);
			// Preserve the host's live UI getter and inactive-context check.
			return new Proxy(target.ui, {
				get(ui, key, uiReceiver) {
					if (key === "select") return (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
						selectComputerUseApproval(ctx, title, options, opts);
					const member = Reflect.get(ui, key, uiReceiver);
					return typeof member === "function" ? member.bind(ui) : member;
				},
			});
		},
	});
}

/** Scope the UI adapter to Computer Use, including its session-start broker callback. */
export function computerUseApprovalApi(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "on") return (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				Reflect.apply(target.on, target, [event, (event: unknown, ctx: ExtensionContext) => handler(event, approvalContext(ctx))]);
			if (property === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => target.registerTool({
				...definition,
				execute(toolCallId, params, signal, onUpdate, ctx) {
					return definition.execute(toolCallId, params, signal, onUpdate, approvalContext(ctx));
				},
			});
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
