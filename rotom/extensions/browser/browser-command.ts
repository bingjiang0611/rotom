import { fileURLToPath } from "node:url";
import { type BrowserCommandDependenciesV1 } from "./browser-dependencies.ts";
import { homedir } from "node:os";
import { browserRelaySocketPathV1, BrowserRelayClientV1, BROWSER_INSPECT_TOOL_V1, BrowserRelayUnavailableErrorV1 } from "./browser-relay.ts";
import { lstat, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { record } from "./tool-results.ts";
import { browserIdsV1 } from "./platform-paths.mjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserRuntimeV1 } from "./browser-runtime.ts";
export const BROWSER_INSTALLER = fileURLToPath(new URL("./install-chrome-relay.mjs", import.meta.url));
export const BROWSER_COMMANDS = [
	{ value: "install", label: "安装 / 更新 Chrome Relay", description: "确认后注册 native host，扩展仍需手动加载" },
	{ value: "status", label: "查看状态", description: "只读检查注册与连接，不调用模型或读取页面" },
] as const;
export function defaultCommandDependenciesV1(): BrowserCommandDependenciesV1 {
	// Freeze the diagnostic/install coordinates before any asynchronous UI or I/O.
	const home = homedir();
	const socketPath = browserRelaySocketPathV1();
	return {
		platform: process.platform,
		async runInstaller(operation, signal, browser) {
			// Fixed product-owned script and canonical current Node; never resolve a command
			// from cwd/PATH or forward credentials/NODE_OPTIONS into this maintenance child.
			for (const path of [BROWSER_INSTALLER, process.execPath]) {
				const info = await lstat(path);
				if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path)
					throw new Error("Untrusted browser installer resource");
			}
			signal.throwIfAborted();
			const stdout = await new Promise<string>((resolve, reject) => {
				execFile(process.execPath, [BROWSER_INSTALLER, operation, ...(browser === undefined ? [] : ["--browser", browser])], {
					env: { HOME: home }, signal, timeout: 10000, maxBuffer: 16 * 1024, encoding: "utf8",
				}, (error, stdout) => error ? reject(error) : resolve(stdout));
			});
			return JSON.parse(stdout);
		},
		async probeRelay(signal) {
			signal.throwIfAborted();
			// A disposable diagnostic identity must not replace/close the live session's
			// generation, read its tabs, or grant its agent loop fallback permission.
			const diagnostic = await BrowserRelayClientV1.connect({ sessionId: `browser-status-${randomUUID()}`, socketPath, timeoutMs: 2500 });
			try {
				signal.throwIfAborted();
			}
			finally {
				diagnostic.close();
			}
		},
	};
}
export function registerBrowserCommandV1(pi: ExtensionAPI, runtime: BrowserRuntimeV1, dependencies: Partial<BrowserCommandDependenciesV1> = {}) {
	const commandIO = { ...defaultCommandDependenciesV1(), ...dependencies };
	// Chrome loads from one stable, content-independent directory. Derive its display
	// from our own frozen HOME, never from child output, so no path can be injected.
	const extensionDir = join(homedir(), "Library", "Application Support", "rotom", "browser-relay", "current", "chrome-extension");
	const extensionDirDisplay = JSON.stringify(extensionDir);
	const flag = (result: unknown, name: string) => record(result) && result[name] === true;
	pi.registerCommand("browser", {
		description: "手动使用浏览器；install 安装连接程序，status 查看状态",
		getArgumentCompletions(prefix) {
			if (/\s/u.test(prefix))
				return null;
			const matches = BROWSER_COMMANDS.filter((item) => item.value.startsWith(prefix));
			return matches.length ? matches.map(({ value, description }) => ({ value, label: value, description })) : null;
		},
		async handler(args, ctx) {
			if (!ctx.hasUI)
				throw new Error("/browser 需要交互界面；未执行任何安装或浏览器操作");
			if (runtime.activeCommand) {
				ctx.ui.notify("上一条 /browser 尚未结束，请等待；不要重复安装。", "warning");
				return;
			}
			const ownerSession = ctx.sessionManager.getSessionId();
			const controller = new AbortController();
			runtime.activeCommand = controller;
			const ownerEpoch = runtime.epoch;
			const owns = () => !runtime.shutdown && !controller.signal.aborted && runtime.epoch === ownerEpoch && ctx.sessionManager.getSessionId() === ownerSession;
			const assertOwner = () => { if (!owns())
				throw new Error("Browser command owner retired"); };
			let operation = "use";
			let installDispatched = false;
			try {
				assertOwner();
				const input = args.trim();
				if (Buffer.byteLength(input, "utf8") > 4096 || input.includes("\0")) {
					ctx.ui.notify("/browser 参数过长或无效。", "warning");
					return;
				}
				// Only exact administrative commands are reserved; preserve the entire task.
				// `install [--browser <id>]` stays an administrative command; every other input is
				// a browser task and is forwarded verbatim.
				operation = /^install(?:\s+--browser(?:=|\s+)[a-z-]+)?$/u.test(input) ? "install" : input === "status" ? "status" : "use";
				let task = operation === "use" ? input : "";
				if (operation === "use") {
					if (!ctx.isIdle()) {
						ctx.ui.notify("当前任务尚未结束，请空闲后再使用 /browser。", "warning");
						return;
					}
					if (!task)
						task = (await ctx.ui.input("浏览器任务（会调用当前模型）", "例如：打开 example.com，读取页面标题", { signal: controller.signal }))?.trim() ?? "";
					assertOwner();
					if (!task)
						return;
					if (Buffer.byteLength(task, "utf8") > 4096 || task.includes("\0")) {
						ctx.ui.notify("浏览器任务应在 4096 bytes 以内且不能包含 NUL。", "warning");
						return;
					}
					if (!ctx.isIdle()) {
						ctx.ui.notify("当前已有任务运行，未提交浏览器任务。", "warning");
						return;
					}
					if (!pi.getActiveTools().includes(BROWSER_INSPECT_TOOL_V1)) {
						ctx.ui.notify("当前工具选择未启用 browser_inspect；/browser 不会绕过工具排除或运行时策略。", "warning");
						return;
					}
					runtime.browserRouteActive = true;
					pi.sendUserMessage(`请使用 browser_inspect，以及当前可用的 browser_interact，完成以下浏览器任务。遵守现有观测绑定、权限范围与未知写入不重放规则；不要通过 shell 或桌面输入回退。\n\n用户任务：\n${task}`, { expandPromptTemplates: false });
					return;
				}
				const installBrowsers = browserIdsV1(commandIO.platform);
				if (installBrowsers.length === 0) {
					ctx.ui.notify(`当前平台（${commandIO.platform}）没有已验证的 Chrome Relay 安装路径；未执行安装或状态探测。`, "warning");
					return;
				}
				if (operation === "install") {
					if (!ctx.isIdle()) {
						ctx.ui.notify("请等待当前任务结束后再安装，避免影响正在使用的浏览器连接。", "warning");
						return;
					}
					// The browser is a command argument, not a second menu: `/browser install` keeps
					// its single confirmation, and without `--browser` the installer detects one.
					// An unsupported name is refused before the user is asked to confirm anything.
					const requested = /(?:^|\s)--browser(?:=|\s)([a-z-]+)/u.exec(args)?.[1];
					if (requested !== undefined && !installBrowsers.includes(requested)) {
						ctx.ui.notify(`不支持的浏览器：${requested}（可用：${installBrowsers.join("|")}）；未执行安装。`, "warning");
						return;
					}
					const browser = requested ?? installBrowsers[0];
					const accepted = await ctx.ui.confirm("注册 Chrome Relay？", "将浏览器组件写入一个固定目录（跨 rotom 发行版本不变），并更新同一用户共享的 Chrome native host 注册，影响其他 rotom 安装的后续连接。组件内容变化时会原子替换该目录；不会自动重载 Chrome 扩展或打断活跃标签。首次需手动加载该目录，此后升级只需在 chrome://extensions 点扩展刷新（↻）；请先结束活跃浏览器任务。", { signal: controller.signal });
					assertOwner();
					if (!accepted)
						return;
					// Which browser gets the native host is a user choice: registering into the
					// wrong Chromium family silently leaves the real browser disconnected.
					assertOwner();
					if (browser === undefined)
						return;
					if (!ctx.isIdle()) {
						ctx.ui.notify("当前已有任务运行，未执行安装。", "warning");
						return;
					}
					installDispatched = true;
					const result = await commandIO.runInstaller("install", controller.signal, browser);
					assertOwner();
					if (!record(result) || (result.status !== "installed" && result.status !== "manual-registration-required"))
						throw new Error("Invalid installer acknowledgement");
					if (result.status === "manual-registration-required") {
						// Windows registers in HKCU, which this product has not verified: hand the
						// exact command to the user instead of claiming the host is connected.
						ctx.ui.notify(`已写入 native host 文件，但 Windows 需要在你的终端执行一次注册命令（未在本环境实测）：\n${String(result.registryCommand ?? "")}`, "warning");
						return;
					}
					const first = flag(result, "firstInstall");
					const reloadNeeded = flag(result, "reloadNeeded");
					const hostOnly = flag(result, "hostOnlyUpdate");
					const check = await commandIO.runInstaller("status", controller.signal);
					assertOwner();
					if (!record(check) || check.installed !== true)
						throw new Error("Registration readback did not match");
					const next = first
						? `首次安装：在 chrome://extensions → 开发者模式 → 加载已解压的扩展，选择上面的目录（请先结束活跃浏览器任务）。此后升级只需按刷新，无需重新选目录。`
						: reloadNeeded
							? `浏览器扩展内容已更新。请到 chrome://extensions，点该扩展卡片的刷新按钮（↻）一次即可，无需 Remove 或重新选目录。`
							: hostOnly
								? `已更新 native host（下次浏览器连接自动生效）；扩展内容未变，无需在 Chrome 端点刷新。`
								: `组件无变化，无需在 Chrome 端做任何操作。`;
					ctx.ui.notify(`Native host 注册已回读确认。\n固定扩展目录：${extensionDirDisplay}\n${next}\n完成后用 /browser status 检查连接。`, "info");
					return;
				}
				let registration = "unknown（检查未完成）";
				let reloadHint = "";
				try {
					const result = await commandIO.runInstaller("status", controller.signal);
					assertOwner();
					if (!record(result) || typeof result.installed !== "boolean")
						throw new Error("Invalid installer status");
					if (result.installed === true) {
						registration = "与当前 rotom 匹配（组件已是最新）";
						reloadHint = "固定目录已是最新；若刚升级过扩展请点刷新（↻）一次。";
					}
					else if (flag(result, "registrationValid")) {
						registration = "已注册，但组件与当前 rotom 不一致";
						reloadHint = flag(result, "extensionUpToDate")
							? "扩展内容已是最新；运行 /browser install 更新 native host 即可，无需 ↻。"
							: "扩展内容有更新；运行 /browser install 后点扩展刷新（↻）一次。";
					}
					else {
						registration = "未确认匹配（首次安装、Node 变化、缺失、损坏或不可读）";
						reloadHint = "请运行 /browser install。";
					}
				}
				catch {
					assertOwner();
				}
				let connection = "unknown（超时、权限或协议检查未完成）";
				try {
					await commandIO.probeRelay(controller.signal);
					assertOwner();
					connection = "已连接（协议握手成功，未访问页面）";
				}
				catch (error) {
					assertOwner();
					if (error instanceof BrowserRelayUnavailableErrorV1)
						connection = "不可用（本机 relay socket 缺失或拒绝连接）";
				}
				ctx.ui.notify(`Native host：${registration}\nChrome Relay：${connection}\n固定扩展目录：${extensionDirDisplay}\n${reloadHint}\n注册匹配不等于连接可用，旧组件的 Relay 也可能在线。\n标签 debugger 身份失效是另一问题，不应通过重复安装或重放原动作解决。`, "info");
			}
			catch {
				// Never publish old-session UI, child stderr, paths from child output, or a
				// guessed success. An interrupted installer may already have written files.
				if (owns())
					ctx.ui.notify(installDispatched
						? "安装结果 unknown：可能已部分生效，未自动重试或回滚。请先 /browser status 只读核对注册。"
						: "浏览器命令未完成，状态 unknown；未自动重试。", "warning");
			}
			finally {
				if (runtime.activeCommand === controller)
					runtime.activeCommand = undefined;
			}
		},
	});
}
