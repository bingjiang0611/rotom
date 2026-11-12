// Keeps the root CLAUDE.md a short operating charter: it is loaded on every turn
// of every maintenance session, so domain detail lives in docs/agent/contracts/.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const charterPath = join(root, "CLAUDE.md");
const charter = readFileSync(charterPath, "utf8");

const MAX_CHARTER_BYTES = 15_000;
const CONTRACTS = [
	["pi-runtime.md", "# Pi 接入与维护合同"],
	["npm-release.md", "# npm 正式发布顺序"],
	["runtime-resources.md", "# 运行时资源合同"],
	["tool-surface.md", "# 工具面合同"],
	["local-execution.md", "# 本机执行与安全隔离合同"],
	["browser.md", "# Browser 合同"],
];

/** Relative Markdown link targets (no scheme, no bare anchors), without their #fragment. */
function relativeLinks(markdown) {
	const targets = [];
	for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
		const target = match[1];
		if (/^(?:[a-z]+:|#)/i.test(target)) continue;
		targets.push(target.split("#")[0]);
	}
	return targets;
}

test("CLAUDE.md stays within its byte budget", () => {
	const size = statSync(charterPath).size;
	assert.ok(size <= MAX_CHARTER_BYTES, `CLAUDE.md is ${size} bytes; keep it at or under ${MAX_CHARTER_BYTES} by moving detail into docs/agent/contracts/`);
});

test("CLAUDE.md does not pin component versions", () => {
	const pinned = charter.match(/\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/g) ?? [];
	assert.deepEqual(pinned, [], "versions belong in rotom/runtime/product-config.mjs and rotom/runtime/pi/fork-build.json");
});

test("every relative link in CLAUDE.md resolves", () => {
	for (const target of relativeLinks(charter)) {
		assert.ok(existsSync(join(root, target)), `CLAUDE.md links to missing ${target}`);
	}
});

test("each domain contract exists, keeps its heading, is linked from CLAUDE.md and links only to real files", () => {
	for (const [name, heading] of CONTRACTS) {
		const path = join(root, "docs/agent/contracts", name);
		assert.ok(existsSync(path), `missing contract ${name}`);
		const body = readFileSync(path, "utf8");
		assert.ok(body.startsWith(`${heading}\n`), `${name} must start with "${heading}"`);
		assert.match(body, /原样搬自根 `CLAUDE\.md`/, `${name} must state where its text came from`);
		assert.ok(charter.includes(`(docs/agent/contracts/${name})`), `CLAUDE.md must link to contracts/${name}`);
		for (const target of relativeLinks(body)) {
			assert.ok(existsSync(join(dirname(path), target)), `${name} links to missing ${target}`);
		}
	}
});
