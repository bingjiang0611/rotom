// Version-aware test setup only. Runtime code never initializes a missing store.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export async function prepareOwnedStoreTestRuntime(source, base) {
	const file = path.join(source, "src/shared/execution-store.ts"), previous = process.env.PI_SUBAGENTS_EXECUTION_SCOPE;
	if (!fs.existsSync(file)) return { requestFields: {}, restore() {} };
	const store = (await import(pathToFileURL(file))).initializeExecutionStore(base);
	process.env.PI_SUBAGENTS_EXECUTION_SCOPE = store.scope;
	return { requestFields: { storeId: store.storeId }, restore() { if (previous === undefined) delete process.env.PI_SUBAGENTS_EXECUTION_SCOPE; else process.env.PI_SUBAGENTS_EXECUTION_SCOPE = previous; } };
}
export async function loadLegacyModeCapacity(source, root) {
	const target = path.join(root, "legacy-mode"); fs.mkdirSync(target);
	fs.cpSync(path.join(source, "src"), path.join(target, "src"), { recursive: true });
	fs.copyFileSync(path.join(source, "package.json"), path.join(target, "package.json"));
	for (const name of ["acorn", "jiti", "typebox", "yaml"]) fs.cpSync(path.join(path.dirname(source), "node_modules", name), path.join(root, "node_modules", name), { recursive: true });
	const previous = process.env.PI_SUBAGENTS_EXECUTION_SCOPE;
	try {
		delete process.env.PI_SUBAGENTS_EXECUTION_SCOPE;
		return await import(pathToFileURL(path.join(target, "src/runs/background/active-async-capacity.ts")));
	} finally { if (previous === undefined) delete process.env.PI_SUBAGENTS_EXECUTION_SCOPE; else process.env.PI_SUBAGENTS_EXECUTION_SCOPE = previous; }
}
