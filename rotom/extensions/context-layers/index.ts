import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { buildView, candidates, commitDrafts, planCompression, search, status, TOOLS, type Plan } from "./blocks.ts";
import { recall } from "./recall.ts";
import { COPY } from "./copy.ts";

const RECEIPT = "rotom-context-layers/receipt-v1";
const json = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
const viewOf = (ctx: ExtensionContext) => buildView(ctx.sessionManager.getBranch(), ctx.sessionManager.buildSessionProjection());

export default function contextLayers(pi: ExtensionAPI): void {
  // Existing context_edit entries continue to be projected by Pi when opted out.
  // No tools, reminders or additional writes are installed in that mode.
  if (process.env.ROTOM_CONTEXT_LAYERS === "0") return;
  let pending: Plan[] = [];
  let sessionId: string | undefined;
  let lastNudgeTokens = 0;
  function reset(_event: unknown, ctx: ExtensionContext) {
    pending = []; lastNudgeTokens = 0; sessionId = ctx.sessionManager.getSessionId();
  }
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);
  pi.on("session_shutdown", reset);
  function current(ctx: ExtensionContext) {
    if (sessionId !== ctx.sessionManager.getSessionId()) reset(undefined, ctx);
    return viewOf(ctx);
  }
  const base = { executionMode: "sequential" as const, exposure: "model-only" as const };
  pi.registerTool({
    ...base, name: TOOLS[0], label: COPY.statusLabel, description: COPY.statusDescription,
    promptSnippet: COPY.statusDescription, promptGuidelines: [...COPY.guidelines],
    parameters: Type.Object({ query: Type.Optional(Type.String({ minLength: 1 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      const view = current(ctx);
      const receipt = view.branch.findLast(e => e.type === "custom" && e.customType === RECEIPT);
      return json({ usage: ctx.getContextUsage() ?? null, tokenSource: "estimate", queued: pending.map(p => p.block.id),
        lastReceipt: receipt?.type === "custom" ? receipt.data : null,
        ...(args.query ? search(view, args.query, args.offset ?? 0) : status(view, estimateTokens, args.offset ?? 0)) });
    },
  });
  pi.registerTool({
    ...base, name: TOOLS[1], label: COPY.compressLabel, description: COPY.compressDescription,
    parameters: Type.Object({
      start: Type.Optional(Type.String({ minLength: 1 })), end: Type.Optional(Type.String({ minLength: 1 })),
      blocks: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })), summary: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
    async execute(_callId, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      const view = current(ctx);
      const plan = planCompression(view, args, estimateTokens, `b-${randomUUID()}`);
      if (pending.some(p => p.block.covered.some(id => plan.block.covered.includes(id)))) throw new Error(COPY.overlap);
      pending.push(plan);
      return { content: [{ type: "text" as const, text: COPY.queued(plan.block.id) }],
        details: { state: "queued", block: plan.block.id, estimatedTokensBefore: plan.block.before, estimatedTokensAfter: plan.block.after } };
    },
  });
  pi.registerTool({
    ...base, name: TOOLS[2], label: COPY.recallLabel, description: COPY.recallDescription,
    parameters: Type.Object({
      ref: Type.String({ minLength: 1 }), mode: Type.Optional(Type.Union([Type.Literal("one"), Type.Literal("full")])),
      offset: Type.Optional(Type.Integer({ minimum: 0 })), query: Type.Optional(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      return recall(current(ctx), args.ref, args.mode ?? "one", args.offset ?? 0, ctx.model?.input.includes("image") === true, args.query);
    },
  });
  pi.on("turn_end", (event, ctx) => {
    if (!pending.length) return;
    const plans = pending; pending = [];
    const entries: SessionBoundaryDraft[] = [...event.entries];
    const outcomes: { block: string; state: string; reason?: string }[] = [];
    const view = current(ctx);
    for (const plan of plans) {
      try {
        if (event.outcome !== "completed" || ctx.signal?.aborted) throw new Error(COPY.cancelled);
        // A prior boundary handler may have proposed a compaction or edit. Do not
        // race that proposal against a snapshot taken by the tool earlier.
        if (event.entries.some(e => e.type === "compaction" || e.type === "context_edit" && plan.block.covered.includes(e.targetId))) throw new Error(COPY.stale);
        planCompression(view, plan.selection, estimateTokens, plan.block.id);
        entries.push(...commitDrafts(view, plan));
        outcomes.push({ block: plan.block.id, state: "applied" });
      } catch (error) {
        outcomes.push({ block: plan.block.id, state: "not-applied", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // Start the next growth interval from the smaller projected context, rather
    // than waiting to exceed the old high-water mark and hitting native compaction.
    if (outcomes.some(outcome => outcome.state === "applied")) lastNudgeTokens = 0;
    // This receipt is after all edits: it is not a pre-dispatch success promise.
    entries.push({ type: "custom", customType: RECEIPT, data: { outcomes } });
    return { entries };
  });
  pi.on("context", (event, ctx) => {
    if (!TOOLS.every(name => pi.getActiveTools().includes(name))) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || usage.percent === null || usage.percent < 30) return;
    const growth = Math.max(1024, usage.contextWindow * 0.05);
    if (lastNudgeTokens && usage.tokens - lastNudgeTokens < growth) return;
    const view = current(ctx);
    const available = candidates(view, estimateTokens).reduce((n, r) => n + r.estimatedTokens, 0);
    if (available < 1024 && [...view.states.values()].filter(s => s === "active").length < 2) return;
    lastNudgeTokens = usage.tokens;
    return { messages: [...event.messages, { role: "custom" as const, customType: "rotom-context-layers/nudge", content: COPY.nudge(Math.round(usage.percent)), display: false, timestamp: Date.now() }] };
  });
}
