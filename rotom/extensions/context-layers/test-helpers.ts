import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildView } from "./blocks.ts";

let piRoot = process.env.ROTOM_PI ? dirname(process.env.ROTOM_PI) : resolve(import.meta.dirname, "../../runtime/pi/node_modules/@earendil-works/pi-coding-agent");
while (!existsSync(join(piRoot, "package.json")) || JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent") {
  const parent = dirname(piRoot);
  if (parent === piRoot) throw new Error("Cannot locate selected Pi package");
  piRoot = parent;
}
export const { SessionManager, estimateTokens, DefaultResourceLoader, SettingsManager, ModelRuntime, createAgentSession } = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
export const { fauxAssistantMessage, fauxToolCall, fauxProvider } = await import(pathToFileURL(resolve(piRoot, "../pi-ai/dist/index.js")).href);

export function fixture(manager = SessionManager.inMemory(process.cwd()), steps = 14) {
  manager.appendMessage({ role: "user", content: "Keep requirements exact", timestamp: 1 });
  const ids: string[] = [];
  for (let n = 0; n < steps; n++) {
    ids.push(manager.appendMessage(fauxAssistantMessage([fauxToolCall("read", { path: `file-${n}` }, { id: `c${n}` })], { stopReason: "toolUse" })));
    manager.appendMessage({ role: "toolResult", toolCallId: `c${n}`, toolName: "read", content: [{ type: "text", text: `secret-${n} ` + "original details ".repeat(300) }], isError: false, timestamp: n + 2 });
  }
  return { manager, ids };
}
export const view = (m: any) => buildView(m.getBranch(), m.buildSessionProjection());
/**
 * Legacy session fixture is replayed read-only. `session` holds the branch entries and
 * `expected` holds the outputs frozen by the pre-slimming (three-tool) implementation;
 * both are stored separately so neither file grows past the commit size budget.
 */
export function legacyFixture() {
  const dir = join(import.meta.dirname, "fixtures");
  const session = JSON.parse(readFileSync(join(dir, "legacy-session.json"), "utf8"));
  const expected = JSON.parse(readFileSync(join(dir, "legacy-session-expected.json"), "utf8"));
  return { session, expected, manager: SessionManager.inMemory(session.cwd, undefined, session.entries) };
}
