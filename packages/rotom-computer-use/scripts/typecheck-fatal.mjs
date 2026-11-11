#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// REVIEW-17: a transitional gate, not a claim that the full typecheck passes.
const fatalCodes = new Set([2304, 2552, 2307, 2305, 2614, 2724, 2792, 2882, 2348, 2349, 2351, 7009, 2448, 2454, 2688, 6053, 6054, 6231]);
export function typecheckResult(result) {
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const diagnostics = [...output.matchAll(/^(.*?)\berror TS(\d+):/gm)];
	const fatal = diagnostics.filter(([, location, value]) => {
		const code = Number(value);
		const runtimeProperty = [2339, 2551].includes(code) && /(?:^|[\\/])(?:src|extensions)[\\/]/.test(location);
		return runtimeProperty || fatalCodes.has(code) || (code >= 1000 && code < 2000) || (code >= 5000 && code < 6000);
	}).map((match) => Number(match[2]));
	const infrastructureFailure = Boolean(result.error || result.signal || ![0, 1, 2].includes(result.status) || (result.status !== 0 && diagnostics.length === 0));
	return { output, diagnosticCount: diagnostics.length, fatalCodes: fatal, exitCode: infrastructureFailure || fatal.length > 0 ? 1 : 0 };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
	const project = process.argv[2] ?? fileURLToPath(new URL("../tsconfig.json", import.meta.url));
	const result = spawnSync(process.execPath, [compiler, "--project", project, "--pretty", "false", "--noErrorTruncation"], {
		encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
	});
	const check = typecheckResult(result);
	process.stdout.write(check.output);
	if (result.error) console.error(result.error.message);
	if (result.signal) console.error(`TypeScript terminated by ${result.signal}`);
	console.log(`typecheck:fatal: ${check.fatalCodes.length} fatal / ${check.diagnosticCount} total diagnostics; full typecheck debt is not cleared.`);
	process.exitCode = check.exitCode;
}
