import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionProjection, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { COPY } from "./copy.ts";

export const BLOCK_ENTRY = "rotom-context-layers/block-v1";
export const TOOLS = ["context_status", "context_compress", "context_recall"] as const;
export type Estimate = (message: AgentMessage) => number;
export interface Block {
  version: 1;
  id: string;
  tier: number;
  carrier: string;
  direct: string[];
  covered: string[];
  children: string[];
  replaces?: string;
  summary: string;
  before: number;
  after: number;
}
export interface Unit {
  ref: string;
  ids: string[];
  messages: AgentMessage[];
  eligible: boolean;
  block?: Block;
}
export interface View {
  branch: SessionEntry[];
  projection: SessionProjection;
  blocks: Map<string, Block>;
  states: Map<string, "active" | "superseded" | "archived" | "partial">;
  units: Unit[];
}
export interface Selection { start?: string; end?: string; blocks?: string[]; summary: string }
export interface Plan { block: Block; targets: string[]; fingerprint: string; selection: Selection }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === "string");
export function rendered(block: Block): string { return COPY.summary(block.id, block.tier, block.summary); }
function text(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
}
export function readBlocks(branch: SessionEntry[]): Map<string, Block> {
  const blocks = new Map<string, Block>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== BLOCK_ENTRY) continue;
    const b = entry.data as Block;
    if (!b || b.version !== 1 || typeof b.id !== "string" || typeof b.carrier !== "string" ||
      ![1, 2, 3].includes(b.tier) || typeof b.summary !== "string" || !strings(b.direct) ||
      !strings(b.covered) || !strings(b.children) || b.covered.length === 0 ||
      !b.covered.includes(b.carrier) || blocks.has(b.id) ||
      b.children.some(id => !blocks.has(id)) || (b.replaces !== undefined && !blocks.has(b.replaces))) throw new Error(COPY.corrupt);
    blocks.set(b.id, b);
  }
  return blocks;
}
function closed(messages: AgentMessage[]): boolean {
  const calls = new Map<string, string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      if (m.stopReason === "error" || m.stopReason === "aborted") return false;
      for (const p of m.content) if (p.type === "toolCall") {
        if (calls.has(p.id)) return false;
        calls.set(p.id, p.name);
      }
    }
    if (m.role === "toolResult") {
      if (calls.get(m.toolCallId) !== m.toolName || results.has(m.toolCallId)) return false;
      results.add(m.toolCallId);
    }
  }
  return calls.size === results.size;
}
export function buildView(branch: SessionEntry[], projection: SessionProjection): View {
  const blocks = readBlocks(branch);
  const visible = new Map(projection.entries.map(e => [e.sourceEntry.id, e.messages]));
  const states: View["states"] = new Map();
  const superseded = new Set([...blocks.values()].flatMap(b => [...b.children, ...(b.replaces ? [b.replaces] : [])]));
  const activeCarriers = new Map<string, Block>();
  for (const b of blocks.values()) {
    const carrier = visible.get(b.carrier) ?? [];
    const state = superseded.has(b.id) ? "superseded" : carrier.length === 0 ? "archived" :
      carrier.length === 1 && text(carrier[0]) === rendered(b) && b.covered.every(id => id === b.carrier || !(visible.get(id)?.length)) ? "active" : "partial";
    states.set(b.id, state);
    if (state === "active") activeCarriers.set(b.carrier, b);
  }
  const owned = new Set([...blocks.values()].flatMap(b => b.covered));
  const edited = new Set(branch.filter(e => e.type === "context_edit").map(e => e.targetId));
  const units: Unit[] = [];
  for (const entry of projection.entries) {
    if (!entry.messages.length) continue;
    const id = entry.sourceEntry.id;
    const block = activeCarriers.get(id);
    const message = entry.messages[0];
    if (message.role === "system") continue; // Prompt/tool state is never folded.
    const previous = units.at(-1);
    if (!block && message.role === "toolResult" && previous && !previous.block && previous.messages[0].role === "assistant") {
      previous.ids.push(id);
      previous.messages.push(...entry.messages);
      previous.eligible &&= !owned.has(id) && !edited.has(id);
    } else {
      const editable = entry.sourceEntry.type === "message" && ["user", "assistant"].includes(message.role);
      units.push({ ref: block?.id ?? `@${id}`, ids: [id], messages: entry.messages, block,
        eligible: !block && editable && !owned.has(id) && !edited.has(id) });
    }
  }
  const latestUser = units.findLastIndex(u => u.messages.some(m => m.role === "user"));
  const firstUser = units.findIndex(u => u.messages.some(m => m.role === "user"));
  units.forEach((u, index) => {
    // Keep the task anchor, latest request, and last four complete/in-flight steps.
    if (index === latestUser || index === firstUser || index >= units.length - 4 || !closed(u.messages)) u.eligible = false;
  });
  return { branch, projection, blocks, states, units };
}
export function candidates(view: View, estimate: Estimate) {
  const ranges: { start: string; end: string; steps: number; estimatedTokens: number; preview: string }[] = [];
  let group: Unit[] = [];
  const flush = () => {
    if (group.length) ranges.push({ start: group[0].ref, end: group.at(-1)!.ref, steps: group.length,
      estimatedTokens: group.flatMap(u => u.messages).reduce((n, m) => n + estimate(m), 0), preview: text(group[0].messages[0]).slice(0, 160) });
    group = [];
  };
  for (const unit of view.units) {
    if (!unit.eligible) { flush(); continue; }
    group.push(unit);
    if (group.length === 16) flush(); // Bounded candidate units, not a history truncation.
  }
  flush();
  return ranges;
}
function selectedFingerprint(view: View, targets: string[]): string {
  const ids = new Set(targets);
  return hash(view.projection.entries.filter(e => ids.has(e.sourceEntry.id)).map(e => [e.sourceEntry.id, e.messages]));
}
export function planCompression(view: View, selection: Selection, estimate: Estimate, id: string): Plan {
  if (!selection.summary.trim()) throw new Error(COPY.emptySummary);
  const byBlocks = selection.blocks !== undefined;
  if (byBlocks ? !selection.blocks!.length || selection.start !== undefined || selection.end !== undefined : !selection.start || !selection.end) throw new Error(COPY.selector);
  let targets: string[], direct: string[], covered: string[], children: string[] = [], replaces: string | undefined, tier = 1;
  if (byBlocks) {
    const ids = selection.blocks!;
    const units = ids.map(b => view.units.find(u => u.block?.id === b));
    const indexes = units.map(u => u ? view.units.indexOf(u) : -1);
    if (new Set(ids).size !== ids.length || indexes.some((index, n) => index < 0 || (n > 0 && index !== indexes[n - 1] + 1)) ||
      units.some(u => !u?.block || view.states.get(u.block.id) !== "active") ||
      units.some(u => u!.block!.tier !== units[0]!.block!.tier)) throw new Error(COPY.blocks);
    // Do not merge carriers in the recent protected suffix either.
    if (indexes.at(-1)! >= view.units.length - 4) throw new Error(COPY.protected);
    tier = units[0]!.block!.tier + (ids.length > 1 ? 1 : 0);
    if (tier > 3) throw new Error(COPY.blocks);
    targets = units.flatMap(u => u!.ids);
    covered = [...new Set(units.flatMap(u => u!.block!.covered))];
    if (ids.length === 1) {
      const prior = units[0]!.block!;
      direct = prior.direct; children = prior.children; replaces = prior.id;
    } else { direct = []; children = ids; }
  } else {
    const first = view.units.findIndex(u => u.ref === selection.start);
    const last = view.units.findIndex(u => u.ref === selection.end);
    if (first < 0 || last < first) throw new Error(COPY.range);
    const units = view.units.slice(first, last + 1);
    if (units.some(u => !u.eligible)) throw new Error(COPY.protected);
    targets = units.flatMap(u => u.ids);
    direct = targets; covered = targets;
  }
  const before = view.projection.entries.filter(e => targets.includes(e.sourceEntry.id)).flatMap(e => e.messages).reduce((n, m) => n + estimate(m), 0);
  const block: Block = { version: 1, id, tier, carrier: targets[0], direct, covered, children, ...(replaces ? { replaces } : {}), summary: selection.summary.trim(), before, after: 0 };
  const original = view.projection.entries.find(e => e.sourceEntry.id === block.carrier)!.messages[0];
  block.after = estimate({ ...original, content: [{ type: "text", text: rendered(block) }] } as AgentMessage);
  if (block.after >= before) throw new Error(COPY.noShrink);
  return { block, targets, fingerprint: selectedFingerprint(view, targets), selection };
}
export function commitDrafts(view: View, plan: Plan): SessionBoundaryDraft[] {
  if (selectedFingerprint(view, plan.targets) !== plan.fingerprint) throw new Error(COPY.stale);
  // Record recoverable provenance first, then the summary before any omissions.
  // Pi appends entries individually, not as a disk transaction. Interrupted writes
  // can duplicate context but must never omit originals without a stored summary.
  return [
    { type: "custom", customType: BLOCK_ENTRY, data: plan.block },
    { type: "context_edit", targetId: plan.block.carrier, replacement: { content: [{ type: "text", text: rendered(plan.block) }] } },
    ...plan.targets.slice(1).map(targetId => ({ type: "context_edit" as const, targetId, replacement: null })),
  ];
}
export function status(view: View, estimate: Estimate, offset = 0) {
  const items = [
    ...[...view.blocks.values()].map(b => ({ kind: "block", id: b.id, tier: b.tier, state: view.states.get(b.id), summary: b.summary.slice(0, 320), estimatedSavedTokens: b.before - b.after })),
    ...candidates(view, estimate).map(r => ({ kind: "range", ...r })),
  ];
  if (offset > items.length) throw new Error(COPY.offset);
  return { items: items.slice(offset, offset + 24), nextOffset: offset + 24 < items.length ? offset + 24 : null, complete: offset + 24 >= items.length };
}
export function search(view: View, query: string, offset: number) {
  const needle = query.toLocaleLowerCase();
  const hits: { ref: string; excerpt: string }[] = [];
  const add = (ref: string, body: string) => {
    const at = body.toLocaleLowerCase().indexOf(needle);
    if (at >= 0) hits.push({ ref, excerpt: body.slice(Math.max(0, at - 80), at + 240) });
  };
  for (const b of view.blocks.values()) add(b.id, b.summary);
  for (const e of view.branch) if (e.type === "message") add(`@${e.id}`, text(e.message));
  if (offset > hits.length) throw new Error(COPY.offset);
  return { matches: hits.slice(offset, offset + 24), nextOffset: offset + 24 < hits.length ? offset + 24 : null, complete: offset + 24 >= hits.length };
}
