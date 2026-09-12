import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_PACKAGES = ["chord", "telemetry", "ai", "tui", "agent", "coding-agent"];
const repository = resolve(import.meta.dirname, "../..");
const source = resolve(repository, "packages/rotom-pi");
const runtime = resolve(repository, "rotom/runtime/pi");
const skipped = new Set(["node_modules", "dist", ".git", "coverage", ".DS_Store"]);

export async function sourceFiles(root = source, prefix = "") {
	if (root === source && prefix === "") {
		// Git's source inventory, not a recursive checkout copy: ignored npmrc,
		// credentials, generated catalogs/caches and live state must never enter a build.
		const names = execFileSync("git", ["-C", repository, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages/rotom-pi"], { encoding: "utf8" }).split("\0").filter(Boolean);
		const paths = [...new Set(names.map((name) => name.slice("packages/rotom-pi/".length)))].sort();
		if (!paths.includes("FORK.json") || !paths.includes("package-lock.json")) throw new Error("Missing Git-owned Pi fork source inventory");
		for (const path of paths) {
			if (path.split("/").some((part) => skipped.has(part) || [".pi", ".npmrc", ".env"].includes(part))) throw new Error(`Private/generated tracked fork input: ${path}`);
			const absolute = resolve(root, path);
			const info = await lstat(absolute);
			if (!info.isFile() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`Untrusted fork source: ${path}`);
		}
		return paths;
	}
	const files = [];
	for (const entry of (await readdir(resolve(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
		if (skipped.has(entry.name)) continue;
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		const absolute = resolve(root, path);
		if (entry.isSymbolicLink() || await realpath(absolute) !== absolute) throw new Error(`Untrusted fork source: ${path}`);
		if (entry.isDirectory()) files.push(...await sourceFiles(root, path));
		else if (entry.isFile()) files.push(path);
		else throw new Error(`Non-regular fork source: ${path}`);
	}
	return files;
}

export async function sourceDigest(root = source) {
	const hash = createHash("sha256");
	for (const file of await sourceFiles(root)) {
		hash.update(file).update("\0").update(await readFile(resolve(root, file))).update("\0");
	}
	return hash.digest("hex");
}

export async function verifyForkSource(root = source, product = runtime) {
	const built = JSON.parse(await readFile(resolve(product, "fork-build.json"), "utf8"));
	if (built.sourceSha256 !== await sourceDigest(root) || built.builderSha256 !== createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")) throw new Error("Pi fork source/builder changed: run npm run build:pi before packing");
	return built;
}

async function buildFork() {
	const provenance = JSON.parse(await readFile(resolve(source, "FORK.json"), "utf8"));
	const before = await sourceDigest();
	const work = await mkdtemp(resolve(tmpdir(), "rotom-pi-build-"));
	try {
		const tree = resolve(work, "source"), home = resolve(work, "home"), archives = resolve(work, "archives");
		for (const file of await sourceFiles()) {
			const target = resolve(tree, file);
			await mkdir(dirname(target), { recursive: true });
			await copyFile(resolve(source, file), target);
		}
		await mkdir(home); await mkdir(archives);
		await writeFile(resolve(home, "npmrc"), "");
		const env = { PATH: process.env.PATH, HOME: home, NPM_CONFIG_CACHE: resolve(work, "cache"), NPM_CONFIG_USERCONFIG: resolve(home, "npmrc"), NPM_CONFIG_GLOBALCONFIG: resolve(home, "global-npmrc"), PI_OFFLINE: "1", PI_TELEMETRY: "0" };
		const run = (args, cwd) => execFileSync("npm", args, { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
		const flags = ["--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "--replace-registry-host=never"];
		console.log("Pi fork: clean locked build (isolated HOME/cache, no install hooks)");
		run(["ci", ...flags], tree);
		// Full upstream offline build also checks development-only workspace dependencies;
		// only the six public CLI/SDK runtime packages are distributed below.
		console.log(run(["run", "build:offline"], tree));
		console.log(run(["test", "--", "test/model-selector.test.ts", "test/suite/agent-session-model-extension.test.ts", "test/suite/regressions/3217-scoped-model-order.test.ts", "test/suite/regressions/7209-model-selector-filter-resets-selection.test.ts", "test/compaction.test.ts", "test/rotom-startup.test.ts", "test/interactive-mode-status.test.ts", "test/suite/regressions/5943-session-start-notify.test.ts", "test/rotom-product.test.ts", "test/version-check.test.ts", "test/interactive-mode-startup-input.test.ts"], resolve(tree, "packages/coding-agent")));
		const names = new Map();
		for (const directory of PI_PACKAGES) {
			const pkg = JSON.parse(await readFile(resolve(tree, "packages", directory, "package.json"), "utf8"));
			names.set(pkg.name, directory);
		}
		const dependencies = {}, artifacts = {};
		for (const [name, directory] of names) {
			const packageRoot = resolve(tree, "packages", directory);
			const metadata = resolve(packageRoot, "package.json");
			const pkg = JSON.parse(await readFile(metadata, "utf8"));
			pkg.version = provenance.forkVersion;
			pkg.private = true;
			pkg.rotomFork = { upstream: provenance.upstream, revision: provenance.revision, sourceSha256: before };
			delete pkg.devDependencies;
			for (const group of ["dependencies", "optionalDependencies"]) {
				for (const dep of Object.keys(pkg[group] ?? {})) if (names.has(dep)) pkg[group][dep] = provenance.forkVersion;
			}
			// The runtime's package-lock is authoritative. Do not ship an upstream
			// shrinkwrap that would resolve the fork back to official registry packages.
			await rm(resolve(packageRoot, "npm-shrinkwrap.json"), { force: true });
			pkg.files = pkg.files.filter((file) => file !== "npm-shrinkwrap.json");
			await writeFile(metadata, `${JSON.stringify(pkg, null, 2)}\n`);
			await copyFile(resolve(tree, "LICENSE"), resolve(packageRoot, "LICENSE"));
			const parsed = JSON.parse(run(["pack", "--json", "--ignore-scripts", "--pack-destination", archives], packageRoot));
			const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
			dependencies[name] = `file:vendor/${packed.filename}`;
			artifacts[name] = { version: pkg.version, file: `vendor/${packed.filename}`, integrity: packed.integrity };
		}
		if (await sourceDigest() !== before) throw new Error("Pi source changed during build; refusing publication");
		await mkdir(resolve(runtime, "vendor"), { recursive: true });
		for (const item of Object.values(artifacts)) await copyFile(resolve(archives, item.file.slice(7)), resolve(runtime, item.file));
		const manifest = { name: "rotom-pi-runtime", version: provenance.forkVersion, private: true, type: "module", dependencies, overrides: { ...dependencies, protobufjs: "7.6.5", rimraf: "6.1.2", gaxios: { rimraf: "6.1.2" } } };
		await writeFile(resolve(runtime, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		const lockPath = resolve(runtime, "package-lock.json");
		const previousLock = await readFile(lockPath, "utf8").then(JSON.parse, (error) => { if (error.code === "ENOENT") return null; throw error; });
		if (previousLock) {
			// Re-read changed local tarballs even when the fork version is unchanged,
			// while retaining the already locked external dependency resolutions.
			for (const name of names.keys()) delete previousLock.packages[`node_modules/${name}`];
			await writeFile(lockPath, `${JSON.stringify(previousLock, null, 2)}\n`);
		}
		run(["install", "--package-lock-only", ...flags], runtime);
		const builderSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
		const buildMetadata = `${JSON.stringify({ schema: "rotom-pi-fork/v1", version: provenance.forkVersion, upstreamRevision: provenance.revision, sourceSha256: before, builderSha256, artifacts }, null, 2)}\n`;
		await writeFile(resolve(runtime, "fork-build.json"), buildMetadata);
		const configPath = resolve(repository, "rotom/runtime/product-config.mjs");
		const config = await readFile(configPath, "utf8");
		const declaration = /^export const DISTRIBUTION_PI_BUILD_SHA256 = "[a-f0-9]{64}";$/gm;
		if ([...config.matchAll(declaration)].length !== 1) throw new Error("Missing unique fork identity declaration");
		await writeFile(configPath, config.replace(declaration, `export const DISTRIBUTION_PI_BUILD_SHA256 = "${createHash("sha256").update(buildMetadata).digest("hex")}";`));
		console.log(`Pi fork ready: ${provenance.forkVersion} (${before})`);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const task = process.argv[2] === "--check" ? verifyForkSource() : buildFork();
	task.catch((error) => { console.error(error.message); process.exitCode = 1; });
}
