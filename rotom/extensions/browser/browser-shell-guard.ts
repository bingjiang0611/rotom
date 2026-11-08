export const BROWSER_FOREGROUND_LAUNCH_REASON = "检测到通过 shell 在前台打开浏览器或 URL。浏览器任务必须使用 browser_inspect/browser_interact 通过 Chrome relay 在后台完成。Relay 明确不可用时仅允许受控 launch_browser，不允许 shell 启动。";
export const DESKTOP_INPUT_CAPTURE_REASON = "检测到系统级鼠标/键盘或桌面截图回退。浏览器任务必须使用 browser_inspect/browser_interact 的 ref、坐标与 screenshot 能力完成。若 relay 无法完成，请直接报告具体限制，不要回退到桌面 GUI 自动化。";
export const HEREDOC_HEADER_PATTERN = /(^|[\n;&|])([^\n]*?)<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))[^\n]*\n/u;
export const SHELL_INTERPRETER_PATTERN = /(?:^|[\s/])(?:ba|z|k|da)?sh\b/iu;
export const BROWSER_APPLICATION_PATTERN = /google\s*chrome|com\.google\.chrome|chromium|safari|com\.apple\.safari(?:technologypreview)?|microsoft\s*edge|com\.microsoft\.edgemac|firefox|org\.mozilla\.firefox|brave|com\.brave\.browser|company\.thebrowser\.[a-z]+|\barc\.app\b|opera|vivaldi/iu;
export const URL_TARGET_PATTERN = /https?:\/\//iu;
// Heredoc bodies are data for the receiving program, not shell commands, so Python/Node source
// such as `open('/tmp/x','wb')` must never count as a macOS `open` invocation. Bodies fed to a
// shell interpreter stay in the surface because that shell really does execute them.
export function shellSurface(command: string): string {
	let remaining = command;
	let surface = "";
	for (;;) {
		const header = HEREDOC_HEADER_PATTERN.exec(remaining);
		if (!header)
			return surface + remaining;
		const headerEnd = header.index + header[0].length;
		const delimiter = header[3] ?? header[4] ?? header[5] ?? "";
		const body = remaining.slice(headerEnd);
		const terminator = new RegExp(`^[ \\t]*${delimiter}[ \\t]*$`, "mu").exec(body);
		const bodyEnd = terminator ? terminator.index + terminator[0].length : body.length;
		const executesShellBody = SHELL_INTERPRETER_PATTERN.test(header[2] ?? "");
		surface += remaining.slice(0, headerEnd) + (executesShellBody ? body.slice(0, bodyEnd) : "\n");
		remaining = body.slice(bodyEnd);
	}
}
export function invokes(command: string, executable: string): boolean {
	const escaped = executable.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(`(?:^|[\\n;&|])\\s*(?:/usr/bin/)?${escaped}\\b(?!\\s*\\()`, "iu").test(command);
}
// A blocked `open` must be judged by its own invocation, not by unrelated URLs elsewhere in the
// script: today a local WebDriverAgent curl plus a Python heredoc was misread as a Chrome launch.
export function openInvocationTargets(surface: string): string[] {
	const targets: string[] = [];
	const pattern = /(?:^|[\n;&|])\s*(?:\/usr\/bin\/)?open\b(?!\s*\()([^\n;&|]*)/giu;
	for (const match of surface.matchAll(pattern))
		targets.push(match[1] ?? "");
	return targets;
}
export function foregroundBrowserFallbackReason(command: string, browserRouteActive: boolean): string | undefined {
	const surface = shellSurface(command);
	for (const target of openInvocationTargets(surface)) {
		if (BROWSER_APPLICATION_PATTERN.test(target) || URL_TARGET_PATTERN.test(target))
			return BROWSER_FOREGROUND_LAUNCH_REASON;
	}
	if (invokes(surface, "osascript")) {
		if (BROWSER_APPLICATION_PATTERN.test(command))
			return BROWSER_FOREGROUND_LAUNCH_REASON;
		if (browserRouteActive && /System Events/iu.test(command) && /\b(?:activate|click|keystroke|key code|frontmost)\b/iu.test(command))
			return DESKTOP_INPUT_CAPTURE_REASON;
	}
	if (browserRouteActive && (invokes(surface, "screencapture") || invokes(surface, "cliclick")))
		return DESKTOP_INPUT_CAPTURE_REASON;
	return undefined;
}
