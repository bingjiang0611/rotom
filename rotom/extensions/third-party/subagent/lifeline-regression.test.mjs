// Maintenance-only. Real SDK cases use a local faux provider with network disabled.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probePiVersion } from "../../../runtime/verify-pi-runtime.mjs";
import { VERIFIED_THIRD_PARTY_PACKAGES } from "../../../runtime/product-config.mjs";
// Default to the installed product. Historical source/patch comparison remains explicit.
const candidate = process.env.SUBAGENT_LIFELINE_CANDIDATE !== "0";
const progress = (stage) => {
	if (process.env.LIFELINE_DIAGNOSTICS === "1")
		fs.writeSync(1, `lifeline:${stage}\n`);
};
progress("start");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-lifeline-"));
const preparedSource = process.env.SUBAGENT_LIFELINE_SOURCE;
const installed = preparedSource ? fs.realpathSync(preparedSource) : fileURLToPath(
	new URL("../node_modules/pi-subagents/", import.meta.url),
);
const installedVersion = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")).version;
const maintainedSource = preparedSource && !installed.split(path.sep).includes("node_modules")
	&& installedVersion === process.env.ROTOM_SUBAGENT_TEST_VERSION && /^0\.52\.1-rotom\.\d+$/.test(installedVersion);
const productVersion = VERIFIED_THIRD_PARTY_PACKAGES["pi-subagents"].version;
const exactProduct = installedVersion === "0.52.1-dev-agent-followthrough.2" || maintainedSource || (!preparedSource && installedVersion === productVersion);
if (preparedSource) assert.ok(exactProduct || installedVersion === "0.52.1", "unsupported historical or maintained source");
else assert.equal(installedVersion, productVersion);
assert.ok(!exactProduct || candidate, "installed product cannot be relabeled as the unpatched baseline");
const source = path.join(root, "source");
fs.mkdirSync(source);
progress("copy");
fs.cpSync(path.join(installed, "src"), path.join(source, "src"), {
	recursive: true,
});
fs.writeFileSync(path.join(source, "package.json"), '{"type":"module"}');
let retainFixture = false;
const previousTemp = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runtime");
after(async () => {
	progress("cleanup");
	try {
		if (retainFixture)
			console.warn(`Retained unconfirmed fixture: ${path.basename(root)}`);
		else await fs.promises.rm(root, { recursive: true, force: true });
	} finally {
		if (previousTemp === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
		else process.env.PI_SUBAGENTS_TEMP_ROOT = previousTemp;
	}
	progress("cleaned");
});
progress("copied");
// No patches on the default path. An explicit historical source must already
// contain its intended patches; never relabel the installed product as baseline.
progress("source-ready");
const guardPath = path.join(source, "src/runs/shared/owner-lifeline.ts");
const guard = candidate
	? await import(pathToFileURL(guardPath).href)
	: undefined;
progress("imported");
const piExecutable = process.env.OWNER_LIFELINE_PI ?? process.env.ROTOM_PI;
const sdkAvailable = Boolean(piExecutable) && process.platform !== "win32";
let sdk;
if (sdkAvailable) {
	const verified = await probePiVersion({
		executable: piExecutable,
	});
	sdk = {
		piEntry: verified.publicEntry,
		fauxEntry: publicFauxEntry(verified.packageRoot),
	};
}
function harness(fd = "3", openError = false) {
	const handlers = new Map();
	const channel = new EventEmitter();
	const state = { abort: 0, shutdown: 0, disconnect: 0, unref: 0, open: 0 };
	channel.resume = () => channel;
	channel.unref = () => {
		state.unref++;
		return channel;
	};
	channel.destroy = () => {
		channel.emit("close");
		return channel;
	};
	const context = {
		abort() {
			state.abort++;
		},
		shutdown() {
			state.shutdown++;
		},
	};
	guard.registerOwnerLifeline(
		{
			on(name, fn) {
				handlers.set(name, fn);
			},
		},
		{
			fd,
			open() {
				state.open++;
				if (openError) throw Error("fixture open error");
				return channel;
			},
			disconnectChildren() {
				state.disconnect++;
			},
		},
	);
	return {
		state,
		channel,
		handlers,
		emit(name) {
			return handlers.get(name)?.({}, context);
		},
	};
}
const unit = { skip: !candidate ? "helper does not exist in baseline" : false };
test(
	"startup is deferred; healthy pipe does not block tools or pin the event loop",
	unit,
	() => {
		const h = harness();
		assert.equal(h.state.open, 0);
		h.emit("session_start");
		assert.equal(h.state.open, 1);
		assert.equal(h.state.unref, 1);
		assert.equal(h.emit("tool_call"), undefined);
		assert.equal(h.state.abort, 0);
	},
);
test(
	"EOF aborts through public context and disconnects linked descendants once",
	unit,
	() => {
		const h = harness();
		h.emit("session_start");
		h.channel.emit("end");
		h.channel.emit("close");
		assert.equal(h.state.abort, 1);
		assert.equal(h.state.disconnect, 1);
		assert.equal(h.emit("tool_call").block, true);
	},
);
test("transport error is owner loss, not permission to continue", unit, () => {
	const h = harness();
	h.emit("session_start");
	h.channel.emit("error", Error("fixture"));
	assert.equal(h.emit("tool_call").block, true);
});
test("bad descriptor fails closed without opening a different fd", unit, () => {
	const h = harness("19");
	h.emit("session_start");
	assert.equal(h.state.open, 0);
	assert.equal(h.emit("tool_call").block, true);
});
test(
	"managed children cannot silently downgrade when transport configuration is absent",
	unit,
	() => {
		const old = process.env[guard.OWNER_LIFELINE_ENV];
		delete process.env[guard.OWNER_LIFELINE_ENV];
		try {
			const handlers = new Map();
			let aborts = 0;
			const ctx = {
				abort() {
					aborts++;
				},
				shutdown() {},
			};
			guard.registerOwnerLifeline(
				{
					on(name, fn) {
						handlers.set(name, fn);
					},
				},
				{
					required: true,
					open() {
						assert.fail("must not open an unconfigured descriptor");
					},
				},
			);
			handlers.get("session_start")({}, ctx);
			assert.equal(aborts, 1);
			assert.equal(handlers.get("tool_call")({}, ctx).block, true);
			const optional = new Map();
			guard.registerOwnerLifeline(
				{
					on(name, fn) {
						optional.set(name, fn);
					},
				},
				{ required: false },
			);
			assert.equal(optional.size, 0);
		} finally {
			if (old === undefined) delete process.env[guard.OWNER_LIFELINE_ENV];
			else process.env[guard.OWNER_LIFELINE_ENV] = old;
		}
	},
);
test("descriptor open failure blocks tool dispatch", unit, () => {
	const h = harness("3", true);
	h.emit("session_start");
	assert.equal(h.emit("tool_call").block, true);
});
test(
	"owner loss remains sticky on later model and agent callbacks",
	unit,
	() => {
		const h = harness();
		h.emit("session_start");
		h.channel.emit("end");
		const before = h.state.abort;
		h.emit("agent_start");
		h.emit("before_provider_request");
		assert.equal(h.state.abort, before + 2);
		assert.equal(h.emit("tool_call").block, true);
	},
);
test(
	"normal shutdown disposes the reader without a spurious abort",
	unit,
	() => {
		const h = harness();
		h.emit("session_start");
		h.emit("session_shutdown");
		h.channel.emit("end");
		assert.equal(h.state.abort, 0);
		assert.equal(h.state.disconnect, 0);
	},
);
test(
	"closed owned child handles are released and other channels remain linked",
	unit,
	() => {
		const a = new EventEmitter();
		const b = new EventEmitter();
		let da = 0,
			db = 0;
		const ca = new EventEmitter();
		ca.destroy = () => {
			da++;
		};
		const cb = new EventEmitter();
		cb.destroy = () => {
			db++;
		};
		a.stdio = [null, null, null, ca];
		b.stdio = [null, null, null, cb];
		guard.trackOwnedLifeline(a);
		guard.trackOwnedLifeline(b);
		a.emit("close");
		guard.disconnectOwnedLifelines();
		assert.equal(da, 1);
		assert.equal(db, 1);
		guard.disconnectOwnedLifelines();
		assert.equal(db, 1);
	},
);
test(
	"child exit releases the extra pipe before close can wait on inherited readers",
	unit,
	() => {
		const child = new EventEmitter();
		const channel = new EventEmitter();
		let destroyed = 0;
		channel.destroy = () => {
			destroyed++;
		};
		child.stdio = [null, null, null, channel];
		guard.trackOwnedLifeline(child);
		child.emit("exit");
		assert.equal(destroyed, 1);
		child.emit("close");
		guard.disconnectOwnedLifelines();
		assert.equal(destroyed, 1);
	},
);
test("cascade failure cannot prevent local abort", unit, () => {
	const handlers = new Map();
	const channel = new EventEmitter();
	channel.resume = () => channel;
	channel.unref = () => channel;
	channel.destroy = () => channel;
	let aborted = 0;
	guard.registerOwnerLifeline(
		{
			on(name, fn) {
				handlers.set(name, fn);
			},
		},
		{
			fd: "3",
			open: () => channel,
			disconnectChildren() {
				throw Error("fixture");
			},
		},
	);
	const ctx = {
		abort() {
			aborted++;
		},
		shutdown() {},
	};
	handlers.get("session_start")({}, ctx);
	channel.emit("end");
	assert.equal(aborted, 1);
	assert.equal(handlers.get("tool_call")({}, ctx).block, true);
});
test("separately evaluated modules share owned handles", unit, async () => {
	const second = await import(
		pathToFileURL(guardPath).href + "?separate-loader"
	);
	const child = new EventEmitter();
	const channel = new EventEmitter();
	let closed = 0;
	channel.destroy = () => {
		closed++;
	};
	child.stdio = [null, null, null, channel];
	second.trackOwnedLifeline(child);
	guard.disconnectOwnedLifelines();
	assert.equal(closed, 1);
});
test(
	"argument builder clears inherited descriptor authority",
	unit,
	async () => {
		const { buildPiArgs } = await import(
			pathToFileURL(path.join(source, "src/runs/shared/pi-args.ts")).href
		);
		const old = process.env[guard.OWNER_LIFELINE_ENV];
		try {
			process.env[guard.OWNER_LIFELINE_ENV] = "3";
			const { env } = buildPiArgs({
				baseArgs: ["-p"],
				task: "fixture",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
			});
			assert.ok(Object.hasOwn(env, guard.OWNER_LIFELINE_ENV));
			assert.equal(env[guard.OWNER_LIFELINE_ENV], undefined);
		} finally {
			if (old === undefined) delete process.env[guard.OWNER_LIFELINE_ENV];
			else process.env[guard.OWNER_LIFELINE_ENV] = old;
		}
	},
);
async function waitFile(file, timeoutMs = 20000) {
	if (fs.existsSync(file)) return true;
	return await new Promise((resolve) => {
		const watcher = fs.watch(path.dirname(file), () => {
			if (fs.existsSync(file)) {
				clearTimeout(timer);
				watcher.close();
				resolve(true);
			}
		});
		const timer = setTimeout(() => {
			watcher.close();
			resolve(false);
		}, timeoutMs);
		if (fs.existsSync(file)) {
			clearTimeout(timer);
			watcher.close();
			resolve(true);
		}
	});
}
function processIsActive(r) {
	if (r.error || ![0, 1].includes(r.status))
		throw new Error("Process observation unavailable");
	if (r.status === 1 && !r.stdout.trim() && !r.stderr?.trim()) return false;
	if (r.status !== 0 || !r.stdout.trim())
		throw new Error("Process observation inconclusive");
	return !r.stdout.trim().startsWith("Z");
}
test("process observation failures are unknown, not proof of termination", () => {
	assert.throws(() =>
		processIsActive({ status: null, error: Error("timeout"), stdout: "" }),
	);
	assert.throws(() => processIsActive({ status: 2, stdout: "" }));
	assert.throws(() =>
		processIsActive({ status: 1, stdout: "", stderr: "unavailable" }),
	);
	assert.equal(processIsActive({ status: 1, stdout: "", stderr: "" }), false);
	assert.equal(processIsActive({ status: 0, stdout: "S" }), true);
});
function active(pid) {
	assert.ok(Number.isSafeInteger(pid) && pid > 0);
	return processIsActive(
		spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
			encoding: "utf8",
			timeout: 1000,
		}),
	);
}
async function stopped(pids) {
	const end = Date.now() + 5000;
	while (pids.some(active) && Date.now() < end)
		await new Promise((r) => setTimeout(r, 25));
	return pids.every((p) => !active(p));
}
function publicFauxEntry(piRoot) {
	let dir = piRoot;
	while (true) {
		const p = path.join(dir, "node_modules/@earendil-works/pi-ai/package.json");
		if (fs.existsSync(p)) {
			const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
			assert.equal(pkg.name, "@earendil-works/pi-ai");
			const exp = pkg.exports["./providers/*"].import;
			assert.ok(exp.startsWith("./"));
			const entry = path.resolve(path.dirname(p), exp.replaceAll("*", "faux"));
			assert.ok(fs.existsSync(entry));
			return entry;
		}
		const parent = path.dirname(dir);
		if (parent === dir) throw Error("public faux provider not found");
		dir = parent;
	}
}
for (const scenario of [
	"healthy",
	"owner-loss",
	"cascade",
	"early-loss",
	"cancel",
	"noncooperative",
]) {
	const killOwner = scenario !== "healthy" && scenario !== "cancel";
	const requestAbort = killOwner || scenario === "cancel";
	const cascade = scenario === "cascade";
	const early = scenario === "early-loss";
	const noncooperative = scenario === "noncooperative";
	test(
		`actual Pi SDK + faux: ${scenario}`,
		{
			timeout: 65000,
			skip: !sdkAvailable
				? "set ROTOM_PI or OWNER_LIFELINE_PI on POSIX for no-network SDK smoke"
				: false,
		},
		async (t) => {
			const dir = fs.mkdtempSync(path.join(root, "case-"));
			let fixtureVerified = false;
			const owner = path.join(dir, "owner.mjs");
			const wrapper = path.join(dir, "guard.mjs");
			if (candidate)
				fs.writeFileSync(
					wrapper,
					`import fs from 'node:fs';import {registerOwnerLifeline} from ${JSON.stringify(pathToFileURL(guardPath).href)};
export default api => registerOwnerLifeline({on(name,fn){api.on(name,(event,ctx)=>fn(event,{...ctx,abort(){fs.writeFileSync(${JSON.stringify(path.join(dir, "abort-requested"))},'requested');return ctx.abort();}}));}});`,
				);
			const sdkChild = fileURLToPath(
				new URL("../fixtures/lifeline-sdk-child.mjs", import.meta.url),
			);
			fs.writeFileSync(
				path.join(dir, "config.json"),
				JSON.stringify({
					...sdk,
					cwd: dir,
					noncooperative,
					guardExtension: candidate ? wrapper : undefined,
				}),
			);
			fs.writeFileSync(
				path.join(dir, "leaf.mjs"),
				`import fs from 'node:fs';import path from 'node:path';const d=process.argv[2];process.on('SIGTERM',()=>{});const w=fs.watch(d,()=>{if(fs.existsSync(path.join(d,'release'))){fs.writeFileSync(path.join(d,'late-write'),'written');w.close();clearTimeout(timer);process.exit(0);}});const timer=setTimeout(()=>process.exit(0),40000);fs.writeFileSync(path.join(d,'leaf-ready'),String(process.pid));`,
			);
			fs.writeFileSync(
				path.join(dir, "tool.mjs"),
				`import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';const d=path.dirname(fileURLToPath(import.meta.url));const c=spawn(process.execPath,[path.join(d,'leaf.mjs'),d],{stdio:'ignore'});fs.writeFileSync(path.join(d,'tool-ready'),JSON.stringify({pid:process.pid,leaf:c.pid}));c.on('exit',()=>process.exit(0));`,
			);
			const middle = path.join(dir, "middle.mjs");
			if (cascade)
				fs.writeFileSync(
					middle,
					`import fs from 'node:fs';import {spawn} from 'node:child_process';${candidate ? `import {trackOwnedLifeline,registerOwnerLifeline} from ${JSON.stringify(pathToFileURL(guardPath).href)};` : ""}const c=spawn(process.execPath,['--experimental-strip-types',${JSON.stringify(sdkChild)},${JSON.stringify(path.join(dir, "config.json"))}],{env:process.env,stdio:['ignore','ignore','inherit','pipe']});${candidate ? `trackOwnedLifeline(c);registerOwnerLifeline({on(name,fn){if(name==='session_start')fn({},{abort(){fs.writeFileSync(${JSON.stringify(path.join(dir, "middle-lost"))},'lost');},shutdown(){}});}});` : ""}fs.writeFileSync(${JSON.stringify(path.join(dir, "middle-ready"))},JSON.stringify({pid:process.pid,childPid:c.pid}));setTimeout(()=>process.exit(0),45000);`,
				);
			fs.writeFileSync(
				owner,
				`import {spawn} from 'node:child_process';const c=spawn(process.execPath,['--experimental-strip-types',${JSON.stringify(cascade ? middle : sdkChild)},${JSON.stringify(path.join(dir, "config.json"))}],{env:{...process.env,PI_SUBAGENT_OWNER_LIFELINE_FD:${candidate ? '"3"' : "undefined"}},stdio:['ignore','ignore','inherit','pipe']});process.send({childPid:c.pid});c.on('exit',code=>process.exit(code??1));`,
			);
			const home = path.join(dir, "home"); fs.mkdirSync(home, { mode: 0o700 });
			const proc = spawn(process.execPath, [owner], {
				cwd: dir,
				env: { PATH: process.env.PATH, HOME: home, TMPDIR: dir, PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			let childPid, middlePid;
			let toolPids = [];
			let stderrBytes = 0;
			proc.stderr.on("data", (b) => {
				stderrBytes += b.length;
			});
			t.after(async () => {
				// A failed startup/handshake may have created descendants we have not
				// identified. Keep their cwd and evidence, even after known handles close.
				if (!fixtureVerified) { retainFixture = true; t.diagnostic(`Unverified fixture retained: ${dir}`); }
				try {
					const exit =
						proc.exitCode === null && proc.signalCode === null
							? once(proc, "exit", { signal: AbortSignal.timeout(5000) })
							: undefined;
					proc.kill("SIGKILL");
					await exit;
					const readyFile = path.join(dir, "tool-ready");
					if (fs.existsSync(readyFile)) {
						const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
						toolPids = [ready.pid, ready.leaf];
					}
					for (const pid of [childPid, middlePid, ...toolPids].filter(
						Boolean,
					)) {
						const p = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
							encoding: "utf8",
							timeout: 1000,
						});
						if (p.error || ![0, 1].includes(p.status))
							throw new Error("Fixture process identity unavailable");
						if (p.status === 0 && p.stdout.includes(dir)) {
							try {
								process.kill(pid, "SIGKILL");
							} catch (error) {
								if (error.code !== "ESRCH") throw error;
							}
							if (!(await stopped([pid])))
								throw new Error("Fixture process termination unconfirmed");
						}
					}
				} catch (error) {
					retainFixture = true;
					throw error;
				}
			});
			childPid = (
				await once(proc, "message", { signal: AbortSignal.timeout(20000) })
			)[0].childPid;
			if (cascade) {
				middlePid = childPid;
				assert.ok(await waitFile(path.join(dir, "middle-ready")));
				childPid = JSON.parse(
					fs.readFileSync(path.join(dir, "middle-ready"), "utf8"),
				).childPid;
			}
			if (!early) {
				const readySeen = await waitFile(path.join(dir, "leaf-ready"));
				if (!readySeen)
					for (const name of ["stage.json", "sdk-result.json"]) {
						const file = path.join(dir, name);
						if (fs.existsSync(file))
							t.diagnostic(fs.readFileSync(file, "utf8"));
					}
				assert.ok(
					readySeen,
					`SDK fixture not ready; stderr bytes=${stderrBytes}`,
				);
				const ready = JSON.parse(
					fs.readFileSync(path.join(dir, "tool-ready"), "utf8"),
				);
				toolPids = [ready.pid, ready.leaf];
				assert.ok(toolPids.every(active));
			}
			if (killOwner) {
				const exit = once(proc, "exit");
				proc.kill("SIGKILL");
				await exit;
			}
			if (scenario === "cancel") fs.writeFileSync(path.join(dir, "cancel"), "cancel");
			if (requestAbort && candidate) assert.ok(await waitFile(path.join(dir, "abort-requested")), "abort must be requested before observing convergence");
			let endedBeforeRelease = false;
			if (noncooperative && candidate) {
				assert.ok(await waitFile(path.join(dir, "abort-seen")), "stubborn tool must receive cancellation before release");
				assert.equal(fs.existsSync(path.join(dir, "sdk-result.json")), false);
			} else if (requestAbort) {
				endedBeforeRelease = await waitFile(path.join(dir, "sdk-result.json"), 10000);
			}
			if (early && !endedBeforeRelease) {
				assert.ok(await waitFile(path.join(dir, "leaf-ready")));
				const ready = JSON.parse(
					fs.readFileSync(path.join(dir, "tool-ready"), "utf8"),
				);
				toolPids = [ready.pid, ready.leaf];
			}
			const treeStoppedBeforeRelease = requestAbort
				? noncooperative ? !toolPids.some(active) : await stopped(toolPids)
				: false;
			if (cascade)
				assert.ok(
					active(middlePid),
					"Cascade must be tested while the intermediate owner is still alive",
				);
			fs.writeFileSync(path.join(dir, "release"), "go");
			if (!requestAbort || !treeStoppedBeforeRelease)
				assert.ok(await waitFile(path.join(dir, "late-write")));
			assert.ok(await waitFile(path.join(dir, "sdk-result.json")));
			const result = JSON.parse(
				fs.readFileSync(path.join(dir, "sdk-result.json"), "utf8"),
			);
			assert.equal(result.extensionErrors, 0);
			if (noncooperative) {
				assert.equal(
					endedBeforeRelease,
					false,
					"Ignoring AbortSignal must not be reported as converged",
				);
				assert.equal(treeStoppedBeforeRelease, false);
				assert.ok(fs.existsSync(path.join(dir, "late-write")));
			} else if (requestAbort) {
				assert.ok(
					endedBeforeRelease,
					"Pi did not settle before releasing the writer",
				);
				assert.ok(
					treeStoppedBeforeRelease,
					"Tool descendants still active after owner loss",
				);
				assert.ok(
					!fs.existsSync(path.join(dir, "late-write")),
					"Writer mutated after release",
				);
				if (early)
					assert.ok(
						!fs.existsSync(path.join(dir, "tool-ready")),
						"Tool started after pre-start owner loss",
					);
				else assert.ok(result.toolErrors >= 1);
				if (cascade) assert.ok(fs.existsSync(path.join(dir, "middle-lost")));
			} else {
				assert.equal(result.toolErrors, 0);
				assert.equal(result.modelCalls, 2);
			}
			assert.ok(
				await stopped([childPid]),
				"Healthy lifeline must not pin the SDK process",
			);
			fixtureVerified = true;
		},
	);
}
