// Validate the objects going to the remote, not a possibly dirty or unrelated worktree.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseLedger, parseLedgerShards } from "../rotom/evals/src/loop/ledger.ts";
import { parsePushRefs } from "./hook-identity.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const prefix = "rotom/evals/loop/ledger/";
const tips = new Set(parsePushRefs(readFileSync(0, "utf8")).map(ref => ref.localSha));
for (const tip of tips) {
	if (/^0+$/.test(tip)) continue;
	const files = new Set(git("ls-tree", "-rz", "--name-only", tip).split("\0").filter(Boolean));
	const names = [...files].filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length));
	parseLedgerShards(names, name => {
		const entries = parseLedger(git("show", tip + ":" + prefix + name));
		for (const entry of entries) {
			if (!files.has(entry.source.split("#")[0])) throw new Error("ledger: missing source in push tip: " + entry.source);
		}
		return entries;
	});
}
