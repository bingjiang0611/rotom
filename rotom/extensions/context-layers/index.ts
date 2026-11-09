import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildView, search, RECALL_TOOL, type View } from "./blocks.ts";
import { recall } from "./recall.ts";
import { COPY } from "./copy.ts";

const json = (details: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(details) }],
	details,
});
const viewOf = (ctx: ExtensionContext): View =>
	buildView(ctx.sessionManager.getBranch(), ctx.sessionManager.buildSessionProjection());

export default function contextLayers(pi: ExtensionAPI): void {
	// Existing context_edit entries continue to be projected by Pi when opted out.
	// No tools are installed in that mode, so history is not searchable through us.
	if (process.env.ROTOM_CONTEXT_LAYERS === "0") return;
	pi.registerTool({
		executionMode: "sequential",
		exposure: "model-only",
		name: RECALL_TOOL,
		label: COPY.recallLabel,
		description: COPY.recallDescription,
		promptSnippet: COPY.recallDescription,
		promptGuidelines: [...COPY.guidelines],
		parameters: Type.Object(
			{
				query: Type.Optional(Type.String({ minLength: 1 })),
				ref: Type.Optional(Type.String({ minLength: 1 })),
				mode: Type.Optional(Type.Union([Type.Literal("one"), Type.Literal("full")])),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, args, signal, _update, ctx) {
			signal?.throwIfAborted();
			const { query, ref } = args;
			if ((query === undefined) === (ref === undefined)) throw new Error(COPY.selector);
			if (query !== undefined) {
				if (args.mode !== undefined) throw new Error(COPY.modeWithQuery);
				return json(search(viewOf(ctx), query, args.offset ?? 0));
			}
			return recall(viewOf(ctx), ref as string, args.mode ?? "one", args.offset ?? 0, ctx.model?.input.includes("image") === true);
		},
	});
}
