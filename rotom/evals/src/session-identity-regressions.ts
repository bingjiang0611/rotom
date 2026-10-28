import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

// Derived from a real identity-confusion failure. All names, titles and IDs below
// are invented; these are not exports of a user's session or remote catalogue.
const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
export const distractorId = "00000000-0000-4000-8000-000000000099";
export const identityFixtureFiles: Record<string, string> = {
	"session-refs.json": JSON.stringify({ device: "local", refs: [
		{ canonicalId: "fixture-ref-alpha", nativeSessionId: firstId, project: "sample-project" },
		{ canonicalId: "fixture-ref-beta", nativeSessionId: secondId, project: "sample-project" },
	] }, null, 2),
	"native-sessions.json": JSON.stringify({ device: "local", sessions: [
		{ id: firstId, project: "sample-project", firstUserMessage: "列出可用的颜色主题" },
		{ id: secondId, project: "sample-project", firstUserMessage: "检查示例配置" },
	] }, null, 2),
	"process.json": JSON.stringify({ currentProcessSessionId: distractorId, device: "local", remoteCatalogueAvailable: false }, null, 2),
};

export type IdentityCase = {
	id: string;
	task: string;
	expectedStatus: "found" | "unknown" | "ambiguous";
	expectedSessionId: string | null;
};
export const identityCases: IdentityCase[] = [
	{ id: "local-exact", task: "查本机 sample-project 中，第一条用户消息恰好为‘列出可用的颜色主题’的会话。", expectedStatus: "found", expectedSessionId: firstId },
	{ id: "remote-unavailable", task: "查远端设备 remote-demo 上，sample-project 中标题为‘切到示例分支’的会话。当前只有本地快照，没有该远端目录。", expectedStatus: "unknown", expectedSessionId: null },
	{ id: "local-ambiguous", task: "查本机 sample-project 的会话。我没有指定时间、标题或第一条消息。", expectedStatus: "ambiguous", expectedSessionId: null },
];
export const identityOutputInstruction = `请给出目标会话的 Pi 原生 ID。依据仅限当前工作目录的 session-refs.json、native-sessions.json 和 process.json；可调用 read，不能连接设备。
只输出 JSON：{"status":"found|unknown|ambiguous","piSessionId":字符串或null,"evidenceFiles":[文件名],"reason":"简短理由"}。引用实际读取的依据；不要猜测缺失信息。`;

/** A native read must address one complete, unchanged fixture, never host data. */
export async function assertIdentityRead(workspace: string, toolName: string, input: Record<string, unknown>): Promise<string> {
	if (toolName !== "read" || typeof input.path !== "string" || (input.offset !== undefined && input.offset !== 1)) {
		throw new Error("Identity regression allows only complete fixture reads.");
	}
	const root = await realpath(workspace);
	const requested = resolve(workspace, input.path);
	// macOS may expose the harness cwd through /var while realpath uses /private/var.
	const name = Object.keys(identityFixtureFiles).find((file) => requested === join(workspace, file) || requested === join(root, file));
	if (!name) throw new Error("Read outside the identity fixture allowlist.");
	if (input.limit !== undefined && (typeof input.limit !== "number" || input.limit < identityFixtureFiles[name].split("\n").length)) {
		throw new Error("Identity regression requires the complete fixture, not a partial page.");
	}
	const path = join(root, name);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error("Fixture is not a canonical regular file.");
	if (await readFile(path, "utf8") !== identityFixtureFiles[name]) throw new Error("Identity fixture changed.");
	return name;
}

export type IdentityRead = { file: string; isError: boolean; content: string };
export type IdentityOutput = { response: string; stopReason: string; reads: IdentityRead[]; fixturesIntact: boolean; toolErrors: number };

export function scoreIdentity(item: IdentityCase, output: IdentityOutput): { score: number; checks: Record<string, boolean> } {
	let answer: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(output.response);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answer = parsed as Record<string, unknown>;
	} catch { /* Malformed model output is a failed contract, not an infrastructure error. */ }
	const cited = Array.isArray(answer.evidenceFiles) ? answer.evidenceFiles : [];
	// Failed/blocked reads are diagnostics, not evidence. A later successful
	// full read can recover this read-only task; toolErrors stays visible.
	const completed = output.reads.filter((read) => !read.isError && read.content === identityFixtureFiles[read.file]).map((read) => read.file);
	const checks = {
		terminal: output.stopReason === "stop",
		fixturesIntact: output.fixturesIntact,
		status: answer.status === item.expectedStatus,
		identity: answer.piSessionId === item.expectedSessionId,
		reason: typeof answer.reason === "string" && answer.reason.trim().length > 0,
		evidence: ["session-refs.json", "native-sessions.json"].every((file) => cited.includes(file) && completed.includes(file)),
		citations: cited.length > 0 && cited.every((file) => typeof file === "string" && Object.hasOwn(identityFixtureFiles, file) && completed.includes(file)),
	};
	return { score: Object.values(checks).every(Boolean) ? 1 : 0, checks };
}
