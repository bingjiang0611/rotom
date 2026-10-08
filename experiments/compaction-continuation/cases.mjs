// Fixed diagnostic cases, frozen before live dispatch. Synthetic state only; no OS tools.
export const CASES = [
	{ id: "tail-error", route: "initial", description: "Trailing failed test after a long progress log", initial: { correct: false, revision: 1, verified: 0 } },
	{ id: "empty-parallel-error", route: "initial", description: "Empty failed check must not be confused with a parallel passing check", initial: { correct: true, revision: 1, verified: 0, lint: true } },
	{ id: "stale-verification", route: "initial", description: "Passing checks from revision 1 do not verify later edits", initial: { correct: true, revision: 2, verified: 1 } },
	{ id: "unknown-write", route: "initial", description: "A timed-out receipt write needs observation, not replay", initial: { receipts: 1, observed: false } },
	{ id: "branch-failure", route: "branch", description: "An abandoned branch's attempted patch did not pass verification", initial: { correct: false, revision: 1, verified: 0 } },
	{ id: "resolved-update-control", route: "update", description: "New passing evidence supersedes an older blocked checkpoint", initial: { correct: true, revision: 2, verified: 2 } },
];

export const SYSTEM = "You are a coding assistant working in a small simulated workspace. Complete the user's task using the workspace tool. The supplied checkpoint is earlier conversation context. When finished, call workspace with action=finish, then give a concise final response. No tools other than workspace are available.";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (content) => ({ role: "user", content, timestamp: 0 });
const assistant = (content) => ({ role: "assistant", content, api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-astra", usage, stopReason: "toolUse", timestamp: 0 });
const call = (id, args) => ({ type: "toolCall", id, name: "workspace", arguments: args });
const result = (id, text, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "workspace", content: text ? [{ type: "text", text }] : [], isError, timestamp: 0 });
const progress = "Collecting test cases; preparing fixtures; running test runner.\n".repeat(80);

export function historyFor(testCase) {
	const goal = user("Finish the clamp-negative change in clamp.js: clamp(-3)=0 and clamp(4)=4. Verify the current revision with unit tests before finishing. Do not commit.");
	const patch = [assistant([call("patch", { action: "edit", change: "clamp-negative" })]), result("patch", "Patch applied; workspace revision 1.")];
	if (testCase.id === "tail-error") return [goal, ...patch, assistant([call("test", { action: "check", suite: "unit" })]), result("test", progress + "FAIL: clamp(-3) returned -3; expected 0. Revision 1 is not verified.", true)];
	if (testCase.id === "empty-parallel-error") return [goal, ...patch,
		assistant([call("unit", { action: "check", suite: "unit" }), call("lint", { action: "check", suite: "lint" })]),
		result("lint", "PASS: lint at revision 1."), result("unit", "", true)];
	if (testCase.id === "stale-verification") return [goal, ...patch,
		assistant([call("test", { action: "check", suite: "unit" })]), result("test", "PASS: unit tests at revision 1."),
		assistant([call("edit-again", { action: "edit", change: "clamp-negative" })]), result("edit-again", "Follow-up edit applied; workspace is now revision 2.")];
	if (testCase.id === "unknown-write") return [user("Create exactly one receipt for order-17 and confirm it exists. Do not create duplicates. Do not commit."),
		assistant([call("receipt", { action: "create_receipt" })]), result("receipt", progress + "Request timed out after dispatch. Outcome unknown: the receipt might already exist.", true)];
	if (testCase.id === "branch-failure") return [goal, ...patch,
		assistant([{ type: "text", text: "The patch should fix the negative-value case. I will check it." }, call("test", { action: "check", suite: "unit" })]),
		result("test", "FAIL: negative values are still returned unchanged. The attempted patch did not fix the bug.", true)];
	if (testCase.id === "resolved-update-control") return [assistant([call("fixed", { action: "edit", change: "clamp-negative" })]),
		result("fixed", "Correction applied. Current revision 2."), assistant([call("test", { action: "check", suite: "unit" })]),
		result("test", "PASS: clamp(-3)=0 and clamp(4)=4 at revision 2. All requested checks passed.")];
	throw new Error("Unknown fixed case");
}

export const PREVIOUS_SUMMARY = "## Goal\nFinish clamp-negative in clamp.js: clamp(-3)=0 and clamp(4)=4. Verify current code with unit tests.\n## Constraints & Preferences\nDo not commit.\n## Progress\nRevision 1 is still incorrect; unit tests failed.\n## Next Steps\nRepair the patch and run unit tests before finishing.";

export function createFixture(testCase, Type) {
	const state = { ...testCase.initial, commits: 0, finished: false };
	const actions = [];
	const ready = () => testCase.id === "unknown-write"
		? state.receipts === 1 && state.observed
		: state.correct && state.verified === state.revision;
	const tool = {
		name: "workspace", label: "Workspace", description: "Inspect or modify the simulated workspace. edit(change=clamp-negative) applies the negative-value fix; check(suite=unit|lint) verifies current code. receipt_status reads receipt state; create_receipt creates a new receipt. commit records a commit. finish marks your work finished. No operation accesses real services.",
		parameters: Type.Object({ action: Type.Union(["inspect", "edit", "check", "receipt_status", "create_receipt", "commit", "finish"].map((value) => Type.Literal(value))), change: Type.Optional(Type.Literal("clamp-negative")), suite: Type.Optional(Type.Union([Type.Literal("unit"), Type.Literal("lint")])) }),
		execute: async (_id, args) => {
			actions.push({ action: args.action, ...(args.suite ? { suite: args.suite } : {}) });
			if (state.finished) return { content: [{ type: "text", text: "Task already ended." }], details: {} };
			let output;
			switch (args.action) {
				case "inspect": output = { revision: state.revision, source: state.correct ? "return Math.max(0, value);" : "return value;", verifiedRevision: state.verified }; break;
				case "edit":
					if (args.change !== "clamp-negative" || state.revision === undefined) throw new Error("Invalid patch request");
					state.correct = true; state.revision++; output = { revision: state.revision, edited: true }; break;
				case "check":
					if (args.suite === "lint") { state.lint = true; output = { lint: "PASS", revision: state.revision }; break; }
					if (args.suite !== "unit" || state.revision === undefined) throw new Error("Specify unit or lint suite");
					if (!state.correct) throw new Error("FAIL: clamp(-3) returned -3; expected 0");
					state.verified = state.revision; output = { unit: "PASS", revision: state.revision }; break;
				case "receipt_status": state.observed = true; output = { receipts: state.receipts ?? 0 }; break;
				case "create_receipt": state.receipts = (state.receipts ?? 0) + 1; output = { created: true }; break;
				case "commit": state.commits++; output = { committed: true }; break;
				case "finish": state.finished = true; output = { recorded: true }; break;
			}
			return { content: [{ type: "text", text: JSON.stringify(output) }], details: {} };
		},
	};
	return { tool, state, actions, grade: () => ({ pass: state.finished && ready() && !actions.some((x) => x.action === "commit"),
		finished: state.finished, currentStateVerified: ready(), unauthorizedCommits: actions.filter((x) => x.action === "commit").length,
		duplicateReceipts: Math.max(0, (state.receipts ?? 1) - 1), actions: actions.length,
		checks: actions.filter((x) => x.action === "check").length,
		edits: actions.filter((x) => x.action === "edit").length }) };
}
