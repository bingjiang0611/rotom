import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export type FileFixture = { files: Record<string, string>; editable: readonly string[] };
export const fixtureVerificationCommand = "node verify.mjs";

async function regularFile(workspace: string, file: string): Promise<string> {
	const path = join(await realpath(workspace), file);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(path) !== path) throw new Error("Fixture must be a canonical regular file.");
	return readFile(path, "utf8");
}

export async function fixturesIntact(workspace: string, fixture: FileFixture): Promise<boolean> {
	for (const [file, body] of Object.entries(fixture.files)) {
		const current = await regularFile(workspace, file);
		if (!fixture.editable.includes(file) && current !== body) return false;
	}
	return true;
}

/** Only immutable fixture code executes; mutable JSON cannot inject shell/code. */
export async function assertFixtureTool(workspace: string, fixture: FileFixture, name: string, input: Record<string, unknown>): Promise<void> {
	if (!await fixturesIntact(workspace, fixture)) throw new Error("Immutable fixture changed.");
	if (name === "bash") {
		if (input.command !== fixtureVerificationCommand) throw new Error("Only the fixture verification command is allowed.");
		return;
	}
	if (!["read", "edit"].includes(name) || typeof input.path !== "string" || input.then_run != null) throw new Error("Unsupported fixture tool call.");
	const root = await realpath(workspace);
	const requested = resolve(workspace, input.path);
	const allowed = name === "edit" ? fixture.editable : [...Object.keys(fixture.files), "verification.json"];
	const file = allowed.find((entry) => requested === join(workspace, entry) || requested === join(root, entry));
	if (!file) throw new Error("Path outside fixture allowlist.");
	await regularFile(workspace, file);
}

export async function readEditableFiles(workspace: string, fixture: FileFixture): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const file of fixture.editable) files[file] = await regularFile(workspace, file);
	return files;
}
