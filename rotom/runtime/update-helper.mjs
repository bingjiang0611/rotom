import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyThirdPartyPackageContract } from "./verify-pi-runtime.mjs";
import { helperUpdateCopy as copy } from "./helper-update-copy.mjs";

export async function updateHelper(agentDir, args, { verify = verifyThirdPartyPackageContract, run = spawnSync, platform = process.platform } = {}) {
	const automatic = args.length === 2 && args[0] === "update" && args[1] === "--automatic";
	if (!automatic && (args.length !== 1 || args[0] !== "update")) throw new Error(copy.usage);
	if (automatic && platform !== "darwin") return 0;
	await verify(agentDir);
	const root = resolve(agentDir, "extensions/third-party/node_modules/@injaneity/pi-computer-use");
	for (const name of ["scripts/setup-helper.mjs", "scripts/setup-helper-common.mjs", "scripts/setup-helper-signing.mjs", "scripts/setup-helper-release.mjs", "scripts/helper-update.mjs", "scripts/macos-sources.mjs", "src/constants/helper-update.mjs", "src/platform/macos/helper-path.mjs"]) {
		const file = resolve(root, name);
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) throw new Error(copy.untrusted);
	}
	const result = run(process.execPath, [resolve(root, "scripts/setup-helper.mjs"), "--update", ...(automatic ? ["--automatic"] : [])], { stdio: automatic ? ["ignore", 2, 2] : "inherit" });
	if (result.error) throw result.error;
	if (result.signal || result.status === null) throw new Error(copy.interrupted);
	return result.status;
}

export async function synchronizeHelper(agentDir, options) {
	const code = await updateHelper(agentDir, ["update", "--automatic"], options);
	if (code !== 0) throw new Error(copy.automaticFailed);
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
	updateHelper(resolve(import.meta.dirname, ".."), process.argv.slice(2))
		.then(code => { process.exitCode = code; })
		.catch(error => { console.error(error.message); process.exitCode = 1; });
}
