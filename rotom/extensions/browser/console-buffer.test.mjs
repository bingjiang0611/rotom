import assert from "node:assert/strict";
import test from "node:test";
import {
	CONSOLE_LEVELS_V1,
	MAX_CONSOLE_ENTRIES_V1,
	MAX_CONSOLE_ENTRY_BYTES_V1,
	MAX_CONSOLE_STACK_FRAMES_V1,
	consoleEntryV1,
	consoleLevelFromTypeV1,
	createConsoleCaptureV1,
	parseConsoleCursorV1,
	sanitizeConsoleLevelV1,
	sanitizeConsoleLimitV1,
	sanitizeConsolePatternV1,
} from "./chrome-extension/console-buffer.js";

const entry = (overrides = {}) => ({ level: "info", text: "hello", url: "https://example.test/a", lineNumber: 3, at: 1_700_000_000_000, ...overrides });

test("console：CDP 类型映射到四个级别，未知类型按 info", () => {
	assert.deepEqual(CONSOLE_LEVELS_V1, ["verbose", "info", "warning", "error"]);
	assert.equal(consoleLevelFromTypeV1("debug"), "verbose");
	assert.equal(consoleLevelFromTypeV1("error"), "error");
	assert.equal(consoleLevelFromTypeV1("assert"), "error");
	assert.equal(consoleLevelFromTypeV1("warning"), "warning");
	assert.equal(consoleLevelFromTypeV1("log"), "info");
	assert.equal(consoleLevelFromTypeV1("something-new"), "info");
	assert.equal(consoleLevelFromTypeV1(undefined), "info");
});

test("console：单条超过 2 KB 时按码点截断，堆栈最多 10 帧", () => {
	const long = "错误".repeat(2_000);
	const stored = consoleEntryV1(entry({ text: long, stack: Array.from({ length: 30 }, (_, index) => `at frame ${index}`) }));
	const size = Buffer.byteLength(JSON.stringify(stored), "utf8");
	assert.ok(size <= MAX_CONSOLE_ENTRY_BYTES_V1, `条目必须 ≤2 KB：${size}`);
	// Truncation never splits a multi-byte character.
	assert.equal(stored.text.endsWith("…"), true);
	assert.equal([...stored.text].some((character) => character === "\uFFFD"), false);

	// A short message keeps the full 10-frame stack an exception needs.
	const withStack = consoleEntryV1(entry({ text: "Uncaught TypeError: boom", stack: Array.from({ length: 30 }, (_, index) => `at frame ${index}`) }));
	assert.equal(withStack.stack.length, MAX_CONSOLE_STACK_FRAMES_V1);
	assert.ok(Buffer.byteLength(JSON.stringify(withStack), "utf8") <= MAX_CONSOLE_ENTRY_BYTES_V1);
	// When both cannot fit, the top frames go last.
	const squeezed = consoleEntryV1(entry({ text: "x".repeat(1_500), stack: Array.from({ length: 30 }, (_, index) => `at ${"f".repeat(200)} ${index}`) }));
	assert.ok(Buffer.byteLength(JSON.stringify(squeezed), "utf8") <= MAX_CONSOLE_ENTRY_BYTES_V1);
	assert.ok((squeezed.stack?.length ?? 0) >= 3 || squeezed.text.length > 0);
});

test("console：2 KB 装不下堆栈时先丢堆栈，保留正文", () => {
	const stored = consoleEntryV1(entry({ text: "boom", stack: ["at " + "x".repeat(600), "at " + "y".repeat(600), "at " + "z".repeat(600), "at w"] }));
	assert.ok(Buffer.byteLength(JSON.stringify(stored), "utf8") <= MAX_CONSOLE_ENTRY_BYTES_V1);
	assert.equal(stored.text, "boom");
});

test("console：环形缓冲 500 条、丢最旧并计数", () => {
	const capture = createConsoleCaptureV1();
	for (let index = 1; index <= 510; index += 1) capture.append(1, entry({ text: `line ${index}` }));
	const page = capture.read(1, { limit: 200 });
	assert.equal(page.retained, MAX_CONSOLE_ENTRIES_V1);
	assert.equal(page.dropped, 10);
	assert.equal(page.entries.length, 200);
	assert.equal(page.entries[0].text, "line 11", "最旧的 10 条先被丢掉");
	assert.equal(page.nextCursor, `c${page.entries.at(-1).seq}`);
	const rest = capture.read(1, { sinceCursor: parseConsoleCursorV1(page.nextCursor), limit: 200 });
	assert.equal(rest.entries[0].text, "line 211");
});

test("console：cursor 过滤、level 过滤与大小写不敏感的子串匹配", () => {
	const capture = createConsoleCaptureV1();
	capture.append(7, entry({ level: "error", text: "Uncaught TypeError: boom" }));
	capture.append(7, entry({ level: "info", text: "hello world" }));
	capture.append(7, entry({ level: "warning", text: "Deprecation: old API" }));
	assert.deepEqual(capture.read(7, { level: "error" }).entries.map((item) => item.text), ["Uncaught TypeError: boom"]);
	assert.deepEqual(capture.read(7, { pattern: "WORLD" }).entries.map((item) => item.text), ["hello world"]);
	assert.deepEqual(capture.read(7, { pattern: "deprecat" }).entries.map((item) => item.level), ["warning"]);
	assert.deepEqual(capture.read(7, { pattern: ".*" }).entries, [], "pattern 是子串，不是正则");
	// A dropped cursor still continues from what is retained instead of replaying.
	const all = capture.read(7, {});
	assert.deepEqual(capture.read(7, { sinceCursor: 0 }).entries.length, 3);
	assert.deepEqual(capture.read(7, { sinceCursor: parseConsoleCursorV1(`c${all.entries[1].seq}`) }).entries.map((item) => item.level), ["warning"]);
});

test("console：全局 8 MB 上限按字节淘汰，最占空间的 tab 先丢", () => {
	const capture = createConsoleCaptureV1({ maxTotalBytes: 6_000, maxEntryBytes: 1_000, maxEntries: 100 });
	for (let index = 0; index < 5; index += 1) capture.append(1, entry({ text: `${index}:${"a".repeat(900)}` }));
	assert.ok(capture.stats().totalBytes <= 6_000);
	for (let index = 0; index < 5; index += 1) capture.append(2, entry({ text: `${index}:${"b".repeat(900)}` }));
	const stats = capture.stats();
	assert.ok(stats.totalBytes <= 6_000, `总量必须受限：${stats.totalBytes}`);
	assert.equal(stats.tabs, 2);
	assert.ok(capture.read(1, { limit: 100 }).dropped > 0, "被全局预算淘汰的 tab 必须记录 dropped");
});

test("console：每个 tab 独立，reset 只清一个 tab 并释放字节数", () => {
	const capture = createConsoleCaptureV1();
	capture.append(1, entry({ text: "tab one" }));
	capture.append(2, entry({ text: "tab two" }));
	assert.deepEqual(capture.read(1, {}).entries.map((item) => item.text), ["tab one"]);
	assert.deepEqual(capture.read(2, {}).entries.map((item) => item.text), ["tab two"]);
	const before = capture.stats().totalBytes;
	capture.reset(1);
	assert.deepEqual(capture.read(1, {}).entries, [], "reset 后按新文档重新开始");
	assert.ok(capture.stats().totalBytes < before);
	assert.deepEqual(capture.read(2, {}).entries.map((item) => item.text), ["tab two"]);
});

test("console：captureSince 反映缓冲区创建时间，重启后是新的时间", () => {
	const first = createConsoleCaptureV1();
	first.append(1, entry());
	const firstSince = first.read(1, {}).captureSince;
	assert.ok(Number.isFinite(firstSince) && firstSince > 0);
	const restarted = createConsoleCaptureV1();
	assert.deepEqual(restarted.read(1, {}).entries, [], "SW 重启后没有旧条目");
	assert.ok(restarted.read(1, {}).captureSince >= firstSince, "captureSince 不得早于重启时间");
});

test("console：参数校验拒绝非法 level/pattern/limit/cursor", () => {
	assert.equal(sanitizeConsoleLevelV1("error"), "error");
	assert.equal(sanitizeConsoleLevelV1("debug"), undefined);
	assert.equal(sanitizeConsoleLevelV1(""), undefined);
	assert.equal(sanitizeConsolePatternV1("boom"), "boom");
	assert.equal(sanitizeConsolePatternV1(""), undefined);
	assert.equal(sanitizeConsolePatternV1("x".repeat(129)), undefined);
	assert.equal(sanitizeConsoleLimitV1(undefined), 50);
	assert.equal(sanitizeConsoleLimitV1(1), 1);
	assert.equal(sanitizeConsoleLimitV1(0), undefined);
	assert.equal(sanitizeConsoleLimitV1(201), undefined);
	assert.equal(parseConsoleCursorV1(undefined), 0);
	assert.equal(parseConsoleCursorV1("c42"), 42);
	for (const invalid of ["42", "c", "c-1", "c1x", "c9999999999999", 42]) assert.equal(parseConsoleCursorV1(invalid), undefined, String(invalid));
});
