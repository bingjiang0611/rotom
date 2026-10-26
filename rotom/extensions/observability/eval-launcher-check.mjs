#!/usr/bin/env node
// Real product CLI checks; isolated HOME, no user credentials, no network.
// Run from any cwd. --launcher selects a separately installed product checkout.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executeProcessTreeV1 } from "../../runtime/process-tree.ts";
import { childEnvironment, JUDGE_BASE_ARGS, JUDGE_LAUNCHER, JUDGE_MAX_OUTPUT_BYTES, parseJudgeEvents, parseModelCatalog } from "./eval/judge.mjs";

function catalogResult(output) {
	let catalog, error;
	try { catalog = parseModelCatalog(output); } catch (failure) { error = failure.code; }
	return { exitCode: output.code, stdoutBytes: Buffer.byteLength(output.stdout), valid: !!catalog,
		modelCount: catalog?.models.length ?? null, defaultInList: catalog?.defaultModel ? catalog.models.some((item) => item.id === catalog.defaultModel) : null, error };
}

export async function checkLauncher({ launcher = JUDGE_LAUNCHER, faux = false } = {}) {
	assert.ok(isAbsolute(launcher), "launcher must be absolute");
	const directory = await mkdtemp(join(tmpdir(), "rotom-eval-launcher-check-"));
	let confirmed = true;
	try {
		const home = join(directory, "home"), cwd = join(directory, "cwd"), agent = join(home, ".pi", "agent");
		for (const path of [agent, cwd]) await mkdir(path, { recursive: true, mode: 0o700 });
		const networkGuard = join(directory, "offline.mjs"), networkAttempts = join(directory, "network.jsonl"), calls = join(directory, "faux.jsonl");
		await writeFile(networkAttempts, "", { mode: 0o600 });
		await writeFile(calls, "", { mode: 0o600 });
		await writeFile(networkGuard, `import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
function denied(){appendFileSync(${JSON.stringify(networkAttempts)},'blocked\\n');throw new Error('Offline launcher check forbids network');}
globalThis.fetch=denied; http.request=http.get=https.request=https.get=net.connect=net.createConnection=tls.connect=net.Socket.prototype.connect=denied;
syncBuiltinESMExports();\n`, { mode: 0o600 });
		const env = { ...childEnvironment(), HOME: home, PI_CODING_AGENT_DIR: agent, ROTOM_QODER: "0", NODE_OPTIONS: "--import=" + pathToFileURL(networkGuard).href };
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) delete env[key];
		await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }), { mode: 0o600 });
		async function invoke(args, stdin = "") {
			const output = await executeProcessTreeV1(launcher, args, { cwd, env, stdin, timeoutMs: 30_000, maxOutputBytes: JUDGE_MAX_OUTPUT_BYTES });
			confirmed = output.terminal.confirmed;
			assert.ok(confirmed, "process termination unknown; retained private check directory: " + directory);
			return output;
		}
		const output = await invoke([...JUDGE_BASE_ARGS, "--list-models"]);
		const result = { listing: catalogResult(output) };
		if (faux && result.listing.valid) {
			const extension = join(directory, "faux-extension.mjs");
			await writeFile(extension, `import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
export default function(pi){
 const faux=fauxProvider({tokensPerSecond:100000});
 faux.setResponses([(_context,_options,state)=>{
  appendFileSync(${JSON.stringify(calls)},JSON.stringify({callCount:state.callCount})+'\\n');
  if(state.callCount!==1)throw new Error('Unexpected repeated faux call');
  return fauxAssistantMessage(JSON.stringify({suggestedVerdict:'pass',confidence:1,summary:'离线合成检查',firstProblem:null,categories:[],evidence:[],suggestions:[]}));
 }]);
 pi.registerProvider(faux.provider);
 console.log('offline-extension-diagnostic');
}\n`, { mode: 0o600 });
			result.fauxListing = catalogResult(await invoke([...JUDGE_BASE_ARGS, "--extension", extension, "--list-models"]));
			const inference = await invoke([...JUDGE_BASE_ARGS, "--extension", extension, "--model", "faux/faux-1"], "Return the synthetic offline judgment.\n");
			const parsed = parseJudgeEvents(inference.stdout, new Set());
			const events = inference.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
			result.faux = { exitCode: inference.code, stdoutBytes: Buffer.byteLength(inference.stdout), status: parsed.status,
				messageEnd: events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").length,
				agentEnd: events.filter((event) => event.type === "agent_end").length,
				calls: (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).length,
				diagnosticOnStderr: inference.stderr.includes("offline-extension-diagnostic"), diagnosticOnStdout: inference.stdout.includes("offline-extension-diagnostic") };
		}
		result.blockedNetworkAttempts = (await readFile(networkAttempts, "utf8")).trim().split("\n").filter(Boolean).length;
		const fauxPassed = !faux || (
			result.fauxListing?.valid && result.fauxListing.modelCount === 1 && result.fauxListing.defaultInList === true &&
			result.faux?.exitCode === 0 && result.faux.status === "ok" &&
			result.faux.messageEnd === 1 && result.faux.agentEnd === 1 && result.faux.calls === 1 &&
			result.faux.diagnosticOnStderr && !result.faux.diagnosticOnStdout
		);
		result.passed = result.listing.valid && fauxPassed && result.blockedNetworkAttempts === 0;
		return result;
	} finally { if (confirmed) await rm(directory, { recursive: true, force: true }); }
}
const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (entry === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2), options = {};
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--faux") options.faux = true;
		else if (args[index] === "--launcher" && args[index + 1]) options.launcher = args[++index];
		else throw new Error("Usage: eval-launcher-check.mjs [--launcher /absolute/rotom-launcher] [--faux]");
	}
	const result = await checkLauncher(options);
	console.log(JSON.stringify(result, null, 2));
	if (!result.passed) process.exitCode = 1;
}
