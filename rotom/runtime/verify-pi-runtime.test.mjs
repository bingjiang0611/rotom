import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { RESOURCE_DESCRIPTORS_V1 } from "./product-config.mjs";
import { verifyPiRuntime, verifyThirdPartyPackageContract } from "./verify-pi-runtime.mjs";

const REPOSITORY = resolve(import.meta.dirname, "../..");
const AGENT_DIR = resolve(REPOSITORY, "rotom");
const LAUNCHER = resolve(AGENT_DIR, "bin/rotom-launcher");

function resourceDeclarations(agentDir = AGENT_DIR) {
	return RESOURCE_DESCRIPTORS_V1.map((resource) => `${resource.kind}:${resolve(agentDir, resource.path)}`);
}

function fakePi(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "rotom-fake-pi-"));
	const packageRoot = join(root, "lib/node_modules/fake-pi");
	const dist = join(packageRoot, "dist");
	const bin = join(root, "bin");
	mkdirSync(dist, { recursive: true });
	mkdirSync(bin, { recursive: true });
	const name = options.name ?? "@earendil-works/pi-coding-agent";
	const version = options.version ?? "0.84.3";
	const exportsObject = { ".": { import: "./dist/index.js" } };
	const packageJson = options.invalidJson
		? "{not-json"
		: JSON.stringify({ name, version, type: "module", bin: { pi: "dist/cli.js" }, exports: exportsObject });
	writeFileSync(join(packageRoot, "package.json"), packageJson);
	writeFileSync(join(dist, "index.js"), [
		`export const VERSION = ${JSON.stringify(options.publicVersion ?? version)};`,
		options.invalidLoaderShape
			? "export class DefaultResourceLoader {}"
			: "export class DefaultResourceLoader { reload() {} getExtensions() {} getSkills() {} }",
		"export class SettingsManager { static create() {} }",
		"export class SessionManager { static inMemory() {} }",
		"export class ModelRuntime { static create() {} }",
		options.missingCreateAgentSession ? "" : "export async function createAgentSession() {}",
		options.missingDefineTool
			? ""
			: options.invalidDefineToolType
				? "export const defineTool = 42;"
				: "export function defineTool(value) { return value; }",
		options.missingCreateBashTool ? "" : options.invalidCreateBashToolType ? "export const createBashToolDefinition = 42;" : "export function createBashToolDefinition() {}",
	].join("\n"));
	writeFileSync(join(dist, "cli.js"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ROTOM_TEST_CAPTURE, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), nodeExecutable: process.execPath, nodeVersion: process.versions.node, verifiedPiExecutable: process.env.ROTOM_VERIFIED_PI_EXECUTABLE, maxSubagentSpawnsPerSession: process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION, cacheRetention: process.env.PI_CACHE_RETENTION, deferredDefaultSurface: process.env.ROTOM_DEFERRED_DEFAULT_SURFACE, computerUseHeadless: process.env.PI_COMPUTER_USE_HEADLESS, executionScope: process.env.PI_SUBAGENTS_EXECUTION_SCOPE, subagentTempRoot: process.env.PI_SUBAGENTS_TEMP_ROOT }));
`);
	chmodSync(join(dist, "cli.js"), 0o700);
	symlinkSync("../lib/node_modules/fake-pi/dist/cli.js", join(bin, "pi"));
	return { root, packageRoot, executable: join(bin, "pi") };
}

function installRejectingLowNode(root) {
	const executable = join(root, "bin/node");
	writeFileSync(executable, `#!/bin/sh
if [ "$1" = "-e" ]; then
	exec ${JSON.stringify(process.execPath)} "$@"
fi
echo "rotom: Node runtime 22.23.1 不受支持；要求 >=23.6.0" >&2
exit 1
`);
	chmodSync(executable, 0o700);
	return executable;
}

function installHerdrPiExtension(home, version = "8") {
	const extension = join(home, ".pi/agent/extensions/herdr-agent-state.ts");
	mkdirSync(join(home, ".pi/agent/extensions"), { recursive: true });
	writeFileSync(extension, `// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=pi
// HERDR_INTEGRATION_VERSION=${version}
export default function () {}
`);
	return extension;
}

async function withFakePi(options, run) {
	const fake = fakePi(options);
	const previousPi = process.env.ROTOM_PI;
	process.env.ROTOM_PI = fake.executable;
	try {
		await run(fake);
	} finally {
		if (previousPi === undefined) delete process.env.ROTOM_PI;
		else process.env.ROTOM_PI = previousPi;
		rmSync(fake.root, { recursive: true, force: true });
	}
}

test("精确 package identity、semver、bin、public exports 和 capability 通过本地 gate", () => withFakePi({}, async ({ executable }) => {
	const result = await verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() });
	assert.equal(result.version, "0.84.3");
	assert.match(result.executable, /dist\/cli\.js$/u);
}));

test("拒绝低于产品要求的 Node runtime", () => withFakePi({}, async ({ executable }) => {
	await assert.rejects(
		verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations(), nodeVersion: "23.5.9" }),
		/Node runtime .*要求 >=23\.6\.0/,
	);
}));

test("四个第三方运行时 package/lock/installed identity 与直接依赖列表精确固定", async () => {
	await verifyThirdPartyPackageContract(AGENT_DIR);
	const root = mkdtempSync(join(tmpdir(), "rotom-third-party-contract-"));
	try {
		mkdirSync(join(root, "extensions"), { recursive: true });
		cpSync(join(AGENT_DIR, "extensions/third-party"), join(root, "extensions/third-party"), { recursive: true });
		const packagePath = resolve(root, "extensions/third-party/package.json");
		const originalPackageJson = JSON.parse(readFileSync(packagePath, "utf8"));
		const packageJson = structuredClone(originalPackageJson);
		packageJson.dependencies["pi-subagents"] = "^0.52.1";
		writeFileSync(packagePath, JSON.stringify(packageJson));
		await assert.rejects(verifyThirdPartyPackageContract(root), /必须精确依赖/u);

		const lockPath = resolve(root, "extensions/third-party/package-lock.json");
		const lock = JSON.parse(readFileSync(lockPath, "utf8"));
		originalPackageJson.dependencies["pi-background-tasks"] = "2.4.2";
		lock.packages[""].dependencies["pi-background-tasks"] = "2.4.2";
		writeFileSync(packagePath, JSON.stringify(originalPackageJson));
		writeFileSync(lockPath, JSON.stringify(lock));
		await assert.rejects(verifyThirdPartyPackageContract(root), /direct package 列表必须精确匹配/u);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const version of ["0.84.1", "0.85.0", "1.0.0-next.1"]) {
	test(`版本 ${version} 只要公开 capability 兼容即可通过`, () => withFakePi({ version }, async ({ executable }) => {
		const result = await verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() });
		assert.equal(result.version, version);
	}));
}

test("拒绝无法解析版本、错误 package 与缺失公开能力", async (t) => {
	await t.test("无法解析版本", () => withFakePi({ version: "latest" }, async ({ executable }) => {
		await assert.rejects(verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() }), /无法解析 Pi package 版本/);
	}));
	await t.test("无法解析 package.json", () => withFakePi({ invalidJson: true }, async ({ executable }) => {
		await assert.rejects(verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() }), /无法解析 Pi package.json/);
	}));
	await t.test("错误 package", () => withFakePi({ name: "malicious-pi" }, async ({ executable }) => {
		await assert.rejects(verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() }), /identity 不匹配/);
	}));
	await t.test("公开入口缺 defineTool", () => withFakePi({ missingDefineTool: true }, async ({ executable }) => {
		await assert.rejects(verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() }), /缺少关键能力：defineTool/);
	}));
	await t.test("公开入口 defineTool 类型不兼容", () => withFakePi({ invalidDefineToolType: true }, async ({ executable }) => {
		await assert.rejects(verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() }), /关键能力类型不兼容：defineTool/);
	}));
	await t.test("公开入口缺 createBashToolDefinition", () => withFakePi({ missingCreateBashTool: true }, async ({ executable }) => {
		await assert.rejects(verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() }), /缺少关键能力：createBashToolDefinition/);
	}));
	await t.test("公开入口 createBashToolDefinition 类型不兼容", () => withFakePi({ invalidCreateBashToolType: true }, async ({ executable }) => {
		await assert.rejects(verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() }), /关键能力类型不兼容：createBashToolDefinition/);
	}));
	await t.test("公开入口缺 createAgentSession", () => withFakePi({ missingCreateAgentSession: true }, async ({ executable }) => {
		await assert.rejects(verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() }), /缺少关键能力：createAgentSession/);
	}));
	await t.test("公开 loader 缺少关键方法", () => withFakePi({ invalidLoaderShape: true }, async ({ executable }) => {
		await assert.rejects(verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations() }), /关键方法不兼容：DefaultResourceLoader\.prototype\.reload/);
	}));
});

test("资源缺失或 launcher 声明漂移时 fail closed", () => withFakePi({}, async ({ executable }) => {
	await assert.rejects(
		verifyPiRuntime({ executable, agentDir: AGENT_DIR, resourceDeclarations: resourceDeclarations().slice(1) }),
		/显式资源.*不一致/,
	);
	const emptyAgent = mkdtempSync(join(tmpdir(), "rotom-empty-"));
	try {
		await assert.rejects(
			verifyPiRuntime({ executable, agentDir: emptyAgent, resourceDeclarations: resourceDeclarations(emptyAgent) }),
			/缺少运行时资源/,
		);
	} finally {
		rmSync(emptyAgent, { recursive: true, force: true });
	}
}));

test("required runtime resources reject internal and external symlink targets", () => withFakePi({}, async ({ executable }) => {
	const parent = mkdtempSync(join(tmpdir(), "rotom-resource-symlink-"));
	const agentDir = join(parent, "rotom");
	cpSync(AGENT_DIR, agentDir, { recursive: true });
	const resource = join(agentDir, "extensions/third-party/subagent/policy.ts");
	const original = readFileSync(resource, "utf8");
	try {
		rmSync(resource);
		const internalTarget = join(agentDir, "extensions/third-party/subagent/policy-target.ts");
		writeFileSync(internalTarget, original);
		symlinkSync("policy-target.ts", resource);
		await assert.rejects(
			verifyPiRuntime({ executable, agentDir, resourceDeclarations: resourceDeclarations(agentDir) }),
			/symlink/u,
		);

		rmSync(resource);
		const externalTarget = join(parent, "outside.ts");
		writeFileSync(externalTarget, original);
		symlinkSync(externalTarget, resource);
		await assert.rejects(
			verifyPiRuntime({ executable, agentDir, resourceDeclarations: resourceDeclarations(agentDir) }),
			/symlink/u,
		);

		rmSync(resource);
		writeFileSync(resource, original);
		const chromeDirectory = join(agentDir, "extensions/browser/chrome-extension");
		const chromeTarget = join(agentDir, "extensions/browser/chrome-extension-target");
		cpSync(chromeDirectory, chromeTarget, { recursive: true });
		rmSync(chromeDirectory, { recursive: true });
		symlinkSync("chrome-extension-target", chromeDirectory, "dir");
		await assert.rejects(
			verifyPiRuntime({ executable, agentDir, resourceDeclarations: resourceDeclarations(agentDir) }),
			/symlink|canonical 漂移/u,
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}));

test("resource verifier 与 launcher bootstrap 均 fail closed", () => withFakePi({}, async ({ executable, root }) => {
	const parent = mkdtempSync(join(tmpdir(), "rotom-resource-bootstrap-"));
	const agentDir = join(parent, "rotom");
	const thirdPartyEntry = join(agentDir, "extensions/third-party/node_modules/pi-subagents/index.ts");
	cpSync(AGENT_DIR, agentDir, { recursive: true });
	rmSync(thirdPartyEntry);
	try {
		await assert.rejects(
			verifyPiRuntime({ executable, agentDir, resourceDeclarations: resourceDeclarations(agentDir) }),
			/pi-subagents\/index\.ts/u,
		);
		const launchVersion = () => spawnSync(join(agentDir, "bin/rotom-launcher"), ["--version"], {
			cwd: parent,
			encoding: "utf8",
			env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, ROTOM_NODE: process.execPath },
		});
		const missingResource = launchVersion();
		assert.notEqual(missingResource.status, 0);
		assert.match(missingResource.stderr, /缺少运行时资源.*pi-subagents\/index\.ts/u);
		cpSync(join(AGENT_DIR, "extensions/third-party/node_modules/pi-subagents/index.ts"), thirdPartyEntry);

		for (const relativePath of ["runtime/verify-pi-runtime.mjs", "runtime/product-config.mjs"]) {
			const bootstrap = join(agentDir, relativePath);
			const target = `${bootstrap}.target`;
			writeFileSync(target, readFileSync(bootstrap, "utf8"));
			rmSync(bootstrap);
			symlinkSync(target, bootstrap);
			const symlinkedBootstrap = launchVersion();
			assert.notEqual(symlinkedBootstrap.status, 0);
			assert.match(symlinkedBootstrap.stderr, /缺少可信 bootstrap 资源/u);
			rmSync(bootstrap);
			cpSync(target, bootstrap);
			rmSync(target);
		}
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}));

test("launcher 的 version probe 验证 package identity 且不启动 Pi runtime", () => withFakePi({}, async ({ root }) => {
	const capture = join(root, "version-capture.json");
	const result = spawnSync(LAUNCHER, ["--version"], {
		encoding: "utf8",
		env: {
			...process.env,
			HOME: join(root, "home"),
			PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
			ROTOM_NODE: process.execPath,
			ROTOM_TEST_CAPTURE: capture,
		},
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "0.84.3\n");
	assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON/u, "version probe must not emit Node module-type warnings");
	assert.equal(existsSync(capture), false);
}));

test("launcher 的 version probe 拒绝伪造的 Pi package", () => withFakePi({ name: "malicious-pi" }, async ({ root }) => {
	const result = spawnSync(LAUNCHER, ["--version"], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, ROTOM_NODE: process.execPath },
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Pi package identity 不匹配/u);
}));

test("launcher 保留业务 cwd 与用户参数，并固定加载 bundled resources", () => withFakePi({}, async ({ root }) => {
	const businessCwd = mkdtempSync(join(tmpdir(), "rotom-business-"));
	const capture = join(root, "capture.json");
	try {
		execFileSync(LAUNCHER, ["--print", "argument with spaces", "--", "tail"], {
			cwd: businessCwd,
			env: {
				...process.env,
				HOME: join(root, "home"),
				PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
				ROTOM_NODE: process.execPath,
				ROTOM_TEST_CAPTURE: capture,
				PI_CACHE_RETENTION: "long",
				ROTOM_DEFERRED_DEFAULT_SURFACE: "0",
			},
		});
		const invocation = JSON.parse(readFileSync(capture, "utf8"));
		assert.equal(invocation.cwd, realpathSync(businessCwd));
		assert.equal(invocation.nodeExecutable, realpathSync(process.execPath));
		assert.equal(invocation.nodeVersion, process.versions.node);
		assert.equal(invocation.verifiedPiExecutable, realpathSync(join(root, "bin/pi")));
		assert.equal(invocation.maxSubagentSpawnsPerSession, "128", "launcher must provide a conservative cumulative child budget by default");
		assert.equal(invocation.cacheRetention, "long", "launcher must preserve the user's provider cache-retention choice without making it a product default");
		assert.equal(invocation.deferredDefaultSurface, "1", "launcher must authorize deferred narrowing only for its reviewed default tool surface");
		assert.equal(invocation.computerUseHeadless, "1", "launcher must keep desktop Computer Use writes in the background so agents never seize the user's foreground");
		assert.equal(invocation.executionScope, "owned-process-groups-v2", "new sessions must default to scoped owned execution");
		assert.equal(invocation.subagentTempRoot, join(root, "home/.local/state/rotom/subagent-store"), "the default store must be persistent per-user state, not a temp path");
		assert.deepEqual(invocation.argv, [
			"--no-extensions",
			"--extension", resolve(AGENT_DIR, "extensions/observability"),
			"--extension", resolve(AGENT_DIR, "extensions/browser/index.ts"),
			"--extension", resolve(AGENT_DIR, "extensions/coding-policy/index.ts"),
			"--extension", resolve(AGENT_DIR, "extensions/third-party"),
			"--extension", resolve(AGENT_DIR, "extensions/qoder/index.ts"),
			"--skill", resolve(AGENT_DIR, "skills/pi-subagents"),
			"--print", "argument with spaces", "--", "tail",
		]);

		for (const [index, toolArgs] of [["allow", ["--tools", "read,bash"]], ["exclude", ["--exclude-tools", "subagent_wait"]]]) {
			const explicitToolsCapture = join(root, `explicit-tools-${index}-capture.json`);
			execFileSync(LAUNCHER, [...toolArgs, "--print", "explicit tools"], {
				cwd: businessCwd,
				env: {
					...process.env,
					HOME: join(root, "home"),
					PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
					ROTOM_NODE: process.execPath,
					ROTOM_TEST_CAPTURE: explicitToolsCapture,
					ROTOM_DEFERRED_DEFAULT_SURFACE: "1",
				},
			});
			assert.equal(JSON.parse(readFileSync(explicitToolsCapture, "utf8")).deferredDefaultSurface, "0", `explicit ${toolArgs[0]} must remain authoritative even when the inherited environment claims a default surface`);
		}

		const overrideCapture = join(root, "override-capture.json");
		execFileSync(LAUNCHER, ["--print"], {
			cwd: businessCwd,
			env: {
				...process.env,
				HOME: join(root, "home"),
				PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
				ROTOM_NODE: process.execPath,
				ROTOM_TEST_CAPTURE: overrideCapture,
				PI_SUBAGENT_MAX_SPAWNS_PER_SESSION: "256",
			},
		});
		assert.equal(JSON.parse(readFileSync(overrideCapture, "utf8")).maxSubagentSpawnsPerSession, "256", "explicit user budget must override the product default");

		// Focus policy is the user's call: an explicit environment value or an explicit
		// `headless` key in either package user config must survive the product default,
		// including the value that re-enables foreground fallback.
		const headlessEnvironment = {
			...process.env,
			HOME: join(root, "home"),
			PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
			ROTOM_NODE: process.execPath,
		};
		delete headlessEnvironment.PI_COMPUTER_USE_HEADLESS;
		const headlessOptOutCapture = join(root, "headless-opt-out-capture.json");
		execFileSync(LAUNCHER, ["--print"], { cwd: businessCwd, env: { ...headlessEnvironment, ROTOM_TEST_CAPTURE: headlessOptOutCapture, PI_COMPUTER_USE_HEADLESS: "0" } });
		assert.equal(JSON.parse(readFileSync(headlessOptOutCapture, "utf8")).computerUseHeadless, "0", "explicit environment opt-out must override the product focus default");

		const computerUseConfigDirectory = join(root, "home/.pi/agent/extensions");
		mkdirSync(computerUseConfigDirectory, { recursive: true });
		const computerUseConfigPath = join(computerUseConfigDirectory, "pi-computer-use.json");
		for (const [label, contents] of [
			["flat", JSON.stringify({ headless: false })],
			["nested", JSON.stringify({ computer_use: { headless: false } })],
		]) {
			writeFileSync(computerUseConfigPath, contents);
			const userConfigCapture = join(root, `headless-${label}-config-capture.json`);
			execFileSync(LAUNCHER, ["--print"], { cwd: businessCwd, env: { ...headlessEnvironment, ROTOM_TEST_CAPTURE: userConfigCapture } });
			assert.equal(JSON.parse(readFileSync(userConfigCapture, "utf8")).computerUseHeadless, undefined, `explicit ${label} user config must stay authoritative without an injected default`);
		}
		writeFileSync(computerUseConfigPath, "{ not json");
		const unreadableConfigCapture = join(root, "headless-unreadable-config-capture.json");
		execFileSync(LAUNCHER, ["--print"], { cwd: businessCwd, env: { ...headlessEnvironment, ROTOM_TEST_CAPTURE: unreadableConfigCapture } });
		assert.equal(JSON.parse(readFileSync(unreadableConfigCapture, "utf8")).computerUseHeadless, "1", "a config the package itself ignores carries no focus intent, so the background default applies");
		rmSync(computerUseConfigPath, { force: true });

		mkdirSync(join(businessCwd, ".pi"), { recursive: true });
		writeFileSync(join(businessCwd, ".pi/computer-use.json"), JSON.stringify({ headless: false }));
		const projectConfigCapture = join(root, "headless-project-config-capture.json");
		execFileSync(LAUNCHER, ["--print"], { cwd: businessCwd, env: { ...headlessEnvironment, ROTOM_TEST_CAPTURE: projectConfigCapture } });
		assert.equal(JSON.parse(readFileSync(projectConfigCapture, "utf8")).computerUseHeadless, undefined, "a project config the package reads must stay authoritative");
		rmSync(join(businessCwd, ".pi"), { recursive: true, force: true });

		const configuredDirectory = join(root, "home/.pi/agent/extensions/subagent");
		mkdirSync(configuredDirectory, { recursive: true });
		writeFileSync(join(configuredDirectory, "config.json"), JSON.stringify({ maxSubagentSpawnsPerSession: 64 }));
		const configCapture = join(root, "config-capture.json");
		const configEnvironment = {
			...process.env,
			HOME: join(root, "home"),
			PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
			ROTOM_NODE: process.execPath,
			ROTOM_TEST_CAPTURE: configCapture,
		};
		delete configEnvironment.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
		execFileSync(LAUNCHER, ["--print"], { cwd: businessCwd, env: configEnvironment });
		assert.equal(JSON.parse(readFileSync(configCapture, "utf8")).maxSubagentSpawnsPerSession, undefined, "package user config must remain authoritative when environment is unset");
		const tildeCapture = join(root, "tilde-config-capture.json");
		execFileSync(LAUNCHER, ["--print"], { cwd: businessCwd, env: { ...configEnvironment, PI_CODING_AGENT_DIR: "~/.pi/agent", ROTOM_TEST_CAPTURE: tildeCapture } });
		assert.equal(JSON.parse(readFileSync(tildeCapture, "utf8")).maxSubagentSpawnsPerSession, undefined, "package-supported tilde config paths must preserve the user budget");
		writeFileSync(join(configuredDirectory, "config.json"), JSON.stringify({ maxSubagentSpawnsPerSession: "64" }));
		const invalidConfig = spawnSync(LAUNCHER, ["--version"], { cwd: businessCwd, encoding: "utf8", env: configEnvironment });
		assert.equal(invalidConfig.status, 2);
		assert.match(invalidConfig.stderr, /maxSubagentSpawnsPerSession 必须是非负整数/u);
	} finally {
		rmSync(businessCwd, { recursive: true, force: true });
	}
}));

test("launcher --trace 前台启动 loopback dashboard，不进入 Pi agent runtime", () => withFakePi({}, async ({ root }) => {
	const businessCwd = mkdtempSync(join(tmpdir(), "rotom-trace-dashboard-"));
	try {
		const env = {
			...process.env,
			HOME: join(root, "home"),
			PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
			ROTOM_NODE: process.execPath,
			ROTOM_TRACE_DASHBOARD_TEST_ONCE: "1",
		};
		const wrapperDirectory = join(root, "trace-wrapper-bin");
		const wrapper = join(wrapperDirectory, "pi");
		mkdirSync(wrapperDirectory, { recursive: true });
		writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(LAUNCHER)} "$@"\n`);
		chmodSync(wrapper, 0o700);
		const launched = spawnSync(wrapper, ["--trace"], { cwd: businessCwd, encoding: "utf8", env });
		assert.equal(launched.status, 0, launched.stderr);
		assert.match(launched.stdout, /Rotom trace dashboard: http:\/\/127\.0\.0\.1:\d+\/#token=/u);
		assert.match(launched.stdout, /Data: .*\.pi\/agent\/sessions/u);
		const combined = spawnSync(wrapper, ["--trace", "extra"], { cwd: businessCwd, encoding: "utf8", env });
		assert.equal(combined.status, 2);
		assert.match(combined.stderr, /--trace 必须单独使用/u);
	} finally {
		rmSync(businessCwd, { recursive: true, force: true });
	}
}));

test("launcher 不因 HOME 中存在未声明的 recorder 就自动加载它", () => withFakePi({}, async ({ root }) => {
	const businessCwd = mkdtempSync(join(tmpdir(), "rotom-private-addon-"));
	const home = join(root, "home");
	const packageRoot = join(home, ".local/lib/node_modules/private-recorder");
	const extension = join(packageRoot, "integrations/recorder.mjs");
	const capture = join(root, "addon-capture.json");
	try {
		mkdirSync(join(packageRoot, "integrations"), { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "private-recorder", version: "1.0.0" }));
		writeFileSync(extension, "throw new Error('must not load');\n");
		execFileSync(LAUNCHER, ["--print", "fixture"], {
			cwd: businessCwd,
			env: {
				...process.env,
				HOME: realpathSync(home),
				PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
				ROTOM_NODE: process.execPath,
				ROTOM_TEST_CAPTURE: capture,
			},
		});
		const invocation = JSON.parse(readFileSync(capture, "utf8"));
		const extensionPaths = invocation.argv.flatMap((argument, index, argv) => argument === "--extension" ? [argv[index + 1]] : []);
		assert.equal(extensionPaths.includes(realpathSync(extension)), false);
		assert.equal(extensionPaths.length, 5);
		await assert.rejects(verifyPiRuntime({ executable: process.env.ROTOM_PI, agentDir: AGENT_DIR,
			resourceDeclarations: [...resourceDeclarations(), `unknown-extension:${extension}`] }), /可选资源声明不受支持/u);
	} finally {
		rmSync(businessCwd, { recursive: true, force: true });
	}
}));

test("launcher 在 Herdr pane 中固定加载可信的 Pi lifecycle integration", () => withFakePi({}, async ({ root }) => {
	const businessCwd = mkdtempSync(join(tmpdir(), "rotom-herdr-"));
	const home = join(root, "home");
	const extension = installHerdrPiExtension(home);
	const capture = join(root, "herdr-capture.json");
	try {
		execFileSync(LAUNCHER, ["--print", "herdr"], {
			cwd: businessCwd,
			env: {
				...process.env,
				HOME: realpathSync(home),
				PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
				ROTOM_NODE: process.execPath,
				ROTOM_TEST_CAPTURE: capture,
				HERDR_ENV: "1",
				HERDR_SOCKET_PATH: join(root, "herdr.sock"),
				HERDR_PANE_ID: "w1:p1",
			},
		});
		const invocation = JSON.parse(readFileSync(capture, "utf8"));
		const extensionPaths = invocation.argv.flatMap((argument, index, argv) => argument === "--extension" ? [argv[index + 1]] : []);
		assert.equal(extensionPaths.includes(realpathSync(extension)), true);

		writeFileSync(extension, readFileSync(extension, "utf8").replace("HERDR_INTEGRATION_VERSION=8", "HERDR_INTEGRATION_VERSION=9"));
		const rejected = spawnSync(LAUNCHER, ["--print", "herdr"], {
			cwd: businessCwd,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: realpathSync(home),
				PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
				ROTOM_NODE: process.execPath,
				ROTOM_TEST_CAPTURE: capture,
				HERDR_ENV: "1",
				HERDR_SOCKET_PATH: join(root, "herdr.sock"),
				HERDR_PANE_ID: "w1:p1",
			},
		});
		assert.notEqual(rejected.status, 0);
		assert.match(rejected.stderr, /Herdr Pi extension identity\/version 不可信/u);
	} finally {
		rmSync(businessCwd, { recursive: true, force: true });
	}
}));

test("ROTOM_PI 覆盖 PATH，并固定执行通过验证的 canonical Pi", () => withFakePi({}, async ({ root: pathRoot }) => {
	await withFakePi({ version: "0.85.0" }, async ({ root: overrideRoot, executable }) => {
		const businessCwd = mkdtempSync(join(tmpdir(), "rotom-pi-override-"));
		const capture = join(overrideRoot, "pi-override-capture.json");
		try {
			execFileSync(LAUNCHER, ["--print", "pi override"], {
				cwd: businessCwd,
				env: {
					...process.env,
					HOME: join(overrideRoot, "home"),
					PATH: `${join(pathRoot, "bin")}:${process.env.PATH ?? ""}`,
					ROTOM_NODE: process.execPath,
					ROTOM_PI: executable,
					ROTOM_TEST_CAPTURE: capture,
				},
			});
			const invocation = JSON.parse(readFileSync(capture, "utf8"));
			assert.equal(invocation.verifiedPiExecutable, realpathSync(executable));
		} finally {
			rmSync(businessCwd, { recursive: true, force: true });
		}
	});
}));

test("launcher 复用 Claude Code 用户 skill，并发现 cwd 到 Git 根的项目 skill", () => withFakePi({}, async ({ root }) => {
	const home = join(root, "home");
	const repository = join(root, "business-repository");
	const nestedCwd = join(repository, "packages/frontend");
	const userSkills = join(home, ".claude/skills");
	const rootSkills = join(repository, ".claude/skills");
	const nestedSkills = join(nestedCwd, ".claude/skills");
	const capture = join(root, "claude-skills-capture.json");
	for (const skillRoot of [userSkills, rootSkills, nestedSkills]) {
		mkdirSync(join(skillRoot, "fixture"), { recursive: true });
		writeFileSync(join(skillRoot, "fixture/SKILL.md"), "---\nname: fixture\ndescription: Claude Code compatibility fixture.\n---\n");
	}
	mkdirSync(join(repository, ".git"), { recursive: true });

	try {
		execFileSync(LAUNCHER, ["--print", "claude skills"], {
			cwd: nestedCwd,
			env: {
				...process.env,
				HOME: home,
				PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
				ROTOM_NODE: process.execPath,
				ROTOM_TEST_CAPTURE: capture,
			},
		});
		const invocation = JSON.parse(readFileSync(capture, "utf8"));
		const skillPaths = invocation.argv.flatMap((argument, index, argv) => argument === "--skill" ? [argv[index + 1]] : []);
		assert.deepEqual(skillPaths.slice(-3), [userSkills, realpathSync(rootSkills), realpathSync(nestedSkills)]);

		execFileSync(LAUNCHER, ["--no-approve", "--print", "user skills only"], {
			cwd: nestedCwd,
			env: {
				...process.env,
				HOME: home,
				PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
				ROTOM_NODE: process.execPath,
				ROTOM_TEST_CAPTURE: capture,
			},
		});
		const untrustedInvocation = JSON.parse(readFileSync(capture, "utf8"));
		const untrustedSkillPaths = untrustedInvocation.argv.flatMap((argument, index, argv) => argument === "--skill" ? [argv[index + 1]] : []);
		assert.equal(untrustedSkillPaths.includes(userSkills), true);
		assert.equal(untrustedSkillPaths.includes(realpathSync(rootSkills)), false);
		assert.equal(untrustedSkillPaths.includes(realpathSync(nestedSkills)), false);

		const noGitParentSkills = join(root, "no-git/.claude/skills");
		const noGitCwd = join(root, "no-git/child");
		mkdirSync(join(noGitParentSkills, "fixture"), { recursive: true });
		mkdirSync(noGitCwd, { recursive: true });
		writeFileSync(join(noGitParentSkills, "fixture/SKILL.md"), "---\nname: fixture\ndescription: Must not leak into a non-Git child.\n---\n");
		execFileSync(LAUNCHER, ["--print", "non-git boundary"], {
			cwd: noGitCwd,
			env: {
				...process.env,
				HOME: home,
				PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
				ROTOM_NODE: process.execPath,
				ROTOM_TEST_CAPTURE: capture,
			},
		});
		const noGitInvocation = JSON.parse(readFileSync(capture, "utf8"));
		assert.equal(noGitInvocation.argv.includes(realpathSync(noGitParentSkills)), false);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
}));

test("launcher 默认低版本 Node 拒绝，ROTOM_NODE 选择的 Node 同时运行 verifier 与 Pi", () => withFakePi({}, async ({ root }) => {
	installRejectingLowNode(root);
	const businessCwd = mkdtempSync(join(tmpdir(), "rotom-node-override-"));
	const capture = join(root, "node-override-capture.json");
	try {
		const isolatedHome = join(root, "node-test-home");
		mkdirSync(isolatedHome, { recursive: true });
		const defaultEnv = { ...process.env, HOME: isolatedHome, PATH: `${join(root, "bin")}:/usr/bin:/bin`, ROTOM_TEST_CAPTURE: capture };
		delete defaultEnv.ROTOM_NODE;
		const rejected = spawnSync(LAUNCHER, ["--version"], { cwd: businessCwd, encoding: "utf8", env: defaultEnv });
		assert.notEqual(rejected.status, 0);
		assert.match(rejected.stderr, /Node runtime 22\.23\.1.*要求 >=23\.6\.0/);

		execFileSync(LAUNCHER, ["--print", "node override", "--", "tail"], {
			cwd: businessCwd,
			env: { ...defaultEnv, ROTOM_NODE: process.execPath },
		});
		const invocation = JSON.parse(readFileSync(capture, "utf8"));
		assert.equal(invocation.cwd, realpathSync(businessCwd));
		assert.equal(invocation.nodeExecutable, realpathSync(process.execPath));
		assert.equal(invocation.nodeVersion, process.versions.node);
		assert.equal(invocation.verifiedPiExecutable, realpathSync(join(root, "bin/pi")));
		assert.deepEqual(invocation.argv.slice(-4), ["--print", "node override", "--", "tail"]);
	} finally {
		rmSync(businessCwd, { recursive: true, force: true });
	}
}));

test("launcher 拒绝空或非法 Subagent session spawn limit", () => withFakePi({}, async ({ root }) => {
	for (const limit of ["", "invalid", "-1", "1.5"]) {
		const result = spawnSync(LAUNCHER, ["--version"], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, ROTOM_NODE: process.execPath, PI_SUBAGENT_MAX_SPAWNS_PER_SESSION: limit },
		});
		assert.equal(result.status, 2, JSON.stringify(limit));
		assert.match(result.stderr, /PI_SUBAGENT_MAX_SPAWNS_PER_SESSION 必须是非负整数/u);
	}
}));

test("launcher 拒绝非绝对、不存在或夹带参数的 ROTOM_NODE", () => withFakePi({}, async ({ root }) => {
	for (const nodeOverride of ["node", "/definitely/missing/rotom-node", `${process.execPath} --version`]) {
		const result = spawnSync(LAUNCHER, ["--version"], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, ROTOM_NODE: nodeOverride },
		});
		assert.equal(result.status, 2, nodeOverride);
		assert.match(result.stderr, /ROTOM_NODE 必须是绝对|Node 路径不存在/);
	}
}));

test("launcher 拒绝非绝对、不存在或夹带参数的 ROTOM_PI", () => withFakePi({}, async ({ root }) => {
	for (const piOverride of ["pi", "/definitely/missing/rotom-pi", `${join(root, "bin/pi")} --version`]) {
		const result = spawnSync(LAUNCHER, ["--version"], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
				ROTOM_NODE: process.execPath,
				ROTOM_PI: piOverride,
			},
		});
		assert.equal(result.status, 2, piOverride);
		assert.match(result.stderr, /ROTOM_PI 必须是绝对|Pi 路径不存在/);
	}
}));

test("launcher 拒绝覆盖或追加 extension/skill 资源参数", () => withFakePi({}, async ({ root }) => {
	for (const args of [
		["--extension", "/tmp/other.ts"],
		["-e", "/tmp/other.ts"],
		["--extension=/tmp/other.ts"],
		["--no-extensions"],
		["-ne"],
		["--skill", "/tmp/other-skill"],
		["--skill=/tmp/other-skill"],
		["--no-skills"],
		["-ns"],
		["--prompt-template", "/tmp/other-prompt"],
		["--prompt-template=/tmp/other-prompt"],
		["--no-prompt-templates"],
		["-np"],
	]) {
		const result = spawnSync(LAUNCHER, [...args], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, ROTOM_NODE: process.execPath },
		});
		assert.equal(result.status, 2, args.join(" "));
		assert.match(result.stderr, /不允许覆盖或追加 extension\/skill/);
	}
}));

test("launcher 默认选择 scoped execution store，并对 opt-out、非法值和身份漂移 fail closed", () => withFakePi({}, async ({ root }) => {
	const home = join(root, "home");
	const store = join(home, ".local/state/rotom/subagent-store");
	const marker = join(store, ".owned-process-groups-v2.json");
	const base = { ...process.env, HOME: home, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, ROTOM_NODE: process.execPath };
	delete base.PI_SUBAGENTS_EXECUTION_SCOPE;
	delete base.PI_SUBAGENTS_TEMP_ROOT;

	// A read-only identity probe must not create runtime state.
	const probe = spawnSync(LAUNCHER, ["--version"], { encoding: "utf8", env: base });
	assert.equal(probe.status, 0, probe.stderr);
	assert.equal(existsSync(store), false);

	const defaultCapture = join(root, "scope-default-capture.json");
	execFileSync(LAUNCHER, ["--print"], { env: { ...base, ROTOM_TEST_CAPTURE: defaultCapture } });
	const defaults = JSON.parse(readFileSync(defaultCapture, "utf8"));
	assert.equal(defaults.executionScope, "owned-process-groups-v2");
	assert.equal(defaults.subagentTempRoot, store);
	const created = JSON.parse(readFileSync(marker, "utf8"));
	assert.equal(created.version, 3);
	assert.equal(created.scope, "owned-process-groups-v2");

	// Startup is idempotent: an existing anchor is reused, never replaced.
	const reuseCapture = join(root, "scope-reuse-capture.json");
	execFileSync(LAUNCHER, ["--print"], { env: { ...base, ROTOM_TEST_CAPTURE: reuseCapture } });
	assert.equal(JSON.parse(readFileSync(reuseCapture, "utf8")).subagentTempRoot, store);
	assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), created);

	// Explicit empty selects the legacy scope without creating or touching a store.
	const optOutHome = join(root, "opt-out-home");
	mkdirSync(optOutHome, { recursive: true });
	const optOutCapture = join(root, "scope-opt-out-capture.json");
	execFileSync(LAUNCHER, ["--print"], { env: { ...base, HOME: optOutHome, PI_SUBAGENTS_EXECUTION_SCOPE: "", ROTOM_TEST_CAPTURE: optOutCapture } });
	const optOut = JSON.parse(readFileSync(optOutCapture, "utf8"));
	assert.equal(optOut.executionScope, "");
	assert.equal(optOut.subagentTempRoot, undefined);
	assert.equal(existsSync(join(optOutHome, ".local/state/rotom/subagent-store")), false);

	// An explicit base is honored, but only as an absolute path.
	const explicitBase = join(root, "explicit-store");
	const explicitCapture = join(root, "scope-explicit-capture.json");
	execFileSync(LAUNCHER, ["--print"], { env: { ...base, PI_SUBAGENTS_TEMP_ROOT: explicitBase, ROTOM_TEST_CAPTURE: explicitCapture } });
	assert.equal(JSON.parse(readFileSync(explicitCapture, "utf8")).subagentTempRoot, explicitBase);
	assert.equal(JSON.parse(readFileSync(join(explicitBase, ".owned-process-groups-v2.json"), "utf8")).version, 3);

	const rejectedCapture = join(root, "scope-rejected-capture.json");
	for (const [label, environment, status, pattern] of [
		["未来 scope", { PI_SUBAGENTS_EXECUTION_SCOPE: "owned-process-groups-v3" }, 2, /不支持的 PI_SUBAGENTS_EXECUTION_SCOPE/u],
		["空白 scope", { PI_SUBAGENTS_EXECUTION_SCOPE: " " }, 2, /不支持的 PI_SUBAGENTS_EXECUTION_SCOPE/u],
		["相对 store", { PI_SUBAGENTS_TEMP_ROOT: "relative-store" }, 2, /必须是绝对目录路径/u],
		["空 store", { PI_SUBAGENTS_TEMP_ROOT: "" }, 2, /必须是绝对目录路径/u],
		["缺少 HOME", { HOME: "" }, 2, /需要 HOME/u],
	]) {
		const result = spawnSync(LAUNCHER, ["--print"], { encoding: "utf8", env: { ...base, ...environment, ROTOM_TEST_CAPTURE: rejectedCapture } });
		assert.equal(result.status, status, `${label}: ${result.stderr}`);
		assert.match(result.stderr, pattern, label);
		assert.equal(existsSync(rejectedCapture), false, `${label} must fail before Pi starts`);
	}

	// Drifted, foreign or unreadable store identity aborts startup; it is never rebuilt.
	// The anchor itself defines the store id, so only path/inode/parse drift is detectable here.
	for (const contents of [JSON.stringify({ ...created, root: join(store, "other") }), JSON.stringify({ ...created, inode: "1" }), JSON.stringify({ ...created, sessionRoot: join(store, "sessions-copy") }), "{ not json"]) {
		writeFileSync(marker, contents);
		const drift = spawnSync(LAUNCHER, ["--print"], { encoding: "utf8", env: { ...base, ROTOM_TEST_CAPTURE: rejectedCapture } });
		assert.equal(drift.status, 1, drift.stderr);
		assert.match(drift.stderr, /scoped execution store 不可用/u);
		assert.equal(existsSync(rejectedCapture), false);
		assert.equal(readFileSync(marker, "utf8"), contents, "a refused startup must not rewrite the anchor");
	}
}));
