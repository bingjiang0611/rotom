#!/usr/bin/env node
/**
 * Commit-message guard: a commit that changes the product must say which ledger entry it
 * belongs to, so a behaviour change made outside a gate run is still visible in the
 * experiment history. Test-only, documentation-only and eval-only commits are exempt.
 *
 * Accepted trailers:
 *   Ledger: L-2026-11-10-short-slug
 *   Ledger: none — <reason>
 *
 * The product set is the shipped surface named in CLAUDE.md; a path under those roots that is
 * itself a test or a document does not make the commit a product change.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCT_ROOTS = ["rotom/extensions/", "rotom/runtime/", "rotom/skills/", "rotom/bin/", "packages/"];

const ROOT_DOC = /^\.?[^/]*\.(?:md|mdx|txt)$/u;
const TEST = [/(?:^|\/)(?:test|tests|__tests__)\//u, /\.(?:test|spec)\.[a-z]+$/u, /(?:^|\/)test_[^/]*\.py$/u];

/** Documentation is the `docs/` tree and the root-level files; a shipped skill's SKILL.md is product. */
export function isDocPath(path) {
	return path.startsWith("docs/") || ROOT_DOC.test(path);
}

export function isTestPath(path) {
	return TEST.some((pattern) => pattern.test(path));
}

/** Product paths this commit changes; empty means the trailer is not required. */
export function productChanges(paths) {
	return paths.filter((path) => PRODUCT_ROOTS.some((root) => path.startsWith(root)) && !isDocPath(path) && !isTestPath(path));
}

const LEDGER_TRAILER = /^Ledger: L-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/mu;
const NONE_TRAILER = /^Ledger: none — \S.*$/mu;

/** `ledger` or `none` when a trailer is present; `missing` when neither form is. */
export function trailerState(message) {
	const body = message
		.split("\n")
		.filter((line) => !line.startsWith("#"))
		.join("\n");
	if (LEDGER_TRAILER.test(body)) return "ledger";
	if (NONE_TRAILER.test(body)) return "none";
	return "missing";
}

export function renderRefusal(changed) {
	return [
		"Commit blocked: a product change needs a ledger entry.",
		"",
		...changed.map((path) => `  ${path}`),
		"",
		"Add one of these trailers to the commit message:",
		"  Ledger: L-2026-11-11-short-slug   (an entry in rotom/evals/loop/ledger/<month>.json)",
		"  Ledger: none — <one-line reason this change is outside the loop>",
		"",
		"Test-only, documentation-only and evals-only commits are exempt.",
	].join("\n");
}

/** The commit's own changes, so an amend without new staged files is still judged. */
export function changedPaths(git) {
	const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
	if (staged.trim()) return staged.split("\0").filter(Boolean);
	try {
		return git(["diff", "--name-only", "--diff-filter=ACMR", "-z", "HEAD^", "HEAD"]).split("\0").filter(Boolean);
	} catch {
		return [];
	}
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" });
}

function main() {
	const messagePath = process.argv[2];
	if (!messagePath) throw new Error("commit-msg hook needs the message file path");
	const changed = productChanges(changedPaths(git));
	if (changed.length === 0) return 0;
	if (trailerState(readFileSync(messagePath, "utf8")) !== "missing") return 0;
	console.error(renderRefusal(changed));
	return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
