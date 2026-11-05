import assert from "node:assert/strict";
import test from "node:test";
import {
	downloadDirSegmentV1,
	downloadOwnerAgentIdV1,
	downloadRecordV1,
	downloadRelativeFilenameV1,
	downloadRelativePathV1,
	isAgentDownloadPathV1,
} from "./chrome-extension/downloads.js";

const DOWNLOADS = "/Users/someone/Downloads";

test("downloads: 目录段只接受安全 id，名字剥掉目录与非法字符", () => {
	assert.equal(downloadDirSegmentV1("run_abc-1"), "run_abc-1");
	for (const bad of ["", "a/b", "../x", "a b", "a".repeat(65), undefined, 7]) assert.equal(downloadDirSegmentV1(bad), undefined, `${String(bad)} 不能做目录名`);
	assert.equal(downloadRelativeFilenameV1({ agentId: "run_a", suggestedFilename: "report.txt" }), "rotom/run_a/report.txt");
	assert.equal(downloadRelativeFilenameV1({ agentId: "run_a", suggestedFilename: "../../etc/passwd" }), "rotom/run_a/passwd", "目录部分必须被剥掉");
	assert.equal(downloadRelativeFilenameV1({ agentId: "run_a", suggestedFilename: "..\\..\\evil.exe" }), "rotom/run_a/evil.exe");
	assert.equal(downloadRelativeFilenameV1({ agentId: "run_a", suggestedFilename: ".." }), undefined);
	assert.equal(downloadRelativeFilenameV1({ agentId: "run_a", suggestedFilename: "a\u0000b" }), undefined, "控制字符不能进文件名");
	assert.equal(downloadRelativeFilenameV1({ agentId: "../x", suggestedFilename: "a.txt" }), undefined);
	assert.equal(downloadRelativeFilenameV1({ agentId: "run_a", suggestedFilename: "x".repeat(400) }).length, "rotom/run_a/".length + 120, "超长名字要截断");
});

test("downloads: 记录只保留模型安全字段，绝对路径单独给出", () => {
	const record = downloadRecordV1({ id: 7, state: "complete", filename: `${DOWNLOADS}/rotom/run_a/report.txt`, fileSize: 1234, mime: "text/plain" }, "run_a");
	assert.deepEqual(record, { id: 7, state: "complete", relativePath: "rotom/run_a/report.txt", bytes: 1234, mimeType: "text/plain", path: `${DOWNLOADS}/rotom/run_a/report.txt` });
	assert.equal(downloadRecordV1({ id: 8, state: "complete", filename: `${DOWNLOADS}/other/report.txt` }, "run_a"), undefined, "别的目录不属于这个 agent");
	assert.equal(downloadRecordV1({ id: 9, state: "complete", filename: `${DOWNLOADS}/rotom/run_b/report.txt` }, "run_a"), undefined, "别的 agent 的目录也不能读");
	assert.equal(downloadRecordV1({ state: "complete", filename: `${DOWNLOADS}/rotom/run_a/x` }, "run_a"), undefined, "没有 id 就不是有效记录");
	const interrupted = downloadRecordV1({ id: 10, state: "interrupted", filename: `${DOWNLOADS}/rotom/run_a/x.bin`, error: "NETWORK_FAILED", bytesReceived: 12 }, "run_a");
	assert.equal(interrupted.state, "interrupted");
	assert.equal(interrupted.bytes, 12);
	assert.equal(interrupted.error, "NETWORK_FAILED");
	assert.equal(interrupted.mimeType, "application/octet-stream");
	const weird = downloadRecordV1({ id: 11, state: "surprise", filename: `${DOWNLOADS}/rotom/run_a/x`, fileSize: -1 }, "run_a");
	assert.equal(weird.state, "unknown");
	assert.equal(weird.bytes, 0);
	assert.equal(downloadRecordV1(null, "run_a"), undefined);
});

test("downloads: 归属优先用 tabId，缺失时只用无歧义的 referrer", () => {
	const tabs = [
		{ tabId: 1, url: "https://a.test/page", agentId: "main", ownership: "agent" },
		{ tabId: 2, url: "https://a.test/page", agentId: "main", ownership: "claimed" },
		{ tabId: 3, url: "https://b.test/only", agentId: "run_b", ownership: "agent" },
		{ tabId: 4, url: "https://c.test/x?y=1", agentId: "run_c", ownership: "agent" },
	];
	assert.equal(downloadOwnerAgentIdV1({ tabId: 3 }, tabs), "run_b");
	assert.equal(downloadOwnerAgentIdV1({ tabId: 2 }, tabs), undefined, "claimed tab 的下载是用户的");
	assert.equal(downloadOwnerAgentIdV1({ tabId: 99 }, tabs), undefined, "未知 tab 不能猜");
	// referrer：同一页面既有 agent tab 又有 claimed tab → 不猜。
	assert.equal(downloadOwnerAgentIdV1({ referrer: "https://a.test/page" }, tabs), undefined);
	assert.equal(downloadOwnerAgentIdV1({ referrer: "https://b.test/only" }, tabs), "run_b");
	assert.equal(downloadOwnerAgentIdV1({ referrer: "https://c.test/x?y=1" }, tabs), "run_c", "query 不同但页面相同");
	assert.equal(downloadOwnerAgentIdV1({ referrer: "https://d.test/none" }, tabs), undefined);
	assert.equal(downloadOwnerAgentIdV1({ referrer: "not a url" }, tabs), undefined);
	assert.equal(downloadOwnerAgentIdV1({}, tabs), undefined);
	assert.equal(downloadOwnerAgentIdV1({ tabId: 3 }, undefined), undefined);
	// 两个不同 agent 都开着同一页面 → 歧义，不动。
	assert.equal(downloadOwnerAgentIdV1({ referrer: "https://a.test/page" }, [{ tabId: 1, url: "https://a.test/page", agentId: "main", ownership: "agent" }, { tabId: 2, url: "https://a.test/page", agentId: "run_d", ownership: "agent" }]), undefined);
});

test("downloads: 路径判定同时接受绝对与相对写法", () => {
	assert.equal(isAgentDownloadPathV1(`${DOWNLOADS}/rotom/run_a/x.txt`, "run_a"), true);
	assert.equal(isAgentDownloadPathV1("rotom/run_a/x.txt", "run_a"), true);
	assert.equal(isAgentDownloadPathV1(`${DOWNLOADS}/rotom/run_a_deeper/x.txt`, "run_a"), false);
	assert.equal(isAgentDownloadPathV1(`${DOWNLOADS}/other/rotom/run_a/x.txt`, "run_a"), true);
	assert.equal(downloadRelativePathV1(`${DOWNLOADS}/rotom/run_a/sub/x.txt`, "run_a"), "rotom/run_a/sub/x.txt");
	assert.equal(downloadRelativePathV1(`${DOWNLOADS}/other/x.txt`, "run_a"), undefined);
});
