import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCE_DESCRIPTORS_V1, VERIFIED_THIRD_PARTY_PACKAGES } from "../runtime/product-config.mjs";
import { resolveInstalledPi, verifyDistributionContract } from "../runtime/resolve-installed-pi.mjs";

export const EMBEDDED_MODULES = "extensions/third-party/node_modules";

export function releaseFiles(manifest) {
	if (!Array.isArray(manifest.files) || new Set(manifest.files).size !== manifest.files.length || !manifest.files.includes(EMBEDDED_MODULES)) throw new Error("Invalid release files declaration");
	const files = ["package.json", ...manifest.files];
	for (const file of files) {
		if (typeof file !== "string" || isAbsolute(file) || file.split("/").some((part) => !part || part === "." || part === "..") || /[\\*?!]/u.test(file)) throw new Error(`Unsafe release file: ${file}`);
		if (file !== EMBEDDED_MODULES && (file.split("/").some((part) => part.startsWith(".") || ["node_modules", "evals", "fixtures", "designs"].includes(part)) || /(?:\.test\.|\.eval\.|\.patch$|results\.json$)/u.test(file))) throw new Error(`Non-product release file: ${file}`);
	}
	return files;
}

export async function stageRelease(source, target) {
	const root = await realpath(source);
	const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
	for (const file of releaseFiles(manifest)) {
		// Installed dependencies must come from a new npm ci, never a maintainer's tree.
		if (file === EMBEDDED_MODULES) continue;
		const from = resolve(root, file);
		const info = await lstat(from);
		if (!info.isFile() || info.isSymbolicLink() || await realpath(from) !== from) throw new Error(`Untrusted release source: ${file}`);
		const to = resolve(target, file);
		await mkdir(dirname(to), { recursive: true });
		await copyFile(from, to);
	}
	return manifest;
}

async function rejectLinks(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Non-regular installed resource: ${path}`);
		if (entry.isDirectory()) await rejectLinks(path);
	}
}

export function verifyPackList(manifest, packed) {
	const allowed = new Set(releaseFiles(manifest));
	const paths = new Set(packed.files.map((entry) => entry.path));
	for (const path of paths) {
		if (path.split("/").some((part) => part === ".." || part === ".npmrc" || part === ".git" || part === ".pi") || isAbsolute(path)) throw new Error(`Private/unsafe packed path: ${path}`);
		if (!allowed.has(path) && !path.startsWith(`${EMBEDDED_MODULES}/`)) throw new Error(`Unexpected packed file: ${path}`);
	}
	for (const path of allowed) {
		if (path !== EMBEDDED_MODULES && !paths.has(path)) throw new Error(`Missing packed file: ${path}`);
	}
	for (const resource of RESOURCE_DESCRIPTORS_V1) {
		for (const file of resource.requiredFiles) {
			if (!paths.has(`${resource.path}/${file}`)) throw new Error(`Missing packed resource: ${resource.id}/${file}`);
		}
	}
	for (const name of Object.keys(VERIFIED_THIRD_PARTY_PACKAGES)) {
		if (!paths.has(`${EMBEDDED_MODULES}/${name}/LICENSE`)) throw new Error(`Missing license: ${name}`);
	}
}

async function main() {
	const source = resolve(import.meta.dirname, "..");
	const output = process.argv[2];
	if (process.argv.length !== 3 || !isAbsolute(output)) throw new Error("Usage: npm run pack:release -- /absolute/output-directory");
	const nested = relative(source, resolve(output));
	if (nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))) throw new Error("Output must be outside the product tree");
	const auditScript = resolve(source, "../scripts/audit-public.py");
	await access(auditScript, constants.R_OK);
	const audit = (args) => {
		try {
			return execFileSync("python3", ["-I", auditScript, ...args], {
				cwd: source, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
			});
		} catch (error) {
			// The auditor emits redacted coordinates/digests only, never matches.
			throw new Error(`Privacy audit blocked: ${error.stdout?.toString().trim() || "unavailable or incomplete coverage"}`);
		}
	};
	audit(["--root", resolve(source, "..")]);
	await verifyDistributionContract(source);
	await mkdir(output, { recursive: true });
	const work = await mkdtemp(resolve(tmpdir(), "rotom-release-"));
	try {
		const stage = resolve(work, "product");
		const manifest = await stageRelease(source, stage);
		const home = resolve(work, "home");
		await mkdir(home);
		await writeFile(resolve(home, "user.npmrc"), "", { mode: 0o600 });
		await writeFile(resolve(home, "global.npmrc"), "", { mode: 0o600 });
		const env = {
			PATH: process.env.PATH,
			HOME: home,
			NPM_CONFIG_USERCONFIG: resolve(home, "user.npmrc"),
			NPM_CONFIG_GLOBALCONFIG: resolve(home, "global.npmrc"),
			NPM_CONFIG_CACHE: resolve(work, "cache"),
		};
		const npm = (args, cwd) => execFileSync("npm", args, { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
		const flags = ["--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "--replace-registry-host=never"];
		npm(["ci", ...flags, "--legacy-peer-deps", "--omit=optional", "--bin-links=false"], resolve(stage, "extensions/third-party"));
		await rejectLinks(resolve(stage, EMBEDDED_MODULES));
		npm(["ci", ...flags], stage);
		const executable = await resolveInstalledPi(stage);
		// Even the SDK capability import runs with the staging HOME/environment,
		// not the maintainer's credentials or optional integrations.
		const verified = execFileSync(process.execPath, [resolve(stage, "runtime/verify-pi-runtime.mjs"), "--runtime", executable, stage,
			...RESOURCE_DESCRIPTORS_V1.map((r) => `${r.kind}:${resolve(stage, r.path)}`)],
			{ cwd: stage, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
		if (verified !== executable) throw new Error("Staged Pi executable changed during verification");
		await access(resolve(stage, "bin/rotom"), constants.X_OK);
		const [preview] = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"], stage));
		verifyPackList(manifest, preview);
		if (!preview.filename || preview.filename.includes("/") || preview.filename.includes("\\")) throw new Error("Invalid pack filename");
		const target = resolve(output, preview.filename);
		if (await lstat(target).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; })) throw new Error(`Refusing to overwrite: ${target}`);
		const [packed] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", output], stage));
		verifyPackList(manifest, packed);
		audit(["--artifact", target]);
		console.log(JSON.stringify({ artifact: target, integrity: packed.integrity, size: packed.size, fileCount: packed.files.length, piVersion: manifest.dependencies["@earendil-works/pi-coding-agent"], published: false }, null, 2));
	} finally {
		// Only our own unique build staging area; never project runtime state.
		await rm(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
