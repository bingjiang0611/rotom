import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { args, getArg, execFile, commandOutput, exists, run } from "./setup-helper-common.mjs";

const localCodeSignCommonName = "pi-computer-use Local Signing (com.injaneity.pi-computer-use)";
const localSigningLockPath = path.join(os.tmpdir(), `pi-computer-use-local-signing-${typeof process.getuid === "function" ? process.getuid() : "user"}.lock`);

const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use";

async function findDeveloperIdIdentity() {
	const output = await commandOutput("security", ["find-identity", "-p", "codesigning", "-v"]).catch(() => "");
	const line = output.split("\n").find((item) => item.includes("Developer ID Application"));
	return line?.trim().split(/\s+/)[1];
}

export function parseCodeSigningIdentities(output, commonName = localCodeSignCommonName) {
	return output.split("\n")
		.map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/i))
		.filter((match) => match?.[2] === commonName)
		.map((match) => match[1].toUpperCase());
}

async function findLocalSigningIdentity() {
	// Self-signed local identities appear as CSSMERR_TP_NOT_TRUSTED and are
	// omitted by `-v`, but remain valid inputs to codesign. Match the identity
	// list directly and return its fingerprint rather than its display name.
	const output = await commandOutput("security", ["find-identity", "-p", "codesigning"]).catch(() => "");
	return parseCodeSigningIdentities(output)[0];
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDirectoryLock(lockPath, callback, { waitMs = 15_000, staleMs = 300_000, retryMs = 50 } = {}) {
	const deadline = Date.now() + waitMs;
	while (true) {
		try {
			await fs.mkdir(lockPath);
			break;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			const stat = await fs.stat(lockPath).catch(() => undefined);
			if (stat && Date.now() - stat.mtimeMs > staleMs) {
				await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for local signing identity lock at ${lockPath}.`);
			await delay(retryMs);
		}
	}
	try {
		return await callback();
	} finally {
		await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
	}
}

export async function ensureIdentityOnce(findIdentity, createIdentity, withLock) {
	return (await findIdentity()) ?? await withLock(async () => (await findIdentity()) ?? await createIdentity());
}

async function loginKeychainPath() {
	for (const candidate of [
		path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
		path.join(os.homedir(), "Library", "Keychains", "login.keychain"),
	]) {
		if (await exists(candidate)) return candidate;
	}
	return undefined;
}

async function ensureLocalSigningIdentity() {
	if (process.platform !== "darwin") return undefined;
	if (!(await commandOutput("which", ["codesign"]).catch(() => ""))) return undefined;
	const existingIdentity = await findLocalSigningIdentity();
	if (existingIdentity) return existingIdentity;
	if (!(await commandOutput("which", ["openssl"]).catch(() => ""))) return undefined;
	const keychain = await loginKeychainPath();
	if (!keychain) return undefined;

	return await ensureIdentityOnce(findLocalSigningIdentity, createLocalSigningIdentity, (callback) => withDirectoryLock(localSigningLockPath, callback));
}

async function createLocalSigningIdentity() {
	const keychain = await loginKeychainPath();
	if (!keychain) return undefined;
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-signing-"));
	const password = `pi-computer-use-local-${process.pid}-${Date.now()}`;
	try {
		const configPath = path.join(tempDir, "req.cnf");
		await fs.writeFile(configPath, [
			"[req]",
			"distinguished_name=dn",
			"x509_extensions=ext",
			"prompt=no",
			"[dn]",
			`CN=${localCodeSignCommonName}`,
			"[ext]",
			"basicConstraints=critical,CA:FALSE",
			"keyUsage=critical,digitalSignature",
			"extendedKeyUsage=critical,codeSigning",
			"",
		].join("\n"));
		const keyPath = path.join(tempDir, "key.pem");
		const certPath = path.join(tempDir, "cert.pem");
		const p12Path = path.join(tempDir, "id.p12");
		await execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "3650", "-nodes", "-config", configPath]);
		await execFile("openssl", ["pkcs12", "-export", "-legacy", "-inkey", keyPath, "-in", certPath, "-out", p12Path, "-passout", `pass:${password}`, "-name", localCodeSignCommonName])
			.catch(async () => {
				await execFile("openssl", ["pkcs12", "-export", "-inkey", keyPath, "-in", certPath, "-out", p12Path, "-passout", `pass:${password}`, "-name", localCodeSignCommonName]);
			});
		await execFile("security", ["import", p12Path, "-k", keychain, "-P", password, "-A", "-T", "/usr/bin/codesign"]);
		const identity = await findLocalSigningIdentity();
		if (!identity) throw new Error("Imported local signing certificate is not a valid code-signing identity.");
		return identity;
	} catch (error) {
		console.warn(`[pi-computer-use] could not create a valid local signing identity: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	} finally {
		await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
	}
}

export async function resolveCodeSignIdentity() {
	if (process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY) return process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY;
	return (await findDeveloperIdIdentity()) ?? (await ensureLocalSigningIdentity()) ?? "-";
}

export async function signHelper(outputPath, identifier = defaultCodeSignIdentifier) {
	if (process.env.PI_COMPUTER_USE_NO_SIGN === "1") {
		return "unsigned";
	}

	const identity = await resolveCodeSignIdentity();
	const commandArgs = ["--force", "--deep", "-i", identifier, "--timestamp=none", "--sign", identity, outputPath];
	await run("codesign", commandArgs);
	if (identity === "-") {
		console.warn("[pi-computer-use] warning: signed helper ad-hoc; macOS may require permission review after native helper changes. Release installs should use a Developer ID-signed helper app.");
	} else if (identity === await findLocalSigningIdentity()) {
		console.log(`[pi-computer-use] signed ${outputPath} with local identity '${localCodeSignCommonName}'. macOS may still require permission review after local rebuilds.`);
	}
	return identity;
}
