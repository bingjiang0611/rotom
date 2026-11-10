/**
 * Pre-push privacy audit: run `scripts/audit-public.py --history-range` over exactly the commits
 * this push adds, so a leak is refused before it reaches the remote instead of being found later
 * in a history that can only be fixed by rewriting it.
 *
 * The full `--history` scan stays the release-time check: it reads every object reachable from
 * every ref, which is the right question for "is this repository safe to publish" and the wrong
 * question for "is this push safe", and its byte budget is sized for the former.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePushRefs } from "./hook-identity.mjs";

const ZERO_SHA = /^0+$/u;
const AUDIT = resolve(import.meta.dirname, "audit-public.py");

/**
 * What this push adds, as audit arguments.
 *
 * A deleted ref adds nothing. An existing ref adds exactly the range between the two sides. A new
 * ref has no local base, so the range starts at the parent of the oldest commit that is not on a
 * remote-tracking branch. When even that has no parent (a first push from a fresh repository)
 * there is no range to name, and the caller falls back to the tracked-tree scan — the hook says so
 * instead of pretending the history was covered.
 */
export function auditPlan(refs, git) {
	const plans = [];
	const seen = new Set();
	for (const ref of refs) {
		if (ZERO_SHA.test(ref.localSha)) continue;
		let range;
		if (!ZERO_SHA.test(ref.remoteSha)) {
			range = `${ref.remoteSha}..${ref.localSha}`;
		} else {
			let oldest = "";
			try {
				const unpublished = git(["rev-list", ref.localSha, "--not", "--remotes"]).trim().split("\n").filter(Boolean);
				oldest = unpublished.at(-1) ?? "";
			} catch {
				oldest = "";
			}
			if (!oldest) continue; // Everything is already published; another ref covers it.
			const parents = git(["rev-list", "--parents", "-n", "1", oldest]).trim().split(" ").slice(1);
			if (parents.length === 0) {
				if (!seen.has("tree")) {
					seen.add("tree");
					plans.push({ args: [], treeOnly: ref.localRef });
				}
				continue;
			}
			range = `${parents[0]}..${ref.localSha}`;
		}
		if (seen.has(range)) continue;
		seen.add(range);
		plans.push({ args: ["--history-range", range], range });
	}
	return plans;
}

/** The audit's findings, without the JSON envelope, so the refusal names the file and rule. */
export function describeFailure(result) {
	let parsed;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return (result.stderr || result.stdout || `exit ${result.status}`).trim();
	}
	if (!Array.isArray(parsed.findings)) return `audit did not complete: ${parsed.reason ?? "unknown reason"}`;
	const rows = parsed.findings.slice(0, 10).map((finding) => `  ${finding.rule} ${finding.path}${finding.line ? `:${finding.line}` : ""}`);
	const more = parsed.findingCount > rows.length ? `  … ${parsed.findingCount - rows.length} more` : "";
	return ["The privacy audit refused this push:", ...rows, more].filter(Boolean).join("\n");
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" });
}

function main() {
	const refs = parsePushRefs(readFileSync(0, "utf8"));
	if (refs.length === 0) return 0;
	const plans = auditPlan(refs, git);
	for (const plan of plans) {
		if (plan.treeOnly) {
			console.error(`${plan.treeOnly} publishes a commit with no parent, so no history range exists; scanning the tracked tree only. Run the full history audit before publishing this repository.`);
		}
		const result = spawnSync(process.env.ROTOM_PYTHON || "python3", [AUDIT, "--root", ".", ...plan.args], { encoding: "utf8" });
		if (result.error) {
			console.error(`Privacy audit could not run (${result.error.message}). Install python3, then rerun scripts/audit-public.py ${plan.args.join(" ") || "--root ."}.`);
			return 1;
		}
		if (result.status !== 0) {
			console.error(describeFailure(result));
			if (plan.range) console.error(`Range: ${plan.range}`);
			return 1;
		}
	}
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
