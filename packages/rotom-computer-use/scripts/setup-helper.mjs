#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMacosHelperAppPath } from "../src/platform/macos/helper-path.mjs";
import { macosSourceFiles } from "./macos-sources.mjs";
import { updateHelperApp } from "./helper-update.mjs";
import { helperUpdateCopy } from "../src/constants/helper-update.mjs";
import { args, getArg, rootDir, packageVersion, execFile, exists, hashFile, run } from "./setup-helper-common.mjs";
import { resolveCodeSignIdentity, signHelper } from "./setup-helper-signing.mjs";
import { downloadReleaseHelperApp } from "./setup-helper-release.mjs";
export { parseCodeSigningIdentities, withDirectoryLock, ensureIdentityOnce } from "./setup-helper-signing.mjs";

const helperAppPath = resolveMacosHelperAppPath();
const helperAppExecutablePath = path.join(helperAppPath, "Contents", "MacOS", "bridge");
const helperSourceHashPath = path.join(helperAppPath, "Contents", "Resources", "source.sha256");
const helperBundleId = "com.injaneity.pi-computer-use";
const windowsCrateDir = path.join(rootDir, "native", "windows", "bridge-rs");
const windowsHelperDestPath = process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH || path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe");
const linuxCrateDir = path.join(rootDir, "native", "linux", "bridge-rs");
const linuxHelperDestPath = process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH || path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "linux-bridge");
const helperSourcePaths = macosSourceFiles
	.map((file) => path.join(rootDir, "native", "macos", file));
const isPostinstall = args.has("--postinstall");
const allowBuildFallback = args.has("--allow-build") || args.has("--runtime") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
const allowLinuxBuildFallback = args.has("--allow-build") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
const allowAdhocUpdate = args.has("--allow-adhoc-update") || process.env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE === "1";

const archTriples = {
	arm64: "arm64-apple-macosx",
	x64: "x86_64-apple-macosx",
};
const deploymentTarget = "14.0";
const frameworks = ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"];

function normalizeArch(arch) {
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64.`);
}

function prebuiltPathForArch(arch) {
	return path.join(rootDir, "prebuilt", "macos", arch, "bridge");
}

function prebuiltAppPathForArch(arch) {
	return path.join(rootDir, "prebuilt", "macos", arch, "pi-computer-use.app");
}

async function copyIfChanged(sourcePath, destinationPath) {
	const destinationExists = await exists(destinationPath);
	if (destinationExists) {
		const [sourceHash, destinationHash] = await Promise.all([hashFile(sourcePath), hashFile(destinationPath)]);
		if (sourceHash === destinationHash) {
			await fs.chmod(destinationPath, 0o755);
			return { changed: false };
		}
	}

	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
	await fs.copyFile(sourcePath, tempPath);
	await fs.chmod(tempPath, 0o755);
	try {
		await fs.rename(tempPath, destinationPath);
	} catch (err) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		if (err.code === "EPERM") {
			throw new Error(`Cannot update helper at ${destinationPath} — the existing helper process is still running. Close the helper process and re-run this script.`);
		}
		throw err;
	}
	return { changed: true };
}

function moduleCachePath(arch) {
	return path.join(os.tmpdir(), `pi-computer-use-swift-module-cache-${arch}`);
}

async function helperHasAdhocSignature(appPath = helperAppPath) {
	const output = await execFile("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" }).then(
		(result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
		(error) => `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
	);
	return /Signature=adhoc/i.test(output);
}

async function registerHelperApp() {
	const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (!(await exists(lsregister))) return;
	await run(lsregister, ["-f", helperAppPath]).catch(() => {});
}

async function ensureHelperParentDirectory() {
	const parentPath = path.dirname(helperAppPath);
	await fs.mkdir(parentPath, { recursive: true });
	await fs.access(parentPath, fsConstants.W_OK);
}

async function installPrebuiltHelperApp(sourceAppPath) {
	await ensureHelperParentDirectory();
	const sourceExecutablePath = path.join(sourceAppPath, "Contents", "MacOS", "bridge");
	const sourceInfoPath = path.join(sourceAppPath, "Contents", "Info.plist");
	const existingExecutable = await fs.readFile(helperAppExecutablePath).catch(() => undefined);
	const sourceExecutable = await fs.readFile(sourceExecutablePath);
	const existingInfo = await fs.readFile(path.join(helperAppPath, "Contents", "Info.plist"), "utf8").catch(() => undefined);
	const sourceInfo = await fs.readFile(sourceInfoPath, "utf8");
	if (existingExecutable?.equals(sourceExecutable) && existingInfo === sourceInfo) {
		await registerHelperApp();
		return false;
	}
	// The sealed bundle must arrive intact — a broken signature would burn
	// the user's TCC grants on an identity that can never validate.
	await run("codesign", ["--verify", "--strict", sourceAppPath]);
	if (existingExecutable && await helperHasAdhocSignature(sourceAppPath) && process.env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE !== "1") {
		throw new Error("Refusing to replace an existing helper with an ad-hoc bundle. Close its owning sessions and explicitly authorize PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1, or use a separately signed helper app and socket. macOS permissions may require review.");
	}
	await fs.rm(helperAppPath, { force: true, recursive: true });
	// Preserve the source signature byte-for-byte. rotom's bundle is ad-hoc;
	// a separately signed bundle retains its own identity. This does not promise
	// TCC continuity, and no certificate or system trust is changed here.
	await run("/usr/bin/ditto", [sourceAppPath, helperAppPath]);
	await registerHelperApp();
	return true;
}

async function installHelperApp(sourcePath) {
	await ensureHelperParentDirectory();
	const version = await packageVersion();
	const infoPlistPath = path.join(helperAppPath, "Contents", "Info.plist");
	const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${helperBundleId}</string>
<key>CFBundleName</key><string>pi-computer-use</string>
<key>CFBundleDisplayName</key><string>pi-computer-use</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`;

	const sourceExecutable = await fs.readFile(sourcePath);
	const sourceHash = createHash("sha256").update(sourceExecutable).digest("hex");
	const existingSourceHash = await fs.readFile(helperSourceHashPath, "utf8").catch(() => undefined);
	const existingInfoPlist = await fs.readFile(infoPlistPath, "utf8").catch(() => undefined);
	if (existingSourceHash?.trim() === sourceHash && existingInfoPlist === infoPlist) {
		// If a real signing identity is available, upgrade older ad-hoc installs
		// in place so local builds have a consistent identity. macOS may still
		// require permission review after native code changes.
		const signingIdentity = process.env.PI_COMPUTER_USE_NO_SIGN === "1" ? "-" : await resolveCodeSignIdentity();
		if (signingIdentity !== "-" && await helperHasAdhocSignature()) {
			await signHelper(helperAppPath, helperBundleId);
			await registerHelperApp();
			return true;
		}
		await registerHelperApp();
		return false;
	}

	const signingIdentity = process.env.PI_COMPUTER_USE_NO_SIGN === "1" ? "-" : await resolveCodeSignIdentity();
	if (signingIdentity === "-" && existingSourceHash !== undefined && !allowAdhocUpdate) {
		throw new Error("Refusing to replace an installed helper with an ad-hoc signed rebuild because macOS may reset Accessibility/Screen Recording grants. Use a pre-signed helper app, install a Developer ID identity, or set PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 for local development.");
	}

	await fs.mkdir(path.dirname(helperAppExecutablePath), { recursive: true });
	await fs.mkdir(path.dirname(helperSourceHashPath), { recursive: true });
	await fs.copyFile(sourcePath, helperAppExecutablePath);
	await fs.chmod(helperAppExecutablePath, 0o755);
	await fs.writeFile(infoPlistPath, infoPlist);
	await fs.writeFile(helperSourceHashPath, `${sourceHash}\n`);
	await signHelper(helperAppPath, helperBundleId);
	await registerHelperApp();
	return true;
}

async function buildHelper(arch, outputPath) {
	for (const sourcePath of helperSourcePaths) {
		if (!(await exists(sourcePath))) throw new Error(`Native helper source not found at ${sourcePath}`);
	}

	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const swiftArgs = [
		"swiftc",
		"-target",
		`${archTriples[arch]}${deploymentTarget}`,
		"-module-cache-path",
		moduleCachePath(arch),
		"-O",
	];
	for (const framework of frameworks) swiftArgs.push("-framework", framework);
	swiftArgs.push(...helperSourcePaths, "-o", outputPath);

	await run("xcrun", swiftArgs);
	await fs.chmod(outputPath, 0o755);
	await signHelper(outputPath);
}

function windowsBinaryPath() {
	const releaseDir = path.join(windowsCrateDir, "target", "release");
	return {
		exePath: path.join(releaseDir, "windows-bridge.exe"),
		binPath: path.join(releaseDir, "windows-bridge"),
	};
}

async function setupWindowsHelper() {
	const prebuiltPath = path.join(rootDir, "prebuilt", "windows", "windows-bridge.exe");
	if (await exists(prebuiltPath)) {
		const { changed } = await copyIfChanged(prebuiltPath, windowsHelperDestPath);
		console.log(changed
			? `[pi-computer-use] installed Windows helper from prebuilt to ${windowsHelperDestPath}`
			: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`);
		return;
	}

	if (allowBuildFallback) {
		console.log("[pi-computer-use] Windows prebuilt helper missing; attempting source build with cargo...");
		await run("cargo", ["build", "--release", "--manifest-path", path.join(windowsCrateDir, "Cargo.toml")]);
		const { exePath, binPath } = windowsBinaryPath();
		const cargoOutput = (await exists(exePath)) ? exePath : (await exists(binPath)) ? binPath : exePath;
		const { changed } = await copyIfChanged(cargoOutput, windowsHelperDestPath);
		console.log(changed
			? `[pi-computer-use] built and installed Windows helper at ${windowsHelperDestPath}`
			: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`);
		return;
	}

	throw new Error(
		`No Windows prebuilt helper found at ${prebuiltPath}. ` +
			"Run 'node scripts/build-native.mjs --platform windows' to build, or set PI_COMPUTER_USE_ALLOW_BUILD=1 to build at install time.",
	);
}

async function setupLinuxHelper() {
	const arch = normalizeArch(process.arch);
	const prebuiltPath = path.join(rootDir, "prebuilt", "linux", arch, "linux-bridge");
	if (await exists(prebuiltPath)) {
		const { changed } = await copyIfChanged(prebuiltPath, linuxHelperDestPath);
		console.log(changed ? `[pi-computer-use] installed Linux helper (${arch}) from prebuilt to ${linuxHelperDestPath}` : `[pi-computer-use] Linux helper already up to date at ${linuxHelperDestPath}`);
		return;
	}
	if (allowLinuxBuildFallback) {
		if (process.platform !== "linux") throw new Error("The Linux helper source fallback must be built on Linux.");
		console.log("[pi-computer-use] Linux prebuilt helper missing; attempting source build with cargo...");
		await run("cargo", ["build", "--release", "--manifest-path", path.join(linuxCrateDir, "Cargo.toml")]);
		const cargoOutput = path.join(linuxCrateDir, "target", "release", "linux-bridge");
		const { changed } = await copyIfChanged(cargoOutput, linuxHelperDestPath);
		console.log(changed ? `[pi-computer-use] built and installed Linux helper at ${linuxHelperDestPath}` : `[pi-computer-use] Linux helper already up to date at ${linuxHelperDestPath}`);
		return;
	}
	throw new Error(`No Linux prebuilt helper found for ${arch} at ${prebuiltPath}. Run node scripts/build-native.mjs --platform linux to build, or set PI_COMPUTER_USE_ALLOW_BUILD=1 to build at install time.`);
}

async function setup() {
	if (args.has("--update") && process.platform !== "darwin") throw new Error(helperUpdateCopy.macOnly);
	const explicitPlatform = getArg("--platform");
	if (explicitPlatform === "windows" || (!explicitPlatform && process.platform === "win32")) {
		await setupWindowsHelper();
		return;
	}
	if (explicitPlatform === "linux" || (!explicitPlatform && process.platform === "linux")) {
		await setupLinuxHelper();
		return;
	}

	if (process.platform !== "darwin") {
		if (isPostinstall) {
			console.warn("[pi-computer-use] skipping helper setup: platform is not macOS.");
			return;
		}
		throw new Error("pi-computer-use helper is supported on macOS, Windows, and Linux. Use the matching --platform option.");
	}

	const arch = normalizeArch(process.arch);
	// Prefer the universal bundle built alongside the per-arch executables.
	// The replacement guard above also applies to this bundled ad-hoc artifact.
	const universalAppPath = prebuiltAppPathForArch("universal");
	const prebuiltAppPath = (await exists(universalAppPath))
		? universalAppPath
		: prebuiltAppPathForArch(arch);
	const prebuiltPath = prebuiltPathForArch(arch);
	const prebuiltAppExists = await exists(prebuiltAppPath);
	const prebuiltExists = await exists(prebuiltPath);

	if (args.has("--update")) {
		if (!prebuiltAppExists) throw new Error(helperUpdateCopy.missingBundle);
		const identity = process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY;
		if (identity && process.env.PI_COMPUTER_USE_NO_SIGN === "1") throw new Error(helperUpdateCopy.noSign);
		const target = path.join(await fs.realpath(os.homedir()), "Applications", "pi-computer-use.app");
		await updateHelperApp({ source: prebuiltAppPath, target, identity, allowAdhoc: allowAdhocUpdate });
		console.log(helperUpdateCopy.complete(target));
		return;
	}

	if (prebuiltAppExists) {
		const installed = await installPrebuiltHelperApp(prebuiltAppPath);
		console.log(
			installed
				? `[pi-computer-use] installed pre-signed helper app (${arch}) at ${helperAppPath}`
				: `[pi-computer-use] pre-signed helper app (${arch}) already current at ${helperAppPath}`,
		);
		return;
	}

	if (prebuiltExists) {
		const installed = await installHelperApp(prebuiltPath);
		console.log(
			installed
				? `[pi-computer-use] installed helper app (${arch}) at ${helperAppPath}`
				: `[pi-computer-use] helper app (${arch}) already current at ${helperAppPath}`,
		);
		return;
	}

	try {
		const releaseHelper = await downloadReleaseHelperApp();
		try {
			const installed = await installPrebuiltHelperApp(releaseHelper.appPath);
			console.log(
				installed
					? `[pi-computer-use] installed signed helper app from GitHub Release ${releaseHelper.tag} (${releaseHelper.assetName}) at ${helperAppPath}`
					: `[pi-computer-use] signed helper app from GitHub Release ${releaseHelper.tag} (${releaseHelper.assetName}) already current at ${helperAppPath}`,
			);
		} finally {
			await fs.rm(releaseHelper.tempDir, { force: true, recursive: true }).catch(() => {});
		}
		return;
	} catch (error) {
		console.warn(`[pi-computer-use] signed helper release download unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (allowBuildFallback) {
		const tempPath = path.join(os.tmpdir(), `pi-computer-use-bridge-${process.pid}-${Date.now()}`);
		try {
			console.log("[pi-computer-use] prebuilt helper missing; attempting source build with xcrun swiftc...");
			await buildHelper(arch, tempPath);
			const installed = await installHelperApp(tempPath);
			console.log(
				installed
					? `[pi-computer-use] built helper app at ${helperAppPath}`
					: `[pi-computer-use] built helper app; installed app already current at ${helperAppPath}`,
			);
		} finally {
			await fs.rm(tempPath, { force: true }).catch(() => {});
		}
		return;
	}

	throw new Error(
		`No prebuilt helper found for ${arch} at ${prebuiltPath}. Run 'npm run build:native' to build locally.`,
	);
}

const isMain = process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) setup().catch((error) => {
	if (isPostinstall) {
		console.warn(`[pi-computer-use] postinstall helper setup skipped: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(0);
	}

	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
