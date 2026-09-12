// Maintenance-only characterization of the locked dependency, not a runtime adapter.
// Node refuses to strip TypeScript in node_modules: run a private fixture copy.
// Optional candidate mode applies the maintenance patch only inside that copy.
// TODO cases assert desired behavior and execute normally; strict mode makes them gates.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// An explicit prepared source is copied, never modified in place. Default stays
// the installed baseline; callers must opt into the changed pending-only contract.
const preparedSource = process.env.SUBAGENT_WAIT_SOURCE;
const pendingOnly = process.env.SUBAGENT_WAIT_PENDING_ONLY === "1";
const dispatchState = pendingOnly ? "unknown" : "accepted";
const installed = preparedSource ? pathToFileURL(`${fs.realpathSync(preparedSource)}/`) : new URL("./node_modules/pi-subagents/", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", installed), "utf8"));
assert.equal(pkg.name, "pi-subagents");
assert.equal(pkg.version, "0.52.1", "Reclassify known gaps when changing the baseline version");
const root = mkdtempSync(join(tmpdir(), "dev-agent-subagent-regression-"));
const originalTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = join(root, "runtime");
after(() => {
	if (originalTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
	else process.env.PI_SUBAGENTS_TEMP_ROOT = originalTempRoot;
	rmSync(root, { recursive: true, force: true });
});
const source = join(root, "package");
mkdirSync(source);
cpSync(new URL("src", installed), join(source, "src"), { recursive: true });
writeFileSync(join(source, "package.json"), JSON.stringify({ type: "module" }));
const candidate = process.env.SUBAGENT_WAIT_CANDIDATE === "1";
if (candidate && !preparedSource) {
	const patches = ["./subagent-wait-candidate.patch"];
	if (process.env.SUBAGENT_OWNER_LOSS_CANDIDATE === "1") patches.push("./subagent-owner-loss-candidate.patch");
	if (process.env.SUBAGENT_LIFELINE_CANDIDATE === "1") patches.push("./subagent-lifeline-candidate.patch");
	if (process.env.SUBAGENT_STARTUP_CANDIDATE === "1") patches.push("./subagent-startup-candidate.patch");
	const env = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	for (const name of patches) {
		const patch = fileURLToPath(new URL(name, import.meta.url));
		const applied = spawnSync("git", ["apply", "--unidiff-zero", patch], { cwd: source, env, encoding: "utf8", timeout: 10_000 });
		assert.ifError(applied.error);
		assert.equal(applied.status, 0, applied.stderr);
	}
}
const load = (file) => import(pathToFileURL(join(source, "src", file)).href);
const { createWaitSubscriptionManager, formatWaitSubscriptions } = await load("runs/background/wait-subscriptions.ts");
const { buildControlEvent } = await load("runs/shared/subagent-control.ts");
const { writeCompletionReplay } = await load("runs/background/completion-replay.ts");
const { DIRS, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_CONTROL_EVENT, SUBAGENT_CONTROL_INTERCOM_EVENT } = await load("shared/types.ts");
assert.equal(DIRS.async, join(root, "runtime", "async-subagent-runs"));

const SESSION = "fixture-session";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const strict = process.env.SUBAGENT_WAIT_STRICT === "1";
const gap = (id) => ({
	todo: strict || candidate
		? false : `${id}: unresolved in pi-subagents@0.52.1; run SUBAGENT_WAIT_STRICT=1`,
});

function fixture(t) {
	const dir = mkdtempSync(join(root, "case-"));
	const asyncDirRoot = join(dir, "runs");
	const resultsDir = join(dir, "results");
	const subscriptionsDir = join(dir, "subscriptions");
	const statusPath = join(asyncDirRoot, RUN, "status.json");
	const state = { currentSessionId: SESSION, foregroundRuns: new Map() };
	const messages = [];
	const receipts = [];
	state.lastUiContext = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => SESSION, getBranch: () => receipts } };
	const events = new EventEmitter();
	let now = 1_000_000;
	let rejectDelivery = false;
	let receiveOnReturn = true;
	let afterDispatch;
	let manager;
	const pi = {
		events: { on(name, fn) { events.on(name, fn); return () => events.off(name, fn); } },
		sendMessage(message, options) {
			if (rejectDelivery) throw new Error("synthetic rejection before acceptance");
			messages.push({ ...message, options });
			afterDispatch?.(message);
			if (receiveOnReturn) receipts.push({ type: "custom_message", customType: message.customType, details: structuredClone(message.details) });
		},
	};
	const create = () => createWaitSubscriptionManager(pi, state, {
		asyncDirRoot, resultsDir, subscriptionsDir, now: () => now,
		// Reconcile explicitly, without sleeps, processes, models, or live runtime state.
		pollIntervalMs: 2_000_000_000,
		kill: (_pid, signal) => { assert.equal(signal, 0); return true; },
	});
	manager = create();
	t.after(() => { manager.dispose(); rmSync(dir, { recursive: true, force: true }); });
	return {
		state, messages, receipts, events, resultsDir, subscriptionsDir, statusPath,
		readback(sessionId = SESSION) {
			state.lastUiContext = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => sessionId, getBranch: () => receipts } };
		},
		addReceipt(message = messages.at(-1)) {
			receipts.push({ type: "custom_message", customType: message.customType, details: structuredClone(message.details) });
		},
		onDispatch(fn) { afterDispatch = fn; },
		queueOnly() { receiveOnReturn = false; },
		persisted(token) { return JSON.parse(readFileSync(join(subscriptionsDir, `${token}.json`), "utf8")); },
		get manager() { return manager; },
		get now() { return now; },
		advance(ms) { now += ms; },
		rejectDelivery() { rejectDelivery = true; },
		restart() { manager.dispose(); manager = create(); manager.restore(); },
		arm(targetKind = "async", runId = RUN) {
			return manager.arm({ targetKind, runId, requestedId: runId.slice(0, 8), timeoutMs: 1000 });
		},
		status(overrides = {}) {
			mkdirSync(join(asyncDirRoot, RUN), { recursive: true });
			writeFileSync(statusPath, JSON.stringify({
				runId: RUN, sessionId: SESSION, mode: "single", state: "running",
				startedAt: now, lastUpdate: now, currentStep: 0,
				steps: [{ agent: "fixture", status: "running" }], ...overrides,
			}));
		},
	};
}

function onlyOutcome(f, outcome) {
	assert.equal(f.messages.length, 1);
	assert.equal(f.messages[0].customType, "subagent-wait-subscription");
	assert.equal(f.messages[0].details.runId, RUN);
	assert.equal(f.messages[0].details.outcome, outcome);
	assert.equal(f.messages[0].options.triggerTurn, true);
}

test("G05: file-backed owner differs from native UUID and still confirms delivery", gap("G05"), (t) => {
	const f = fixture(t);
	const owner = join(root, "native-session.jsonl");
	f.state.currentSessionId = owner;
	f.state.lastUiContext.sessionManager.getSessionFile = () => owner;
	f.state.lastUiContext.sessionManager.getSessionId = () => "native-uuid";
	f.status({ sessionId: owner, activityState: "needs_attention" });
	const first = f.arm();
	f.manager.reconcile();
	assert.equal(f.arm().token, first.token);
	assert.equal(f.messages.length, 1);
	f.status({ sessionId: owner, state: "complete" });
	f.manager.reconcile();
	assert.equal(f.messages.at(-1).details.outcome, "completed");
	assert.equal(f.state.waitSubscriptions.size, 0);
});

test("G05: foreign file cannot confirm a receipt even when native ID matches", gap("G05"), (t) => {
	const f = fixture(t);
	f.queueOnly();
	f.status({ state: "complete" });
	const record = f.arm();
	f.manager.reconcile();
	f.addReceipt();
	f.state.lastUiContext.sessionManager.getSessionFile = () => "foreign-session.jsonl";
	f.manager.reconcile();
	assert.ok(f.state.waitSubscriptions.has(record.token));
	assert.equal(f.persisted(record.token).delivery.state, dispatchState);
});

test("active run stays armed without a false terminal or attention notice", (t) => {
	const f = fixture(t);
	f.status();
	f.arm();
	f.manager.reconcile();
	assert.equal(f.messages.length, 0);
	assert.equal(f.state.waitSubscriptions.size, 1);
});

test("first attention is delivered once per subscription even across repeated reconcile", (t) => {
	const f = fixture(t);
	f.status({ activityState: "needs_attention" });
	f.arm();
	for (let i = 0; i < 19; i++) f.manager.reconcile();
	onlyOutcome(f, "needs attention");
});

test("G01: re-arming unchanged attention must not create a wakeup loop", gap("G01"), (t) => {
	const f = fixture(t);
	f.status({ activityState: "needs_attention" });
	for (let i = 0; i < 19; i++) { f.arm(); f.manager.reconcile(); }
	assert.equal(f.messages.length, 1, "Same unchanged signal generated 19 independently accepted wakeups");
	assert.ok(f.state.waitSubscriptions.size > 0, "Deduplication must not silently consume the new wait");
	f.status({ state: "complete" });
	f.manager.reconcile();
	assert.ok(f.messages.slice(1).some((m) => m.details.outcome === "completed"), "Completion must still reach the parent");
});

for (const terminal of ["complete", "failed", "paused", "stopped", "rejected"]) {
	const outcome = terminal === "complete" ? "completed" : terminal;
	test(`terminal ${terminal} is delivered once with no stale attention`, (t) => {
		const f = fixture(t);
		f.status({ state: terminal, steps: [{ agent: "fixture", status: terminal }] });
		f.arm();
		f.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT);
		f.manager.reconcile();
		onlyOutcome(f, outcome);
	});
	test(`G02: terminal ${terminal} must dominate stale attention`, gap("G02"), (t) => {
		const f = fixture(t);
		f.status({ state: terminal, activityState: "needs_attention", steps: [{ agent: "fixture", status: terminal }] });
		f.arm();
		f.manager.reconcile();
		onlyOutcome(f, outcome);
	});
}

test("G03: completed step's stale attention must not block an active next step", gap("G03"), (t) => {
	const f = fixture(t);
	f.status({ mode: "workflow", currentStep: 1, steps: [
		{ agent: "first", status: "complete", activityState: "needs_attention" },
		{ agent: "second", status: "running" },
	] });
	f.arm();
	f.manager.reconcile();
	assert.equal(f.messages.length, 0);
	assert.equal(f.state.waitSubscriptions.size, 1);
});

test("new attention after an observed clear still wakes the same run", (t) => {
	const f = fixture(t);
	f.status({ activityState: "needs_attention" });
	f.arm();
	f.manager.reconcile();
	f.status();
	f.arm();
	f.manager.reconcile();
	assert.equal(f.messages.length, 1);
	f.status({ activityState: "needs_attention" });
	f.manager.reconcile();
	assert.equal(f.messages.length, 2);
	assert.ok(f.messages.every((m) => m.details.outcome === "needs attention"));
});

test("an active step's attention is delivered even when the parent has no activity flag", (t) => {
	const f = fixture(t);
	f.status({ steps: [{ agent: "fixture", status: "running", activityState: "needs_attention" }] });
	f.arm();
	f.manager.reconcile();
	onlyOutcome(f, "needs attention");
});

test("G04: rejected delivery must retain durable evidence, not silently consume the subscription", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const record = f.arm();
	f.rejectDelivery();
	const errors = [];
	t.mock.method(console, "error", (...args) => errors.push(args));
	f.manager.reconcile();
	assert.equal(f.messages.length, 0);
	assert.equal(errors.length, 1);
	assert.ok(existsSync(join(f.subscriptionsDir, `${record.token}.json`)), "Rejected delivery lost its persisted subscription");
});

test("native foreground supervisor attention is not treated as completion", (t) => {
	const f = fixture(t);
	f.state.foregroundRuns.set(RUN, { sessionId: SESSION, children: [
		{ status: "detached", activityState: "needs_attention", currentTool: "contact_supervisor" },
	] });
	f.arm("foreground");
	f.manager.reconcile();
	onlyOutcome(f, "needs attention");
});

test("wait timeout does not terminate or rewrite the running task", (t) => {
	const f = fixture(t);
	f.status();
	const before = readFileSync(f.statusPath, "utf8");
	f.arm();
	f.advance(1000);
	f.manager.reconcile();
	onlyOutcome(f, "timed out");
	assert.equal(readFileSync(f.statusPath, "utf8"), before);
});

test("same-session restore preserves exact target and later completion", (t) => {
	const f = fixture(t);
	f.status();
	const record = f.arm();
	f.restart();
	assert.equal(f.messages.length, 0);
	assert.equal(f.state.waitSubscriptions.get(record.token).runId, RUN);
	f.status({ state: "complete" });
	f.manager.reconcile();
	onlyOutcome(f, "completed");
});

test("foreign session cannot restore or consume another session's subscription", (t) => {
	const f = fixture(t);
	f.status();
	const record = f.arm();
	f.state.currentSessionId = "foreign-session";
	f.restart();
	assert.equal(f.state.waitSubscriptions.size, 0);
	assert.equal(f.messages.length, 0);
	assert.ok(existsSync(join(f.subscriptionsDir, `${record.token}.json`)));
});

test("missing exact target is reported unknown, never completed", (t) => {
	const f = fixture(t);
	f.arm();
	f.manager.reconcile();
	onlyOutcome(f, "could not be reconciled");
});

test("completion replay is attached without losing its archive", (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const replay = writeCompletionReplay({
		resultsDir: f.resultsDir, runId: RUN, sessionId: SESSION,
		completion: { runId: RUN, state: "complete" }, data: {}, now: f.now, ttlMs: 10_000,
	});
	f.arm();
	f.manager.reconcile();
	onlyOutcome(f, "completed");
	assert.deepEqual(f.messages[0].details.completions, [replay.completion]);
	assert.ok(existsSync(replay.archivePath));
});

test("dispose removes timer/event handlers without settling persisted subscriptions", (t) => {
	const f = fixture(t);
	f.status();
	const record = f.arm();
	f.manager.dispose();
	f.status({ state: "complete" });
	f.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT);
	f.manager.reconcile();
	assert.equal(f.messages.length, 0);
	assert.equal(f.events.eventNames().length, 0);
	assert.ok(existsSync(join(f.subscriptionsDir, `${record.token}.json`)));
});

// Every fault is injected locally before/after the public send boundary. A throw
// cannot distinguish rejection from acceptance-then-crash, so absence never means retry.
function rejectNextFsOperation(t, operation, target, armed = () => true) {
	const original = fs[operation];
	let rejected = false;
	const mocked = t.mock.method(fs, operation, (...args) => {
		const file = operation === "renameSync" ? args[1] : args[0];
		if (!rejected && armed() && String(file) === target) {
			rejected = true;
			throw Object.assign(new Error("synthetic filesystem rejection"), { code: "EIO" });
		}
		return original(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

function controlEvent(id, overrides = {}) {
	return { id, type: "needs_attention", to: "needs_attention", runId: RUN, ts: 123,
		index: 0, reason: "supervisor_request", agent: "fixture", message: "synthetic", ...overrides };
}

test("G01: accepted attention survives restore without losing the terminal wait", gap("G01"), (t) => {
	const f = fixture(t);
	f.status({ activityState: "needs_attention" });
	const record = f.arm();
	f.manager.reconcile();
	f.restart();
	assert.equal(f.arm().token, record.token);
	f.manager.reconcile();
	onlyOutcome(f, "needs attention");
	f.status({ state: "complete" });
	f.manager.reconcile();
	assert.deepEqual(f.messages.map((m) => m.details.outcome), ["needs attention", "completed"]);
});

test("G01: a different active step is a new signal without an observed clear", gap("G01"), (t) => {
	const f = fixture(t);
	f.status({ currentStep: 0, activityState: "needs_attention" });
	f.arm(); f.manager.reconcile();
	f.status({ currentStep: 1, activityState: "needs_attention" });
	f.manager.reconcile();
	assert.equal(f.messages.length, 2);
});

test("G01: new foreground supervisor call wakes even if activity never clears", gap("G01"), (t) => {
	const f = fixture(t);
	const child = { status: "detached", activityState: "needs_attention", currentTool: "contact_supervisor", currentToolStartedAt: 10 };
	f.state.foregroundRuns.set(RUN, { sessionId: SESSION, children: [child] });
	f.arm("foreground"); f.manager.reconcile();
	child.currentToolStartedAt = 20;
	f.manager.reconcile();
	assert.equal(f.messages.length, 2);
});

test("G01: ordinary progress counters do not generate new attention", gap("G01"), (t) => {
	const f = fixture(t);
	f.status({ activityState: "needs_attention" });
	f.arm(); f.manager.reconcile();
	for (let i = 1; i <= 19; i++) {
		f.status({ activityState: "needs_attention", lastUpdate: f.now + i, lastActivityAt: f.now + i, toolCount: i, turnCount: i });
		f.arm(); f.manager.reconcile();
	}
	onlyOutcome(f, "needs attention");
});

test("G01: control identity crosses channels once; new request, even at same timestamp, wakes", gap("G01"), (t) => {
	const f = fixture(t);
	f.status({ activityState: "needs_attention" });
	f.arm();
	const event = controlEvent("event-a");
	f.events.emit(SUBAGENT_CONTROL_EVENT, { event });
	f.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, { event });
	f.restart();
	f.events.emit(SUBAGENT_CONTROL_EVENT, { event });
	onlyOutcome(f, "needs attention");
	f.events.emit(SUBAGENT_CONTROL_EVENT, { event: controlEvent("event-b") });
	assert.equal(f.messages.length, 2);
	f.events.emit(SUBAGENT_CONTROL_EVENT, { event });
	assert.equal(f.messages.length, 2, "late replay must not toggle the last signal backward");
});

test("G01: upstream control producer assigns distinct stable event IDs", gap("G01"), () => {
	const input = { runId: RUN, agent: "fixture", to: "needs_attention", ts: 1 };
	const a = buildControlEvent(input), b = buildControlEvent(input);
	assert.match(a.id, /^[a-f0-9-]{36}$/);
	assert.notEqual(a.id, b.id);
	assert.equal(JSON.parse(JSON.stringify(a)).id, a.id);
});

test("G01: control replay history is bounded and contains metadata digests only", gap("G01"), (t) => {
	const f = fixture(t);
	f.status({ activityState: "needs_attention" });
	const r = f.arm();
	for (let i = 0; i < 70; i++) f.events.emit(SUBAGENT_CONTROL_EVENT, { event: controlEvent(`event-${i}`, { message: "synthetic-private-body" }) });
	const record = f.persisted(r.token);
	assert.equal(record.seenControlKeys.length, 64);
	assert.ok(record.seenControlKeys.every((k) => /^[a-f0-9]{64}$/.test(k)));
	assert.ok(!JSON.stringify(record).includes("synthetic-private-body"));
	assert.equal(fs.statSync(join(f.subscriptionsDir, `${r.token}.json`)).mode & 0o777, 0o600);
});

test("G01: unrelated run control does not wake or mutate this subscription", (t) => {
	const f = fixture(t);
	f.status();
	const r = f.arm();
	const before = f.persisted(r.token);
	f.events.emit(SUBAGENT_CONTROL_EVENT, { event: controlEvent("event-a", { runId: "different-run" }) });
	assert.deepEqual(f.persisted(r.token), before);
	assert.equal(f.messages.length, 0);
});

test("G01: repeated re-arm keeps one token and the original bounded deadline", gap("G01"), (t) => {
	const f = fixture(t);
	f.status();
	const a = f.arm();
	f.advance(100);
	const b = f.arm();
	assert.equal(a.token, b.token);
	assert.equal(a.expiresAt, b.expiresAt);
	assert.equal(f.state.waitSubscriptions.size, 1);
});

test("G04: pre-dispatch persistence failure sends nothing and may safely retry persistence", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm();
	t.mock.method(console, "error", () => {});
	rejectNextFsOperation(t, "renameSync", join(f.subscriptionsDir, `${r.token}.json`));
	f.manager.reconcile();
	assert.equal(f.messages.length, 0);
	assert.equal(f.persisted(r.token).delivery, undefined);
	f.manager.reconcile();
	onlyOutcome(f, "completed");
});

test("G04: rejected dispatch stays unknown after restart/expiry and cannot be replayed by re-arm", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm();
	f.rejectDelivery();
	t.mock.method(console, "error", () => {});
	f.manager.reconcile();
	f.advance(2000);
	f.readback();
	f.restart();
	assert.equal(f.messages.length, 0);
	assert.equal(f.persisted(r.token).delivery.state, "unknown");
	assert.match(formatWaitSubscriptions(f.state, f.now), /delivery unknown/);
	assert.throws(() => f.arm(), /unconfirmed/);
});

test("G04: acceptance-then-throw recovers only from matching public session receipt", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm();
	f.onDispatch(() => { throw new Error("synthetic crash after acceptance"); });
	t.mock.method(console, "error", () => {});
	f.manager.reconcile();
	f.readback(); f.restart();
	assert.equal(f.messages.length, 1, "no resend while the queue outcome is unknown");
	assert.equal(f.persisted(r.token).delivery.state, "unknown");
	f.addReceipt(); f.manager.reconcile();
	assert.equal(f.messages.length, 1);
	assert.equal(f.state.waitSubscriptions.size, 0);
	assert.ok(!existsSync(join(f.subscriptionsDir, `${r.token}.json`)));
});

for (const field of ["sessionId", "token", "runId", "attemptId", "outcome"]) {
	test(`G04: receipt with different ${field} cannot acknowledge an unknown attempt`, gap("G04"), (t) => {
		const f = fixture(t);
		f.status({ state: "complete" });
		const r = f.arm();
		f.onDispatch(() => { throw new Error("synthetic post-acceptance crash"); });
		t.mock.method(console, "error", () => {});
		f.manager.reconcile();
		f.readback(); f.addReceipt();
		f.receipts[0].details[field] = "mismatch";
		f.restart();
		assert.equal(f.persisted(r.token).delivery.state, "unknown");
		assert.equal(f.messages.length, 1);
	});
}

test("G04: accepted-marker write failure recovers without replaying accepted content", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm();
	let sent = false;
	f.onDispatch(() => { sent = true; });
	t.mock.method(console, "error", () => {});
	rejectNextFsOperation(t, "renameSync", join(f.subscriptionsDir, `${r.token}.json`), () => sent);
	f.manager.reconcile();
	if (pendingOnly) assert.ok(!existsSync(join(f.subscriptionsDir, `${r.token}.json`)), "receipt permits cleanup without a second persistence phase");
	else assert.equal(f.persisted(r.token).delivery.state, "unknown");
	f.readback(); f.restart();
	assert.equal(f.messages.length, 1);
	f.addReceipt(); f.manager.reconcile();
	assert.equal(f.state.waitSubscriptions.size, 0);
	assert.equal(f.messages.length, 1);
});

test("G04: cleanup failure leaves accepted marker; restore retries cleanup, not send", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm();
	t.mock.method(console, "error", () => {});
	rejectNextFsOperation(t, "unlinkSync", join(f.subscriptionsDir, `${r.token}.json`));
	f.manager.reconcile();
	assert.equal(f.persisted(r.token).delivery.state, dispatchState);
	f.restart();
	onlyOutcome(f, "completed");
	assert.equal(f.state.waitSubscriptions.size, 0);
});

test("G04: send-triggered reentrant reconciliation cannot dispatch twice", (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	f.arm(); f.onDispatch(() => f.manager.reconcile());
	f.manager.reconcile();
	onlyOutcome(f, "completed");
});

test("G04: acknowledged unknown attention keeps the later completion subscription", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ activityState: "needs_attention" });
	const r = f.arm();
	f.onDispatch(() => { throw new Error("synthetic post-acceptance crash"); });
	t.mock.method(console, "error", () => {});
	f.manager.reconcile();
	f.onDispatch(undefined); f.readback(); f.addReceipt(); f.restart();
	assert.equal(f.persisted(r.token).delivery, undefined);
	f.status({ state: "complete" }); f.manager.reconcile();
	assert.deepEqual(f.messages.map((m) => m.details.outcome), ["needs attention", "completed"]);
});

test("G04: foreign-session expiry sweep must not erase unknown delivery evidence", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm();
	f.rejectDelivery(); t.mock.method(console, "error", () => {});
	f.manager.reconcile();
	f.state.currentSessionId = "foreign-session";
	f.advance(2 * 24 * 60 * 60 * 1000); f.restart();
	assert.ok(existsSync(join(f.subscriptionsDir, `${r.token}.json`)));
	assert.equal(f.state.waitSubscriptions.size, 0);
});

test("G04: malformed delivery marker is quarantined, not treated as an armed send", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm();
	const record = f.persisted(r.token);
	record.delivery = { attemptId: "bad", state: "unknown", outcome: "completed", attemptedAt: f.now };
	writeFileSync(join(f.subscriptionsDir, `${r.token}.json`), JSON.stringify(record));
	t.mock.method(console, "error", () => {});
	f.restart();
	assert.equal(f.messages.length, 0);
	assert.ok(existsSync(join(f.subscriptionsDir, `${r.token}.json`)));
});

test("G04: malformed persisted state cannot be bypassed with a new arm", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm();
	const record = f.persisted(r.token);
	record.delivery = { state: "corrupt" };
	writeFileSync(join(f.subscriptionsDir, `${r.token}.json`), JSON.stringify(record));
	f.restart();
	assert.throws(() => f.arm(), /Invalid persisted wait state/);
	assert.equal(f.messages.length, 0);
});

test("G04: receipt outside the bounded branch window does not license a resend", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm(); f.queueOnly(); f.manager.reconcile(); f.addReceipt();
	for (let i = 0; i < 4096; i++) f.receipts.push({ type: "custom", customType: "fixture", data: {} });
	f.restart();
	assert.equal(f.persisted(r.token).delivery.state, dispatchState);
	assert.equal(f.messages.length, 1);
});

test("G04: queue acceptance without a session receipt survives restart without resend", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm(); f.queueOnly();
	f.manager.reconcile();
	assert.equal(f.persisted(r.token).delivery.state, dispatchState);
	f.restart();
	assert.equal(f.messages.length, 1);
	assert.equal(f.state.waitSubscriptions.size, 1);
	f.addReceipt(); f.manager.reconcile();
	assert.equal(f.messages.length, 1);
	assert.equal(f.state.waitSubscriptions.size, 0);
});

test("G04: a correct-looking receipt from another session context is not acknowledgment", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm(); f.queueOnly(); f.manager.reconcile();
	f.addReceipt(); f.readback("foreign-session"); f.restart();
	assert.equal(f.persisted(r.token).delivery.state, dispatchState);
	assert.equal(f.messages.length, 1);
});

test("G04: unavailable receipt readback does not resend or expose error body", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm(); f.queueOnly(); f.manager.reconcile();
	const errors = [];
	t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
	f.state.lastUiContext.sessionManager.getBranch = () => { throw new Error("synthetic-private-body"); };
	f.restart();
	assert.equal(f.persisted(r.token).delivery.state, dispatchState);
	assert.equal(f.messages.length, 1);
	assert.ok(!errors.join("\n").includes("synthetic-private-body"));
});

test("legacy v1 subscriptions can migrate without using real runtime files", (t) => {
	const f = fixture(t);
	f.status();
	const r = f.arm();
	writeFileSync(join(f.subscriptionsDir, `${r.token}.json`), JSON.stringify({ ...f.persisted(r.token), version: 1 }));
	f.restart();
	f.status({ state: "complete" }); f.manager.reconcile();
	onlyOutcome(f, "completed");
});

test("G04 ablation: a visible terminal receipt needs no queue-acceptance persistence", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm();
	const target = join(f.subscriptionsDir, `${r.token}.json`);
	const original = fs.renameSync;
	let writes = 0;
	const mocked = t.mock.method(fs, "renameSync", (...args) => {
		if (String(args[1]) === target) writes++;
		return original(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
	f.manager.reconcile();
	assert.equal(writes, pendingOnly ? 1 : 2);
	assert.equal(f.messages.length, 1);
	assert.equal(f.state.waitSubscriptions.size, 0);
	assert.ok(!existsSync(target));
});

test("G04 ablation: earlier accepted records still require the exact receipt", gap("G04"), (t) => {
	const f = fixture(t);
	f.status({ state: "complete" });
	const r = f.arm(); f.queueOnly(); f.manager.reconcile();
	const record = f.persisted(r.token);
	record.delivery.state = "accepted";
	writeFileSync(join(f.subscriptionsDir, `${r.token}.json`), JSON.stringify(record));
	f.restart();
	assert.equal(f.messages.length, 1);
	assert.equal(f.state.waitSubscriptions.size, 1);
	f.addReceipt(); f.manager.reconcile();
	assert.equal(f.state.waitSubscriptions.size, 0);
	assert.equal(f.messages.length, 1);
});
