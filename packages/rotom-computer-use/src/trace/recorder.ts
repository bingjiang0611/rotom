/**
 * Local Computer Use trace.
 *
 * Scope note: root `CLAUDE.md` §5 forbids recording prompts, tool arguments and
 * tool results. This recorder is the user-approved exception, limited to
 * Computer Use, because a UI trace without the evidence (which control was hit,
 * what the screen looked like) cannot answer "why did the agent do that".
 * The exception has hard limits, enforced here and tested in `test/trace.test.ts`:
 *
 *   - Text the agent typed is never written; only its length and SHA-256.
 *   - Only Desktop observation evidence is kept, never model or prompt text.
 *   - Files are private (`0700` dirs, `0600` files), symlinks are refused,
 *     retained for `retentionMs` and capped per session, and never uploaded.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const TRACE_ROOT_ENV = "ROTOM_CU_TRACE";
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_CAP_BYTES = 500 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 8 * 1024;

/** Parameter names whose values are typed text and must never be stored. */
/**
 * Keys whose value is safe to store verbatim.
 *
 * This is an allowlist on purpose (review I1): a denylist always misses the next
 * tool parameter, and `navigate_browser.url`, `evaluate_browser.expression`,
 * `select.option`, `keypress.keys` and `manage_app.path` were all being written in
 * clear. Anything not listed here is reduced to a length and a SHA-256 digest.
 */
const PLAIN_PARAM_KEYS = new Set([
	// identity and structure
	"id",
	"stateId",
	"lookId",
	"ref",
	"targetRef",
	"scopeRef",
	"rootRef",
	"windowRef",
	"role",
	"subrole",
	"action",
	"mode",
	"tool",
	"surface",
	"name",
	"kind",
	// numbers and coordinates
	"x",
	"y",
	"w",
	"h",
	"width",
	"height",
	"maxDimension",
	"deltaX",
	"deltaY",
	"scrollX",
	"scrollY",
	"amount",
	"clickCount",
	"pid",
	"windowId",
	"displayId",
	"ttlMs",
	"timeoutMs",
	"limit",
	"offset",
	// booleans and enums
	"includeImage",
	"readText",
	"policy",
	"delivery",
	"button",
	"checked",
	"force",
	"activates",
	"restore",
	"preserveFocus",
	"cursorOverlay",
	"baseEpoch",
	"epoch",
]);

function isPlainParamKey(key: string): boolean {
	return PLAIN_PARAM_KEYS.has(key);
}

export interface TraceTargetSummary {
	role?: string;
	label?: string;
	ref?: string;
	app?: string;
	window?: string;
}

export interface TraceEntry {
	/** Tool that produced this entry. */
	tool: string;
	/** Resolved target summary (never the full outline). */
	target?: TraceTargetSummary;
	/** L1 / L2 / L4 delivery level when the platform reports it. */
	deliveryLevel?: string;
	status: "ok" | "error" | "unknown" | "lease_conflict" | "stopped";
	durationMs?: number;
	/** Lease/epoch evidence for writes. */
	lease?: { agentId?: string; epoch?: number; holder?: string };
	/**
	 * Administrative handover of a lease to another agent.
	 *
	 * `cu_session transfer` moves a write lease between agents, and this is the only
	 * record of who moved it: ids and resource keys, no content (review Q2).
	 */
	transfer?: { action: "transfer"; toAgentId: string; resourceKey: string; oldLeaseId: string; newLeaseId?: string };
	/** Short evidence line (state id, ref count, error code) — never a payload. */
	evidence?: string;
	screenshots?: string[];
	/** Redacted text-input evidence. */
	text?: { length: number; sha256: string };
	/** Why an agent clipboard write was not undone (reason code only, no content). */
	clipboardRestoreSkipped?: "user_changed_clipboard" | "no_snapshot" | "restore_failed" | "lease_unavailable";
	/** Set when the broker paused this agent because an action disturbed the user. */
	paused?: { reason: "interfered_with_user"; at: number };
}

export interface TraceOptions {
	sessionId: string;
	agentId: string;
	/** Also honors ROTOM_CU_TRACE=0 through `resolveTraceRoot`. */
	root?: string;
	enabled?: boolean;
	now?: () => number;
	retentionMs?: number;
	capBytes?: number;
}

export class TraceUnsafePathError extends Error {}

export function resolveTraceRoot(environment: NodeJS.ProcessEnv = process.env): string | undefined {
	if (parseToggle(environment[TRACE_ROOT_ENV]) === false) return undefined;
	return path.join(homedir(), ".rotom", "computer-use", "traces");
}

function parseToggle(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") return false;
	if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes") return true;
	return undefined;
}

/** Keep user-controlled ids from escaping the trace root or becoming globs. */
export function safeSegment(value: string): string {
	const trimmed = value.trim() || "unknown";
	const cleaned = trimmed.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
	const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 8);
	return `${cleaned}--${digest}`;
}

export function redactText(value: string): { length: number; sha256: string } {
	return { length: [...value].length, sha256: createHash("sha256").update(value).digest("hex") };
}

/** Replace typed text with its digest before anything is written. */
export function redactParams(params: unknown): unknown {
	if (Array.isArray(params)) return params.map((item) => redactParams(item));
	if (!params || typeof params !== "object") return params;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
		if (!isPlainParamKey(key) && typeof value === "string") out[key] = redactText(value);
		else if (!isPlainParamKey(key) && Array.isArray(value)) out[key] = value.map((item) => (typeof item === "string" ? redactText(item) : redactParams(item)));
		else out[key] = redactParams(value);
	}
	return out;
}

/**
 * Refuse a symlinked trace root or any symlinked component below it.
 *
 * The walk starts at the root, never at `/`: `$TMPDIR` and other legitimate
 * parents are symlinks on macOS and must not be mistaken for an attack.
 */
function assertNoSymlinkBelow(root: string, target: string): void {
	if (isSymlink(root)) throw new TraceUnsafePathError(`Refusing to write Computer Use trace through symlink: ${root}`);
	const relative = path.relative(root, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new TraceUnsafePathError(`Refusing to write Computer Use trace outside its root: ${target}`);
	}
	let current = root;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (isSymlink(current)) throw new TraceUnsafePathError(`Refusing to write Computer Use trace through symlink: ${current}`);
	}
}

function isSymlink(target: string): boolean {
	try {
		return lstatSync(target).isSymbolicLink();
	} catch {
		return false;
	}
}

function ensurePrivateDir(root: string, dir: string): void {
	assertNoSymlinkBelow(root, dir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** One JSONL file per agent, screenshots in the sibling `shots/` directory. */
export class TraceRecorder {
	private readonly root: string;
	private readonly file: string;
	private readonly shotDir: string;
	private readonly now: () => number;
	private readonly retentionMs: number;
	private readonly capBytes: number;
	private writes = 0;
	private failures = 0;
	private closed = false;
	private shotIndex = 0;

	constructor(root: string, sessionDir: string, options: TraceOptions) {
		this.now = options.now ?? Date.now;
		this.retentionMs = options.retentionMs ?? RETENTION_MS;
		this.capBytes = options.capBytes ?? SESSION_CAP_BYTES;
		this.root = root;
		const agent = safeSegment(options.agentId);
		ensurePrivateDir(root, sessionDir);
		this.file = path.join(sessionDir, `${agent}.jsonl`);
		this.shotDir = path.join(sessionDir, "shots");
		assertNoSymlinkBelow(root, this.file);
	}

	static create(options: TraceOptions): TraceRecorder | undefined {
		if (options.enabled === false) return undefined;
		const root = options.root ?? resolveTraceRoot();
		if (!root) return undefined;
		const recorder = new TraceRecorder(root, path.join(root, safeSegment(options.sessionId)), options);
		recorder.prune();
		return recorder;
	}

	get filePath(): string {
		return this.file;
	}

	get shotsDir(): string {
		return this.shotDir;
	}

	get sessionDir(): string {
		return path.dirname(this.file);
	}

	get stats(): { writes: number; failures: number } {
		return { writes: this.writes, failures: this.failures };
	}

	record(entry: TraceEntry): void {
		if (this.closed) return;
		try {
			const payload = JSON.stringify({ ts: new Date(this.now()).toISOString(), ...entry });
			const line = payload.length > MAX_ENTRY_BYTES ? `${payload.slice(0, MAX_ENTRY_BYTES)}…"}` : payload;
			// append mode keeps the file private after creation (0600 below).
			const created = existsSync(this.file) ? undefined : openSync(this.file, "wx", 0o600);
			if (created !== undefined) closeSync(created);
			const fd = openSync(this.file, "a", 0o600);
			try {
				writeSync(fd, `${line}\n`);
			} finally {
				closeSync(fd);
			}
			this.writes += 1;
		} catch {
			// A broken trace must never break the agent's action; the failure count
			// is the only visible signal, and it stays metadata-only.
			this.failures += 1;
		}
	}

	/** Save observation bytes for this run; returns the path relative to the session dir. */
	saveScreenshot(base64: string, extension = "jpg"): string | undefined {
		if (this.closed || !base64) return undefined;
		try {
			ensurePrivateDir(this.root, this.shotDir);
			this.shotIndex += 1;
			const name = `shots/${String(this.shotIndex).padStart(4, "0")}-${this.now()}.${extension}`;
			const target = path.join(path.dirname(this.shotDir), name);
			assertNoSymlinkBelow(this.root, target);
			const fd = openSync(target, "wx", 0o600);
			try {
				writeSync(fd, Buffer.from(base64, "base64"));
			} finally {
				closeSync(fd);
			}
			if (statSync(target).size + this.sessionBytes() > this.capBytes) this.pruneShots();
			return name;
		} catch {
			this.failures += 1;
			return undefined;
		}
	}

	/** Drop expired session directories and enforce the per-session byte cap. */
	prune(): void {
		const sessionDir = path.dirname(this.file);
		const root = path.dirname(sessionDir);
		const cutoff = this.now() - this.retentionMs;
		for (const name of readDirSafe(root)) {
			const dir = path.join(root, name);
			if (!statSafe(dir)?.isDirectory()) continue;
			if (dir === sessionDir) continue;
			const mtime = statSafe(dir)?.mtimeMs ?? 0;
			if (mtime && mtime < cutoff) rmSafe(dir);
		}
		while (this.sessionBytes() > this.capBytes) {
			if (!this.pruneShots()) break;
		}
	}

	private pruneShots(): boolean {
		const shots = readDirSafe(this.shotDir)
			.map((name) => ({ name, stat: statSafe(path.join(this.shotDir, name)) }))
			.filter((entry): entry is { name: string; stat: NonNullable<ReturnType<typeof statSafe>> } => Boolean(entry.stat?.isFile()))
			.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
		const oldest = shots[0];
		if (!oldest) return false;
		rmSafe(path.join(this.shotDir, oldest.name));
		return true;
	}

	private sessionBytes(): number {
		const sessionDir = path.dirname(this.file);
		return sumDir(sessionDir, 0) + sumDir(this.shotDir, 0);
	}

	/** Read back this agent's entries; used by `cu_session trace_export`. */
	read(): TraceEntry[] {
		if (!existsSync(this.file)) return [];
		return readFileSync(this.file, "utf-8")
			.split("\n")
			.flatMap((line) => {
				if (!line.trim()) return [];
				try {
					return [JSON.parse(line) as TraceEntry];
				} catch {
					return [];
				}
			});
	}

	close(): void {
		this.closed = true;
	}
}

function readDirSafe(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => !name.startsWith("."));
	} catch {
		return [];
	}
}

function statSafe(target: string): ReturnType<typeof statSync> | undefined {
	try {
		return statSync(target);
	} catch {
		return undefined;
	}
}

function sumDir(dir: string, depth: number): number {
	if (depth > 2) return 0;
	let total = 0;
	for (const name of readDirSafe(dir)) {
		const target = path.join(dir, name);
		const stat = statSafe(target);
		if (!stat) continue;
		total += stat.isDirectory() ? sumDir(target, depth + 1) : stat.size;
	}
	return total;
}

function rmSafe(target: string): void {
	try {
		rmSync(target, { recursive: true, force: true });
	} catch {
		// Retention is best effort; a file held open elsewhere is not fatal.
	}
}
