/** Artifact provenance; checkout identity comes from its own Git repository, never an ancestor. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export const BUILD_INFO_FILE = "build-info.json";
export const BUILD_INFO_SCHEMA = "rotom-build-info/v1";
const SHA = /^[0-9a-f]{40}$/u;

export function parseBuildInfo(text, where = BUILD_INFO_FILE) {
	let value;
	try { value = JSON.parse(text); } catch { throw new Error(`${where}: not JSON`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}: not an object`);
	if (value.schema !== BUILD_INFO_SCHEMA) throw new Error(`${where}: schema must be ${BUILD_INFO_SCHEMA}`);
	if (typeof value.commit !== "string" || !SHA.test(value.commit)) throw new Error(`${where}: commit must be a full 40-character SHA`);
	if (typeof value.dirty !== "boolean") throw new Error(`${where}: dirty must be a boolean`);
	if (typeof value.allowDirty !== "boolean" || value.allowDirty !== value.dirty) throw new Error(`${where}: allowDirty must match dirty`);
	if (typeof value.builtAt !== "string" || !Number.isFinite(Date.parse(value.builtAt)) || new Date(value.builtAt).toISOString() !== value.builtAt) {
		throw new Error(`${where}: builtAt must be an ISO instant`);
	}
	return value;
}

export function readBuildInfo(release) {
	const path = join(release, BUILD_INFO_FILE);
	if (!lstatSync(path).isFile()) throw new Error(`${path}: not a regular file`);
	return parseBuildInfo(readFileSync(path, "utf8"), path);
}

export function readBuildInfoIfPresent(release) {
	try { return readBuildInfo(release); } catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** An unstamped installed copy is unknown, even when it happens to live inside a Git repository. */
export function readBuildIdentity(product) {
	const root = realpathSync(product);
	const git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
	let repository;
	try { repository = git(["rev-parse", "--show-toplevel"]).trim(); } catch { return readBuildInfoIfPresent(product); }
	// The maintained checkout owns <repository>/rotom. Do not mistake a consumer's repo for ours.
	if (realpathSync(repository) !== dirname(root) || root !== join(realpathSync(repository), "rotom")) return readBuildInfoIfPresent(product);
	const commit = git(["rev-parse", "HEAD"]).trim();
	if (!SHA.test(commit)) return undefined;
	return { commit, dirty: git(["status", "--porcelain", "--untracked-files=normal"]).length > 0 };
}
