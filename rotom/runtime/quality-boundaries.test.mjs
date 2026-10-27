import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createBashTool } from "./pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

// Independent consumer expectations: do not import the implementation's strip
// list, which would let an accidentally removed key disappear from both sides.
const internalKeys = [
	"PI_SUBAGENTS_EXECUTION_SCOPE", "PI_SUBAGENTS_TEMP_ROOT", "PI_SUBAGENT_MAX_SPAWNS_PER_SESSION",
	"ROTOM_VERIFIED_PI_EXECUTABLE", "ROTOM_VERIFIED_PI_VERSION", "ROTOM_DEFERRED_DEFAULT_SURFACE",
	"ROTOM_SUBAGENT_QODER_EXTENSION", "ROTOM_PRODUCT_VERSION",
];

for (const headless of ["0", "1"]) test(`installed bash strips internals but preserves public policy (${headless})`, async t => {
	const fixture = Object.fromEntries(internalKeys.map(key => [key, "internal-fixture"]));
	Object.assign(fixture, { PI_COMPUTER_USE_HEADLESS: headless, ROTOM_QUALITY_USER_VALUE: "keep" });
	const saved = Object.fromEntries(Object.keys(fixture).map(key => [key, process.env[key]]));
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	Object.assign(process.env, fixture);
	const keys = Object.keys(fixture);
	const script = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]))))`;
	const command = `${JSON.stringify(process.execPath)} -e '${script}'`;
	const hookEnv = { ...process.env };
	for (const options of [undefined, { spawnHook: () => ({ command, cwd: process.cwd(), env: hookEnv }) }]) {
		const result = await createBashTool(process.cwd(), options).execute("quality-env", { command });
		const output = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
		assert.deepEqual(JSON.parse(output), { PI_COMPUTER_USE_HEADLESS: headless, ROTOM_QUALITY_USER_VALUE: "keep" });
		for (const [key, value] of Object.entries(fixture)) {
			assert.equal(process.env[key], value, `host environment changed: ${key}`);
			assert.equal(hookEnv[key], value, `caller environment changed: ${key}`);
		}
	}
});

// A real interactive launcher, not a mocked ctx.hasUI. Python's stdlib PTY keeps
// stdin/stdout on a terminal while stderr is captured separately. No model call.
// A clean HOME may need Computer Use permissions. Cancel its observed prompt;
// this startup/stderr gate must neither grant OS permissions nor require them.
const ptyDriver = `
import errno, fcntl, json, os, selectors, struct, subprocess, sys, termios, time
ready_path = sys.argv[1]
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
process = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=subprocess.PIPE)
os.close(slave)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ, 'screen')
selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
buffers = {'screen': bytearray(), 'stderr': bytearray()}
start = time.monotonic()
ready_at = None
sent_exit = False
permission_prompt_cancelled = False
try:
    while selector.get_map():
        now = time.monotonic()
        if now - start > 30:
            raise RuntimeError('interactive startup/exit deadline; screen tail=' + buffers['screen'][-2000:].decode(errors='replace'))
        if ready_at is None and os.path.exists(ready_path):
            ready_at = now
        if ready_at is not None and now - ready_at > 1 and not sent_exit:
            os.write(master, b'\\x04')
            sent_exit = True
        for key, _ in selector.select(0.1):
            try:
                data = os.read(key.fd, 65536)
            except OSError as error:
                if key.fd != master or error.errno != errno.EIO:
                    raise
                data = b''
            if not data:
                selector.unregister(key.fileobj)
            else:
                buffers[key.data].extend(data)
                if key.data == 'screen' and ready_at is None and not permission_prompt_cancelled:
                    if b'Recheck (restarts helper)' in buffers['screen'] and b'Cancel' in buffers['screen']:
                        os.write(master, b'\\x1b')
                        permission_prompt_cancelled = True
                if len(buffers[key.data]) > 2 * 1024 * 1024:
                    raise RuntimeError('interactive output exceeded fixture limit')
    status = process.wait(timeout=5)
    with open(ready_path) as stream:
        ready = json.load(stream)
    print(json.dumps({'status': status, 'ready': ready, 'permissionPromptCancelled': permission_prompt_cancelled, **{key:value.decode(errors='replace') for key,value in buffers.items()}}))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    selector.close()
    process.stderr.close()
    os.close(master)
`;

for (const missing of [false, true]) test(`real TUI startup keeps stderr clean (missing prerequisite: ${missing})`, {
	skip: process.platform === "win32", timeout: 45_000,
}, t => {
	const workspace = mkdtempSync(join(tmpdir(), "rotom-quality-pty-"));
	t.after(() => rmSync(workspace, { recursive: true, force: true }));
	const home = join(workspace, "home");
	mkdirSync(home);
	const ready = join(workspace, "ready.json");
	const fixture = join(workspace, "fixture.ts");
	const registerPath = resolve(import.meta.dirname, "../extensions/third-party/deferred-tools/register.ts");
	writeFileSync(fixture, `
		import { writeFileSync } from 'node:fs';
		import { registerDeferredTools } from ${JSON.stringify(registerPath)};
		export default function(pi) {
			if (${missing}) registerDeferredTools(new Proxy(pi, { get(target, key) {
				if (key === 'registerTool') return () => {};
				if (key === 'getAllTools') return () => target.getAllTools().filter(tool => tool.name !== 'subagent');
				const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
			} }), { ROTOM_DEFERRED_TOOLS: '1', ROTOM_DEFERRED_DEFAULT_SURFACE: '1' });
			pi.on('session_start', (_event, ctx) => writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ hasUI: ctx.hasUI })));
		}
	`);
	const result = spawnSync("python3", ["-c", ptyDriver, ready, resolve(import.meta.dirname, "../bin/rotom"),
		"--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", fixture], {
		cwd: workspace, encoding: "utf8", timeout: 40_000, maxBuffer: 5 * 1024 * 1024,
		env: { PATH: process.env.PATH, HOME: home, TERM: "xterm-256color", PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
			ROTOM_NODE: process.execPath, ROTOM_QODER: "0", ROTOM_OBSERVABILITY: "0", PI_COMPUTER_USE_HEADLESS: "1" },
	});
	assert.equal(result.status, 0, result.error?.message ?? result.stderr);
	const observed = JSON.parse(result.stdout);
	assert.equal(observed.status, 0, observed.stderr);
	assert.equal(observed.ready.hasUI, true);
	if (observed.screen.includes("Recheck (restarts helper)")) assert.equal(observed.permissionPromptCancelled, true);
	assert.equal(observed.stderr, "", "startup diagnostics must use the TUI renderer");
	if (missing) assert.match(observed.screen, /Deferred tool loading skipped; required tools unavailable: subagent/u);
	else assert.doesNotMatch(observed.screen, /Deferred tool loading skipped/u);
});
