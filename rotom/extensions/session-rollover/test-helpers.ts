import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let piRoot = process.env.ROTOM_PI ? dirname(process.env.ROTOM_PI) : resolve(import.meta.dirname, "../../runtime/pi/node_modules/@earendil-works/pi-coding-agent");
while (!existsSync(join(piRoot, "package.json")) || JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).name !== "@earendil-works/pi-coding-agent") {
  const parent = dirname(piRoot);
  if (parent === piRoot) throw new Error("Cannot locate selected Pi package");
  piRoot = parent;
}
export const { SessionManager, DefaultResourceLoader, SettingsManager, ModelRuntime, createAgentSession, estimateTokens } =
  await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
export const { fauxAssistantMessage, fauxToolCall, fauxText, fauxProvider } = await import(
  pathToFileURL(resolve(piRoot, "../pi-ai/dist/index.js")).href
);

// A small window keeps the water mark reachable with short fixtures; the rule under test is the
// same as for a real window because both water marks derive from reserveTokens.
export const CONTEXT_WINDOW = 12_000;
export const RESERVE_TOKENS = 1_000;
/** Threshold compaction at `contextWindow - reserveTokens`; rollover one reserve below it. */
export const THRESHOLD = CONTEXT_WINDOW - RESERVE_TOKENS;
export const WATERMARK = CONTEXT_WINDOW - 2 * RESERVE_TOKENS;

/** An assistant message whose provider usage claims `tokens`, which is what the estimate reads. */
export function assistantWithUsage(text: string, tokens: number, timestamp = Date.now()): any {
  return {
    ...fauxAssistantMessage(text),
    timestamp,
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export interface HarnessOptions {
  dir: string;
  /** `ROTOM_SESSION_ROLLOVER` value for the extension; undefined leaves it unset. */
  rollover?: string;
  /** Load the real context-layers extension so `context_recall` exists. */
  recall?: boolean;
  tools?: string[];
  historyTokens?: number;
  compactionEnabled?: boolean;
  /** Extension source appended after this extension, to observe or cancel its events. */
  probeSource?: string;
  /** Extension source loaded before the rollover extension, to observe events it cancels. */
  earlyProbeSource?: string;
  /** Reopen an existing session file instead of seeding a new branch (resume path). */
  resumeFrom?: string;
  /** Seed the persisted branch with one user message and one tool result carrying `secret`. */
  seedToolResult?: boolean;
  seedImage?: boolean;
}

export interface Harness {
  session: any;
  faux: any;
  events: unknown[];
  error: string | undefined;
  toolDefinitions: Map<string, any>;
  handlerNames: string[];
  loader: any;
  settings: any;
  runtime: any;
  dispose(): void;
}

const previousSwitch = process.env.ROTOM_SESSION_ROLLOVER;

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  if (options.rollover === undefined) delete process.env.ROTOM_SESSION_ROLLOVER;
  else process.env.ROTOM_SESSION_ROLLOVER = options.rollover;

  const dir = options.dir;
  const paths = [] as string[];
  if (options.earlyProbeSource !== undefined) {
    const earlyPath = join(dir, "early-probe-extension.ts");
    writeFileSync(earlyPath, options.earlyProbeSource);
    paths.push(earlyPath);
  }
  if (options.recall) paths.push(resolve(import.meta.dirname, "../context-layers/index.ts"));
  paths.push(resolve(import.meta.dirname, "index.ts"));
  if (options.probeSource !== undefined) {
    const probePath = join(dir, "probe-extension.ts");
    writeFileSync(probePath, options.probeSource);
    paths.push(probePath);
  }

  const settings = SettingsManager.inMemory({
    // `keepRecentTokens: 1` keeps every threshold compaction preparable from short test messages;
    // the water mark is still derived from reserveTokens.
    compaction: { enabled: options.compactionEnabled ?? true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noExtensions: true,
    additionalExtensionPaths: paths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length > 0) throw new Error(`extension load failed: ${JSON.stringify(loaded.errors)}`);

  const resumed = options.resumeFrom !== undefined;
  const manager = resumed ? SessionManager.open(options.resumeFrom!, dir, dir) : SessionManager.create(dir, dir);
  if (!resumed) manager.appendMessage({ role: "user", content: [{ type: "text", text: "Keep the recorded requirement exact." }], timestamp: Date.now() - 3_000 });
  if (!resumed) manager.appendMessage(assistantWithUsage("Recorded earlier answer.", 10, Date.now() - 2_500));
  if (options.seedToolResult) {
    manager.appendMessage(assistantWithUsage([fauxToolCall("read", { path: "notes.txt" }, { id: "old-call" })], 20, Date.now() - 2_400));
    manager.appendMessage({ role: "toolResult", toolCallId: "old-call", toolName: "read", content: [{ type: "text", text: "secret-old-result-42" }], isError: false, timestamp: Date.now() - 2_300 });
  }
  if (options.historyTokens !== undefined) {
    manager.appendMessage(assistantWithUsage("Context filler before the inter-turn point.", options.historyTokens, Date.now() - 2_000));
  }

  const faux = fauxProvider({ provider: "rollover-test", models: [{ id: "test", contextWindow: CONTEXT_WINDOW, maxTokens: 4_096 }] });
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);

  const created = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model: faux.getModel(),
    tools: options.tools ?? ["context_recall"],
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
    sessionStartEvent: { type: "session_start", reason: resumed ? "resume" : "startup" },
  });
  const session = created.session;
  const events: unknown[] = [];
  let error: string | undefined;
  await session.bindExtensions({ mode: "print", onError: (value: { error: string }) => { error = value.error; } });
  session.subscribe((event: unknown) => events.push(event));

  const extensions = loaded.extensions as Array<{ tools: Map<string, any>; handlers: Map<string, unknown[]> }>;
  const toolDefinitions = new Map<string, any>();
  const handlerNames: string[] = [];
  for (const extension of extensions) {
    for (const [name, tool] of extension.tools) toolDefinitions.set(name, tool.definition);
    for (const name of extension.handlers.keys()) handlerNames.push(name);
  }

  return {
    session,
    faux,
    events,
    get error() { return error; },
    toolDefinitions,
    handlerNames,
    loader,
    settings,
    runtime,
    dispose() {
      session.dispose();
      if (previousSwitch === undefined) delete process.env.ROTOM_SESSION_ROLLOVER;
      else process.env.ROTOM_SESSION_ROLLOVER = previousSwitch;
    },
  } as Harness;
}

/** Reply text whose token estimate is about `tokens`; the faux provider recomputes usage from it. */
export function longReply(tokens: number): string {
  return "measured reply sentence. ".repeat(Math.ceil((tokens * 4) / 25)).slice(0, tokens * 4);
}

/** Branch entry types with system patches dropped, which is what a rollover changes. */
export function visibleEntryTypes(session: any): string[] {
  return session.sessionManager
    .getBranch()
    .filter((entry: any) => entry.type !== "message" || entry.message.role !== "system")
    .map((entry: any) => (entry.type === "compaction" ? "compaction" : entry.type));
}

export function compactionEntries(session: any): any[] {
  return session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction");
}

/** Prompt text recorded once in the branch (template and skill expansion must not duplicate it). */
export function userTextCount(session: any, text: string): number {
  return session.sessionManager
    .getBranch()
    .filter((entry: any) => entry.type === "message" && entry.message.role === "user")
    .filter((entry: any) => JSON.stringify(entry.message.content).includes(text)).length;
}
