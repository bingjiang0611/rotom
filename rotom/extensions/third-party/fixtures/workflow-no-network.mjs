// Preloaded only by the private workflow fixture, including its real Pi CLI children.
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
const file = process.env.OWNER_WORKFLOW_CONFIG;
if (!file) throw new Error("Workflow fixture config missing");
const config = JSON.parse(fs.readFileSync(file, "utf8"));
globalThis.fetch = () => {
	throw new Error("External fetch forbidden in workflow fixture");
};
// Explicit fault injection: simulate missing lifeline configuration, not a new runtime policy.
if (
	isMainThread &&
	process.argv[1] === config.piExecutable &&
	process.env.PI_SUBAGENT_CHILD === "1"
) {
	if (config.fault === "missing-lifeline")
		delete process.env.PI_SUBAGENT_OWNER_LIFELINE_FD;
	if (config.fault === "wrong-token") {
		const token = process.env.PI_SUBAGENT_STARTUP_TOKEN;
		if (!token) throw Error("Startup token fault requires gated transport");
		process.env.PI_SUBAGENT_STARTUP_TOKEN =
			token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
	}
	if (config.fault === "early-owner-loss") {
		fs.writeFileSync(
			path.join(config.cwd, `${process.pid}.bootstrap.json`),
			JSON.stringify({
				pid: process.pid,
				ppid: process.ppid,
				startedAt: Date.now(),
			}),
			{ mode: 0o600 },
		);
		fs.writeFileSync(path.join(config.cwd, "bootstrap"), "ready");
		await new Promise((resolve) => {
			const watcher = fs.watch(config.cwd, () => {
				if (fs.existsSync(path.join(config.cwd, "startup-release"))) {
					watcher.close();
					clearTimeout(timer);
					resolve();
				}
			});
			const timer = setTimeout(() => {
				watcher.close();
				resolve();
			}, 30000);
			if (fs.existsSync(path.join(config.cwd, "startup-release"))) {
				watcher.close();
				clearTimeout(timer);
				resolve();
			}
		});
	}
	if (config.fault === "omit-runtime") {
		const i = process.argv.indexOf(config.childRuntime);
		if (i < 1 || !["--extension", "-e"].includes(process.argv[i - 1]))
			throw Error("Runtime omission fault did not match argv");
		process.argv.splice(i - 1, 2);
	}
}
