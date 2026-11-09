import assert from "node:assert/strict";
import test from "node:test";
import { buildView, search, BLOCK_ENTRY } from "./blocks.ts";
import { recall } from "./recall.ts";
import { COPY } from "./copy.ts";
import { legacyFixture, SessionManager } from "./test-helpers.ts";

function projectionOf(m: any) {
  return m.buildSessionProjection().messages.map((message: any) => ({
    role: message.role,
    text: typeof message.content === "string" ? message.content : (message.content ?? []).map((p: any) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n"),
  }));
}
function replayedView(session: any) {
  const manager = SessionManager.inMemory(session.cwd, undefined, session.entries);
  manager.branch(session.leafId);
  return { manager, view: buildView(manager.getBranch(), manager.buildSessionProjection()) };
}
function pages(view: any, id: string, mode: "one" | "full") {
  const result = [];
  let offset = 0;
  for (let guard = 0; guard < 200; guard++) {
    const page = recall(view, id, mode, offset, true);
    result.push({ details: page.details, content: page.content });
    if (page.details.nextOffset === null) break;
    offset = page.details.nextOffset;
  }
  return result;
}

test("frozen legacy session keeps summary visibility, block states and projection after slimming", () => {
  const { session, expected } = legacyFixture();
  const { manager, view } = replayedView(session);
  assert.deepEqual(Object.fromEntries(view.states), { a1: "archived", b2: "partial", c3: "active" });
  assert.deepEqual(projectionOf(manager), expected.projection, "the visible context of a legacy session must not change");
});

test("frozen legacy recall output by block id and by @entryId is byte-identical to the three-tool implementation", () => {
  const { session, expected } = legacyFixture();
  const { view } = replayedView(session);
  for (const [id, block] of Object.entries(expected.blocks) as [string, any][]) {
    assert.deepEqual(pages(view, id, "one"), block.one, `block ${id} mode=one output changed`);
    assert.deepEqual(pages(view, id, "full"), block.full, `block ${id} mode=full output changed`);
  }
  for (const [name, entryExpected] of Object.entries(expected.entries) as [string, any][]) {
    assert.deepEqual(recall(view, entryExpected.details.ref, "full", 0, true), entryExpected, `${name} recall output changed`);
  }
  // The archived block stays recoverable verbatim even though a native compaction hides it.
  assert.match(JSON.stringify(pages(view, "a1", "full")), /original details/);
  assert.deepEqual(view.branch.filter((e) => e.type === "message").slice(0, 2), session.entries.filter((e: any) => e.type === "message").slice(0, 2),
    "old originals stay on the branch");
});

test("frozen legacy search still finds a legacy summary; new search adds roles without changing matches", () => {
  const { session, expected: frozen } = legacyFixture();
  const { view } = replayedView(session);
  const found = search(view, "gamma active summary", 0);
  const expected = frozen.search.blockSummary;
  assert.deepEqual(found.matches.map((m) => ({ ref: m.ref, excerpt: m.excerpt })), expected.matches);
  assert.equal(found.nextOffset, expected.nextOffset);
  assert.equal(found.complete, expected.complete);
  assert.deepEqual(found.matches.map((m) => m.role), ["summary"]);
  assert.equal(found.coverage, "matching-parts");
  const text = search(view, "secret-14", 0);
  assert.deepEqual(text.matches.map((m) => ({ ref: m.ref, excerpt: m.excerpt })), frozen.search.text.matches);
  assert.equal(text.matches[0].role, "toolResult:read");
});

test("legacy parsing still fails closed on a damaged or unknown block record", () => {
  const { session } = legacyFixture();
  const damaged = session.entries.map((entry: any) =>
    entry.type === "custom" && entry.customType === BLOCK_ENTRY ? { ...entry, data: { ...entry.data, version: 2 } } : entry);
  const manager = SessionManager.inMemory(session.cwd, undefined, damaged);
  manager.branch(session.leafId);
  assert.throws(() => buildView(manager.getBranch(), manager.buildSessionProjection()), new RegExp(COPY.corrupt));
});
