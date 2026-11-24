/**
 * Frozen baselines for `loop gate`: one detached worktree per commit under the private loop
 * directory, installed from its own locks and checked with the gate's preflight.
 *
 * A gate compares against a product that must not move while a fix is being tuned. Building
 * that product by hand (worktree, two installs, an absolute path to remember) was the step
 * that kept gates from being run, so it is one command here and `gate` reads the result.
 *
 * Nothing is deleted: a directory that exists but is not a usable product is refused with its
 * path, because a worktree may hold someone's work.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isProductDirectory, preflightFailure, preflightGate, type PreflightProblem } from "./gate-preflight.ts";

export const FROZEN_SCHEMA = "rotom-loop-frozen/v1";

export type FrozenBaseline = { schema: typeof FROZEN_SCHEMA; ref: string; sha: string; product: string; frozenAt: string };

/** Injected so tests assert the exact commands instead of running git and npm. */
export type Run = (command: string, args: readonly string[]) => { status: number | null; stdout: string };

/** The two installs a product needs before it can start, with the flags the loop documents. */
const INSTALLS: Record<string, readonly string[]> = {
	"runtime/pi": ["ci", "--ignore-scripts"],
	"extensions/third-party": ["ci", "--ignore-scripts", "--omit=optional", "--legacy-peer-deps"],
};

const pointer = (loopDir: string) => join(loopDir, "frozen", "latest.json");

function problemsOf(product: string): PreflightProblem[] {
	return preflightGate([{ product, label: "baseline" }]).problems;
}

export function freezeBaseline(options: { ref: string; repoRoot: string; loopDir: string; run: Run; now?: Date; check?: (product: string) => PreflightProblem[] }): FrozenBaseline & { reused: boolean } {
	const { ref, repoRoot, loopDir, run } = options;
	const check = options.check ?? problemsOf;
	// A ref is passed to git as an argument; one that starts with a dash would be read as an option.
	if (!ref || ref.startsWith("-")) throw new Error("freeze needs a commit, tag or branch name");
	const resolved = run("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	const sha = resolved.status === 0 ? resolved.stdout.trim() : "";
	if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`freeze: ${ref} is not a commit in ${repoRoot}`);
	const directory = join(loopDir, "frozen", sha);
	const product = join(directory, "rotom");
	const existed = existsSync(directory);
	if (!existed) {
		mkdirSync(join(loopDir, "frozen"), { recursive: true, mode: 0o700 });
		if (run("git", ["-C", repoRoot, "worktree", "add", "--detach", directory, sha]).status !== 0) throw new Error(`freeze: git could not create a worktree at ${directory}`);
	}
	if (!isProductDirectory(product)) throw new Error(`freeze: ${directory} exists but holds no rotom product; inspect it and remove it yourself before freezing again`);
	let problems = check(product);
	const reused = existed && problems.length === 0;
	// Only the directories the preflight named are reinstalled, so a second freeze of the same
	// commit costs nothing and a half-installed one is repaired instead of rebuilt.
	for (const target of new Set(problems.map((problem) => problem.directory))) {
		const args = INSTALLS[target];
		if (!args) continue;
		if (run("npm", ["--prefix", join(product, target), ...args]).status !== 0) throw new Error(`freeze: npm ci failed in ${join(product, target)}`);
	}
	if (problems.length > 0) problems = check(product);
	if (problems.length > 0) throw new Error(preflightFailure(problems));
	const frozen: FrozenBaseline = { schema: FROZEN_SCHEMA, ref, sha, product, frozenAt: (options.now ?? new Date()).toISOString() };
	writeFileSync(pointer(loopDir), `${JSON.stringify(frozen, null, 2)}\n`, { mode: 0o600 });
	return { ...frozen, reused };
}

/**
 * The baseline the last `freeze` produced, or `undefined` when none was ever frozen. A pointer
 * that no longer names a product is an error rather than `undefined`: silently falling back
 * would let a gate run against nothing the user chose.
 */
export function latestFrozen(loopDir: string): FrozenBaseline | undefined {
	const path = pointer(loopDir);
	if (!existsSync(path)) return undefined;
	let value: Partial<FrozenBaseline>;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as Partial<FrozenBaseline>;
	} catch {
		throw new Error(`frozen baseline pointer ${path} is not JSON; run \`loop freeze <ref>\` again`);
	}
	if (value.schema !== FROZEN_SCHEMA || typeof value.sha !== "string" || !/^[0-9a-f]{40}$/u.test(value.sha) || typeof value.product !== "string" || !isAbsolute(value.product) || typeof value.ref !== "string" || typeof value.frozenAt !== "string") {
		throw new Error(`frozen baseline pointer ${path} is malformed; run \`loop freeze <ref>\` again`);
	}
	if (!isProductDirectory(value.product)) throw new Error(`frozen baseline ${value.sha.slice(0, 12)} is gone from ${value.product}; run \`loop freeze ${value.ref}\` again`);
	return value as FrozenBaseline;
}
