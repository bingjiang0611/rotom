import assert from "node:assert/strict";
import test from "node:test";
import { candidates, commitDrafts, planCompression, status, search } from "./blocks.ts";
import { recall } from "./recall.ts";
import { fixture, view, apply, fold, estimateTokens, fauxAssistantMessage, fauxToolCall } from "./test-helpers.ts";

test("candidate rows are maximal intervals, not 16-step chunks hiding notification gaps", () => {
  const { manager: m, ids } = fixture(undefined, 40);
  assert.deepEqual(candidates(view(m), estimateTokens).map(r => r.steps), [36]);
  const notice = m.appendCustomMessageEntry("subagent-notify", "Child outcome needs review", true);
  for (let n = 0; n < 8; n++) m.appendMessage(fauxAssistantMessage("completed work ".repeat(100)));
  const ranges = candidates(view(m), estimateTokens);
  assert.deepEqual(ranges.map(r => r.steps), [40, 4]);
  const before = m.getBranch().length;
  for (const range of ranges) assert.doesNotThrow(() => planCompression(view(m), { ...range, summary: "retained" }, estimateTokens, "test"));
  assert.throws(() => planCompression(view(m), { start: ranges[0].start, end: ranges[1].end, summary: "retained" }, estimateTokens, "bad"),
    error => error instanceof Error && error.message.includes(`@${notice}`) && /subagent-notify/.test(error.message) && /never span/.test(error.message));
  assert.equal(m.getBranch().length, before, "inspection and rejected plans never mutate the session");
  assert.equal(ranges[0].end, `@${ids[39]}`);
});

test("range errors identify stale, invented, non-boundary and reversed refs without guessing replacements", () => {
  const { manager: m, ids } = fixture();
  const selection = { start: `@${ids[0]}`, end: `@${ids[3]}`, summary: "retained" };
  const toolResult = m.getBranch().find(e => e.type === "message" && e.message.role === "toolResult")!;
  assert.throws(() => planCompression(view(m), { ...selection, start: `@${toolResult.id}` }, estimateTokens, "bad"),
    error => error instanceof Error && /not a selectable step boundary/.test(error.message) && error.message.includes(`@${ids[0]}`));
  assert.throws(() => planCompression(view(m), { ...selection, start: "b1" }, estimateTokens, "bad"), /Unknown step ref b1/);
  assert.throws(() => planCompression(view(m), { ...selection, end: "b1" }, estimateTokens, "bad"), /Unknown step ref b1/);
  assert.throws(() => planCompression(view(m), { ...selection, start: selection.end, end: selection.start }, estimateTokens, "bad"), /precedes start/);
  m.appendCompaction("Native checkpoint", ids[8], 5000);
  assert.throws(() => planCompression(view(m), selection, estimateTokens, "bad"),
    error => error instanceof Error && error.message.includes(selection.start) && /no longer visible/.test(error.message) && /Refresh context_status/.test(error.message));
  const current = candidates(view(m), estimateTokens)[0];
  assert.doesNotThrow(() => planCompression(view(m), { ...current, summary: "retained" }, estimateTokens, "current"));
});

test("protection diagnostics retain user anchors, recent work, foreign edits and incomplete steps", () => {
  const { manager: m, ids } = fixture();
  const plan = (start: string, end = start) => planCompression(view(m), { start, end, summary: "retained" }, estimateTokens, "bad");
  const firstUser = m.getBranch().find(e => e.type === "message" && e.message.role === "user")!.id;
  assert.throws(() => plan(`@${firstUser}`, `@${ids[0]}`), /first user request/);
  assert.throws(() => plan(`@${ids[13]}`), /last four steps/);
  const user = m.appendMessage({ role: "user", content: "Keep the new requirement", timestamp: 20 });
  const broken = m.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "missing-result" }), { stopReason: "toolUse" }));
  for (let n = 0; n < 6; n++) m.appendMessage(fauxAssistantMessage("completed ".repeat(100)));
  assert.throws(() => plan(`@${user}`), /latest user request/);
  assert.throws(() => plan(`@${broken}`), /incomplete tool step/);
  const toolResult = m.getBranch().find(e => e.type === "message" && e.message.role === "toolResult")!.id;
  m.appendContextEdit(toolResult, { content: [{ type: "text", text: "foreign replacement" }] });
  assert.throws(() => plan(`@${ids[0]}`), /another context editor/);
  fold(m, `@${ids[2]}`, `@${ids[3]}`, "folded");
  assert.throws(() => plan("folded"), /use its block actions/);
});

test("block actions follow projection adjacency rather than block creation order", () => {
  const { manager: m, ids } = fixture();
  const rows = () => status(view(m), estimateTokens).items.filter(x => x.kind === "block") as any[];
  fold(m, `@${ids[0]}`, `@${ids[1]}`, "left", "details ".repeat(20));
  fold(m, `@${ids[4]}`, `@${ids[5]}`, "right", "details ".repeat(20));
  assert.equal(rows().find(b => b.id === "left").mergeWithNext, null);
  assert.throws(() => planCompression(view(m), { blocks: ["left", "right"], summary: "short" }, estimateTokens, "bad"), /Cannot merge left followed by right/);
  fold(m, `@${ids[2]}`, `@${ids[3]}`, "middle", "details ".repeat(20));
  assert.equal(rows().find(b => b.id === "left").mergeWithNext, "middle");
  assert.equal(rows().find(b => b.id === "middle").mergeWithNext, "right");
  for (const blocks of [["left", "middle"], ["middle", "right"], ["left", "middle", "right"]]) {
    assert.doesNotThrow(() => planCompression(view(m), { blocks, summary: "short" }, estimateTokens, "valid"));
  }
  for (const blocks of [["right", "middle"], ["left", "left"]]) {
    assert.throws(() => planCompression(view(m), { blocks, summary: "short" }, estimateTokens, "bad"), /Cannot merge/);
  }
  const merged = planCompression(view(m), { blocks: ["left", "middle"], summary: "retained ".repeat(10) }, estimateTokens, "higher");
  apply(m, commitDrafts(view(m), merged));
  assert.equal(rows().find(b => b.id === "higher").mergeWithNext, null, "adjacent but mixed tiers cannot merge");
  assert.equal(rows().find(b => b.id === "left").rewriteAllowed, false);
  assert.throws(() => planCompression(view(m), { blocks: ["left"], summary: "short" }, estimateTokens, "bad"), /superseded/);
  assert.throws(() => planCompression(view(m), { blocks: ["higher", "right"], summary: "short" }, estimateTokens, "bad"), /same-tier/);
  assert.throws(() => planCompression(view(m), { blocks: ["missing"], summary: "short" }, estimateTokens, "bad"), /missing, not an active visible block/);
  // Another editor can hide the trailing steps, making an old block recent again.
  const units = view(m).units;
  const rightIndex = units.findIndex(u => u.block?.id === "right");
  for (const unit of units.slice(rightIndex + 1)) for (const id of unit.ids) m.appendContextEdit(id, null);
  assert.equal(rows().find(b => b.id === "right").rewriteAllowed, false);
  assert.throws(() => planCompression(view(m), { blocks: ["right"], summary: "short" }, estimateTokens, "bad"), /protected recent suffix/);
  m.appendCompaction("Checkpoint", ids[4], 5000);
  assert.equal(rows().find(b => b.id === "higher").rewriteAllowed, false, "archived blocks cannot be rewritten");
  assert.throws(() => planCompression(view(m), { blocks: ["higher"], summary: "short" }, estimateTokens, "bad"), /archived/);
});

test("tier-three blocks expose rewrites but no merge beyond the tier limit", () => {
  const { manager: m, ids } = fixture(undefined, 30);
  for (let n = 0; n < 8; n++) fold(m, `@${ids[n * 2]}`, `@${ids[n * 2 + 1]}`, `b${n}`, "details ".repeat(30));
  const merge = (blocks: string[], id: string, summary: string) => {
    const p = planCompression(view(m), { blocks, summary }, estimateTokens, id);
    apply(m, commitDrafts(view(m), p));
  };
  for (let n = 0; n < 4; n++) merge([`b${n * 2}`, `b${n * 2 + 1}`], `pair${n}`, "pair details ".repeat(15));
  merge(["pair0", "pair1"], "left", "retained left ".repeat(8));
  merge(["pair2", "pair3"], "right", "retained right ".repeat(8));
  const left = status(view(m), estimateTokens).items.find(x => x.kind === "block" && x.id === "left") as any;
  assert.equal(left.tier, 3);
  assert.equal(left.rewriteAllowed, true);
  assert.equal(left.mergeWithNext, null);
  assert.throws(() => planCompression(view(m), { blocks: ["left", "right"], summary: "short" }, estimateTokens, "bad"), /below tier 3/);
  assert.doesNotThrow(() => planCompression(view(m), { blocks: ["left"], summary: "short" }, estimateTokens, "valid"));
});

test("block action links remain usable across bounded status pages", () => {
  const { manager: m, ids } = fixture(undefined, 40);
  for (let n = 0; n < 26; n++) fold(m, `@${ids[n]}`, `@${ids[n]}`, `b${n}`, "details ".repeat(20));
  const first = status(view(m), estimateTokens);
  assert.equal(first.items.length, 24);
  assert.equal(first.complete, false);
  assert.equal(first.items[0].kind, "range");
  assert.equal((first.items[23] as any).mergeWithNext, "b23");
  const second = status(view(m), estimateTokens, first.nextOffset!);
  assert.equal(second.complete, true);
  assert.equal((second.items[0] as any).id, "b23");
  assert.equal((second.items[0] as any).rewriteAllowed, true);
  assert.doesNotThrow(() => planCompression(view(m), { blocks: ["b22", "b23"], summary: "retained" }, estimateTokens, "valid"));
});

test("status prioritizes ranges and actionable blocks ahead of 65 archived summaries", () => {
  const { manager: m, ids } = fixture(undefined, 85);
  const archivedIds = Array.from({ length: 65 }, (_, n) => `archived-${n}`);
  for (const [n, id] of archivedIds.entries()) fold(m, `@${ids[n]}`, `@${ids[n]}`, id);
  m.appendCompaction("Native checkpoint", ids[65], 5000);
  fold(m, `@${ids[65]}`, `@${ids[66]}`, "active-left", "details ".repeat(20));
  fold(m, `@${ids[67]}`, `@${ids[68]}`, "active-right", "details ".repeat(20));
  const current = view(m), raw = m.getBranch();
  assert.ok(archivedIds.every(id => current.states.get(id) === "archived"));

  const first = status(current, estimateTokens);
  assert.equal(first.items.length, 24);
  assert.equal(first.complete, false);
  assert.equal(first.nextOffset, 24);
  const range = first.items[0] as any;
  assert.equal(range.kind, "range");
  assert.equal(range.start, `@${ids[69]}`);
  assert.doesNotThrow(() => planCompression(current, { start: range.start, end: range.end, summary: "retained" }, estimateTokens, "candidate"));
  const active = first.items.slice(1, 3) as any[];
  assert.deepEqual(active.map(b => b.id), ["active-left", "active-right"]);
  assert.ok(active.every(b => b.rewriteAllowed));
  assert.equal(active[0].mergeWithNext, "active-right");

  const second = status(current, estimateTokens, first.nextOffset!);
  assert.equal(second.items.length, 24);
  assert.equal(second.nextOffset, 48);
  const third = status(current, estimateTokens, second.nextOffset!);
  assert.equal(third.items.length, 20);
  assert.equal(third.complete, true);
  assert.equal(third.nextOffset, null);
  const history = [...first.items, ...second.items, ...third.items].slice(3) as any[];
  assert.deepEqual(history.map(b => b.id), archivedIds, "pagination retains every archived block exactly once");
  assert.ok(history.every(b => b.state === "archived" && !b.rewriteAllowed && b.mergeWithNext === null));
  assert.match(JSON.stringify(recall(current, archivedIds[0], "full", 0, false)), /secret-0/);
  assert.ok(search(current, "secret-0", 0).matches.length);
  assert.deepEqual(m.getBranch(), raw, "status ordering does not change session history");
});
