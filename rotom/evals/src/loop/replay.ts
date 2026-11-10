/**
 * Replay one recorded failure against a frozen product in an isolated copy of the project.
 *
 * Every rule here exists because a replay runs a real model with real tools on a real checkout:
 *
 * - the branch is cut from the incident session itself, so the model sees the same history the
 *   user saw, and the failing message is the only new turn;
 * - the worktree is pinned to the last commit before the session started, and its remotes are
 *   removed, so nothing can be published from it;
 * - the child process gets a scrubbed environment and its own HOME, so tool subprocesses never
 *   inherit provider credentials or npm/github/aws tokens;
 * - a shell shim refuses the commands that would leave the sandbox and reports the refusal in the
 *   transcript instead of silently running them.
 *
 * This module is the pure part: cutting, scrubbing, refusing and planning. Driving the product
 * lives in `replay-run.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const REPLAY_TOOLS = ["read", "edit", "bash"] as const;

/** Environment names that never reach a replay child process. */
const SECRET_NAME = /(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)S?$/u;
const SECRET_PREFIX = /^(?:NPM_|GH_|GITHUB_|AWS_|SSH_AUTH_SOCK$|ANTHROPIC_|OPENAI_)/u;

/** A minimal environment: the child builds its own HOME and PATH, nothing else is inherited. */
export function scrubbedEnvironment(parent: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
	const kept: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TERM", "SHELL", "USER", "LOGNAME", "TZ"]) {
		const value = parent[name];
		if (value !== undefined) kept[name] = value;
	}
	for (const [name, value] of Object.entries(parent)) {
		if (SECRET_NAME.test(name) || SECRET_PREFIX.test(name)) continue;
		if (name.startsWith("PI_") || name.startsWith("ROTOM_OBSERVABILITY")) continue;
		if (kept[name] !== undefined) continue;
	}
	return { ...kept, HOME: home, PI_CODING_AGENT_DIR: resolve(home, "..", "agent"), ROTOM_OBSERVABILITY: "0" };
}

export type Refusal = { rule: string; command: string };

const REFUSALS: readonly (readonly [string, RegExp])[] = [
	["git push", /\bgit\b[^;&|]*\bpush\b/u],
	["npm publish", /\bnpm\b[^;&|]*\bpublish\b/u],
	["gh", /(?:^|[;&|]\s*|\b)(?:gh\s)/u],
	["ssh", /(?:^|[;&|]\s*)\bssh\b/u],
	["scp", /(?:^|[;&|]\s*)\bscp\b/u],
	["rsync", /(?:^|[;&|]\s*)\brsync\b/u],
	["curl/wget write", /\b(?:curl|wget)\b[^;&|]*(?:-X\s*(?:POST|PUT|DELETE|PATCH)|--request\s*(?:POST|PUT|DELETE|PATCH)|(?:^|\s)(?:-d|--data|-F|--form|-T|--upload-file|-e|--post-data|--post-file)\b)/iu],
];

/** The shell shim reads the same rules, so a command the plan refuses cannot run by accident. */
export function refusalFor(command: string): Refusal | undefined {
	for (const [rule, pattern] of REFUSALS) if (pattern.test(command)) return { rule, command };
	return undefined;
}

/** The shim text is generated from the rule list so the two cannot drift. */
export function sandboxShim(): string {
	return [
		"# Replay sandbox: refuse commands that would leave the isolated worktree.",
		"_rotom_refuse() { printf 'replay-sandbox: refused %s\\n' \"$1\" >&2; return 97; }",
		"git() { case \"$1\" in push) _rotom_refuse 'git push'; return 97;; esac; command git \"$@\"; }",
		"npm() { case \"$1\" in publish) _rotom_refuse 'npm publish'; return 97;; esac; command npm \"$@\"; }",
		"gh() { _rotom_refuse \"gh $*\"; }",
		"ssh() { _rotom_refuse 'ssh'; }",
		"scp() { _rotom_refuse 'scp'; }",
		"rsync() { _rotom_refuse 'rsync'; }",
		"curl() { case \" $* \" in *' -X '*'POST'*|*' -X '*'PUT'*|*' -X '*'DELETE'*|*' -X '*'PATCH'*|*' --data'*|*' -d '*) _rotom_refuse 'curl write'; return 97;; esac; command curl \"$@\"; }",
		"wget() { case \" $* \" in *' --post-data'*|*' --post-file'*) _rotom_refuse 'wget write'; return 97;; esac; command wget \"$@\"; }",
	].join("\n");
}

export type Branch = { lines: string[]; entryId: string; message: string; userTurns: number };

type Entry = { type?: string; id?: string; message?: { role?: string; content?: unknown } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("");
}

/**
 * Everything before the failing user message, and the message itself. The session header stays:
 * a branch file is a valid session file, so the product resumes it instead of starting fresh.
 */
export function cutBranch(lines: readonly string[], entryId: string): Branch {
	const [header, ...rest] = lines.filter((line) => line.trim());
	if (!header) throw new Error("replay: empty session file");
	const parsed: Entry[] = [];
	for (const [index, line] of [header, ...rest].entries()) {
		try {
			parsed.push(JSON.parse(line) as Entry);
		} catch {
			throw new Error(`replay: session line ${index + 1} is not JSON`);
		}
	}
	if (parsed[0]?.type !== "session" || typeof parsed[0].id !== "string") throw new Error("replay: session file has no session header");
	const target = parsed.findIndex((entry, index) => index > 0 && entry.id === entryId);
	if (target < 0) throw new Error(`replay: no entry ${entryId} in this session file`);
	const failing = parsed[target];
	if (failing.type !== "message" || failing.message?.role !== "user") throw new Error(`replay: entry ${entryId} is ${failing.type}/${failing.message?.role ?? "?"}, not a user message`);
	const message = textOf(failing.message.content);
	if (!message.trim()) throw new Error(`replay: entry ${entryId} has no text`);
	const kept = [header, ...rest.slice(0, target - 1)];
	const userTurns = parsed.slice(1, target).filter((entry) => entry.type === "message" && entry.message?.role === "user").length;
	return { lines: kept, entryId, message, userTurns };
}

/** Last commit at or before the given instant; `undefined` when the repository cannot answer. */
export function timepoint(git: (args: string[]) => string, iso: string): string | undefined {
	if (Number.isNaN(Date.parse(iso))) return undefined;
	try {
		const sha = git(["rev-list", "-1", `--before=${iso}`, "HEAD"]).trim();
		return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
	} catch {
		return undefined;
	}
}

/** A checkout is only usable when it is a git work tree inside the repository root, not a bare dir. */
export function repositoryCheck(git: (args: string[]) => string, cwd: string): { root: string } | { reason: string } {
	if (!existsSync(cwd)) return { reason: `session cwd ${cwd} no longer exists` };
	try {
		const inside = git(["rev-parse", "--is-inside-work-tree"]).trim();
		if (inside !== "true") return { reason: `${cwd} is not a git work tree` };
		const root = git(["rev-parse", "--show-toplevel"]).trim();
		return { root };
	} catch {
		return { reason: `${cwd} is not a git repository` };
	}
}

/** `.env*` files and `.npmrc` stay behind: a replay must not republish anyone's settings or tokens. */
export function forbiddenCopies(worktree: string, files: readonly string[]): string[] {
	return files.filter((file) => {
		const name = file.split("/").at(-1) ?? file;
		return name === ".npmrc" || name.startsWith(".env");
	}).map((file) => relative(worktree, resolve(worktree, file)));
}

export type ReplayPlan = {
	incidentId: string;
	sessionFile: string;
	cwd: string;
	repoRoot: string;
	commit: string;
	branch: Branch;
	/** Product directories to replay against: the frozen one first. */
	products: { label: string; directory: string }[];
	repeats: number;
	/** The provider/model the incident session itself used; a replay never switches models. */
	model: { provider: string; model: string };
};

export function describePlan(plan: ReplayPlan): string[] {
	return [
		`incident ${plan.incidentId} from ${plan.sessionFile}`,
		`cwd ${plan.cwd} @ ${plan.commit.slice(0, 12)} (${plan.repoRoot})`,
		`branch: ${plan.branch.lines.length} entries, ${plan.branch.userTurns} earlier user turns, failing message ${plan.branch.message.length} chars`,
		`products: ${plan.products.map((product) => `${product.label}=${product.directory}`).join(" ")}`,
		`repeats: ${plan.repeats}`,
	];
}

/** Reads a session file only to cut the branch; the file itself is never modified. */
export function readBranch(sessionFile: string, entryId: string): Branch {
	return cutBranch(readFileSync(sessionFile, "utf8").split("\n"), entryId);
}

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

export type NewTurnStats = {
	/** Assistant messages after the cut, i.e. the turns this replay produced. */
	assistantMessages: number;
	toolCalls: number;
	toolCallNames: Record<string, number>;
	/** Summed over the new assistant messages only. */
	usage: TurnUsage;
};

/**
 * Statistics for the replay's own turns. The replayed session carries the whole branch as restored
 * context, so counting every entry would report the incident's history as the replay's work; the
 * cut entry is the boundary and everything at or before it is history.
 */
export function newTurnStats(sessionText: string, entryId: string): NewTurnStats {
	const lines = sessionText.split("\n").filter(Boolean);
	const cut = lines.findIndex((line) => {
		try {
			return (JSON.parse(line) as { id?: string }).id === entryId;
		} catch {
			return false;
		}
	});
	const stats: NewTurnStats = { assistantMessages: 0, toolCalls: 0, toolCallNames: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
	for (const line of lines.slice(cut + 1)) {
		let entry: { message?: { role?: string; content?: unknown; usage?: Partial<TurnUsage> } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue; // A torn final line from a killed run is expected.
		}
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		stats.assistantMessages += 1;
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if ((part as { type?: string }).type !== "toolCall") continue;
				const name = String((part as { name?: unknown }).name ?? "unknown");
				stats.toolCalls += 1;
				stats.toolCallNames[name] = (stats.toolCallNames[name] ?? 0) + 1;
			}
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
			const value = message.usage?.[key];
			if (typeof value === "number" && Number.isFinite(value)) stats.usage[key] += value;
		}
	}
	return stats;
}

/** Outcome of the event's deterministic check, run inside the replay workspace. */
export type CheckVerdict = "pass" | "fail" | "unknown";

export type Admission = { verdict: "reproduced" | "not-reproduced" | "unknown"; passed: number; failed: number; unknown: number; total: number };

/**
 * `reproduced (replay)` means the failure still shows up here: at least three of five runs end with
 * the check failing. A run whose check never produced a verdict is not counted as either side; when
 * unknowns keep either side below the threshold the admission is `unknown`, not a quiet pass.
 */
export function admissionFor(verdicts: readonly CheckVerdict[], threshold = 3): Admission {
	const passed = verdicts.filter((verdict) => verdict === "pass").length;
	const failed = verdicts.filter((verdict) => verdict === "fail").length;
	const unknown = verdicts.filter((verdict) => verdict === "unknown").length;
	const total = verdicts.length;
	const verdict: Admission["verdict"] = failed >= threshold ? "reproduced" : passed >= threshold ? "not-reproduced" : "unknown";
	return { verdict, passed, failed, unknown, total };
}
