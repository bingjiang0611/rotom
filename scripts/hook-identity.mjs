#!/usr/bin/env node
/**
 * Pre-push identity guard: refuse to publish a commit whose author or committer email
 * belongs to a private domain. A leak of this kind cannot be fixed by editing the latest
 * file, so it is cheaper to block the push than to rewrite public history afterwards.
 *
 * Allowed identities:
 *   - any `*@users.noreply.github.com` (the maintainer's and GitHub's own masking)
 *   - committer `noreply@github.com`, which GitHub writes on a web merge
 *   - exactly `noreply@anthropic.com`, exempted by the maintainer's decision for the
 *     twenty-three historical commits; a lookalike on that domain is still refused
 *
 * The rule reads the commits actually being pushed, so a commit already on the remote is
 * not re-judged and a new branch is checked against everything it would add.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_USER_NOREPLY = /@users\.noreply\.github\.com$/u;
export const GITHUB_SERVICE = "noreply@github.com";
export const ANTHROPIC_NOREPLY = "noreply@anthropic.com";
const ZERO_SHA = /^0+$/u;

/** Whether one recorded identity is publishable; `kind` decides the committer-only exception. */
export function identityAllowed(kind, email) {
	if (typeof email !== "string" || !email) return false;
	if (GITHUB_USER_NOREPLY.test(email)) return true;
	if (kind === "committer" && email === GITHUB_SERVICE) return true;
	return email === ANTHROPIC_NOREPLY;
}

/** The domain alone, so a refusal names what leaked without echoing the full address. */
export function domainOf(email) {
	const at = typeof email === "string" ? email.lastIndexOf("@") : -1;
	return at <= 0 ? "(no domain)" : email.slice(at);
}

/** Every offending field, in commit order; one commit can violate both fields. */
export function identityProblems(commits) {
	const problems = [];
	for (const commit of commits) {
		for (const kind of ["author", "committer"]) {
			if (identityAllowed(kind, commit[kind])) continue;
			problems.push({ sha: commit.sha, kind, domain: domainOf(commit[kind]) });
		}
	}
	return problems;
}

/** `<local ref> <local sha> <remote ref> <remote sha>` lines from the pre-push stdin. */
export function parsePushRefs(text) {
	const refs = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const [localRef, localSha, remoteRef, remoteSha] = line.split(" ");
		if (!localRef || !localSha || !remoteRef || !remoteSha) continue;
		refs.push({ localRef, localSha, remoteRef, remoteSha });
	}
	return refs;
}

/**
 * Commits this push would add. A deleted ref adds nothing; a new ref adds whatever is not
 * already on a remote-tracking branch, so re-pushing known history stays cheap; an existing
 * ref adds exactly the range between the two sides.
 */
export function pendingCommitShas(refs, git) {
	const shas = [];
	const seen = new Set();
	const add = (text) => {
		for (const sha of text.split("\n")) {
			const value = sha.trim();
			if (!value || seen.has(value)) continue;
			seen.add(value);
			shas.push(value);
		}
	};
	for (const ref of refs) {
		if (ZERO_SHA.test(ref.localSha)) continue;
		const range = ZERO_SHA.test(ref.remoteSha) ? [ref.localSha, "--not", "--remotes"] : [`${ref.remoteSha}..${ref.localSha}`];
		let listed;
		try {
			listed = git(["rev-list", ...range]);
		} catch {
			// The remote side may not exist locally (a ref pushed from elsewhere); fall back
			// to everything this repository has not published yet.
			listed = git(["rev-list", ref.localSha, "--not", "--remotes"]);
		}
		add(listed);
	}
	return shas;
}

export function readCommits(shas, git) {
	return shas.map((sha) => {
		const [author, committer, subject] = git(["show", "-s", "--format=%ae%x09%ce%x09%s", sha]).split("\t");
		return { sha, author, committer, subject };
	});
}

const IDENTITY = "bingjiang0611";
const EMAIL = "bingjiang0611@users.noreply.github.com";

export function renderRefusal(problems, commits = []) {
	const subjectOf = new Map(commits.map((commit) => [commit.sha, commit.subject ?? ""]));
	const rows = problems.map((problem) => `  ${problem.sha.slice(0, 12)} ${problem.kind} ${problem.domain}  ${subjectOf.get(problem.sha) ?? ""}`.trimEnd());
	const oldest = problems[0].sha.slice(0, 12);
	return [
		"Commit blocked: this push would publish a private identity.",
		...rows,
		"",
		"Allowed: *@users.noreply.github.com, committer noreply@github.com (GitHub web merge),",
		`and exactly ${ANTHROPIC_NOREPLY}.`,
		"",
		"Set the identity:",
		`  git config user.name ${IDENTITY} && git config user.email ${EMAIL}`,
		"Rewrite the offending commit (repeat for each one):",
		`  git rebase -i ${oldest}^`,
		"  then, at each offending commit:",
		`  git -c user.name=${IDENTITY} -c user.email=${EMAIL} commit --amend --no-edit --reset-author`,
		"Rewrite every commit from the oldest one instead:",
		`  git -c user.name=${IDENTITY} -c user.email=${EMAIL} rebase ${oldest}^ --exec 'git commit --amend --no-edit --reset-author'`,
	].join("\n");
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" });
}

function main() {
	const refs = parsePushRefs(readFileSync(0, "utf8"));
	const commits = readCommits(pendingCommitShas(refs, git), git);
	const problems = identityProblems(commits);
	if (problems.length === 0) return 0;
	console.error(renderRefusal(problems, commits));
	return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
