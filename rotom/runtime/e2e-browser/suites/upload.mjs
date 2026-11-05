// upload (T17): attach a local file to a file input, and prove the bytes arrived.
//
// The path rules live in the Pi tool layer, so this suite drives the real browser tools
// over the harness socket. The fixture posts the chosen file back to its own server, so
// the assertion compares received bytes with the local file instead of trusting the page.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrowserTools } from "../browser-tools.mjs";

export const description = "upload：文件输入、服务端字节与本地一致、敏感路径与链接被拒";

export async function run({ harness, fixtures, recorder, workspace }) {
	const tools = await loadBrowserTools({ socketPath: harness.socketPath, workspace });
	const workspaceDir = await mkdtemp(join(tmpdir(), "rotom-e2e-upload-"));
	const body = `upload fixture payload ${"x".repeat(4096)}\n`;
	const filePath = join(workspaceDir, "payload.txt");
	await writeFile(filePath, body);
	const expected = createHash("sha256").update(body).digest("hex");
	const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");
	const refFor = async (name) => {
		const snapshot = await tools.inspect({ operation: "snapshot_visible", tabName: "upload", limit: 200 });
		const node = snapshot.details.observation.nodes.find((candidate) => candidate.name === name);
		assert.ok(node, `${name} 必须在快照里；现有：${JSON.stringify(snapshot.details.observation.nodes.slice(0, 12).map((entry) => [entry.role, entry.name]))}`);
		return node.ref;
	};

	try {
		await tools.inspect({ operation: "open", tabName: "upload", url: fixtures.url("/upload"), limit: 5 });
		await tools.inspect({ operation: "wait", tabName: "upload", status: "complete", timeoutMs: 10_000 });

		await recorder.check("上传后服务端收到的字节与本地文件一致", async () => {
			const input = await refFor("upload input");
			const result = await tools.interact({ operation: "execute", tabName: "upload", action: "upload", targetRef: input, paths: [filePath] });
			assert.equal(result.details.kind, "browser-interaction-result");
			assert.equal(result.details.effect.dispatch, "files");
			assert.equal(result.details.effect.files, 1);
			for (let attempt = 0; attempt < 50; attempt += 1) {
				if (fixtures.uploads.length > 0) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.equal(fixtures.uploads.length, 1, "服务端必须收到一次上传");
			assert.equal(fixtures.uploads[0].sha256, expected, "服务端收到的内容必须与本地文件一致");
			assert.equal(fixtures.uploads[0].size, Buffer.byteLength(body));
			const status = await tools.inspect({ operation: "snapshot_visible", tabName: "upload", limit: 50 });
			const text = status.details.observation.nodes.filter((node) => node.role === "document-text").map((node) => node.name).join(" ");
			assert.match(text, new RegExp(`upload\\|payload\\.txt\\|${Buffer.byteLength(body)}\\|${expected}`, "u"));
			assert.equal(textOf(result).includes(workspaceDir), false, "工具结果不得包含本地目录");
		});

		await recorder.check("非 file input 的目标被拒绝", async () => {
			const heading = await refFor("Upload fixture");
			await assert.rejects(tools.interact({ operation: "execute", tabName: "upload", action: "upload", targetRef: heading, paths: [filePath] }), /file input/u);
		});

		await recorder.check("敏感路径、符号链接、相对路径与超大文件在本地被拒绝", async () => {
			const input = await refFor("upload input");
			const secret = join(workspaceDir, ".env");
			await writeFile(secret, "SECRET=1\n");
			await assert.rejects(tools.interact({ operation: "execute", tabName: "upload", action: "upload", targetRef: input, paths: [secret] }), /upload 被拒绝/u);
			const link = join(workspaceDir, "link.txt");
			await symlink(filePath, link);
			await assert.rejects(tools.interact({ operation: "execute", tabName: "upload", action: "upload", targetRef: input, paths: [link] }), /upload 被拒绝/u);
			await assert.rejects(tools.interact({ operation: "execute", tabName: "upload", action: "upload", targetRef: input, paths: ["relative.txt"] }), /upload 被拒绝/u);
			const huge = join(workspaceDir, "huge.bin");
			await writeFile(huge, Buffer.alloc(10 * 1024 * 1024 + 1));
			await assert.rejects(tools.interact({ operation: "execute", tabName: "upload", action: "upload", targetRef: input, paths: [huge] }), /总大小超过/u);
			await assert.rejects(tools.interact({ operation: "execute", tabName: "upload", action: "upload", targetRef: input, paths: [] }), /paths|upload/u);
			assert.equal(fixtures.uploads.length, 1, "被拒绝的上传不得让站点收到请求");
		});
	} finally {
		await tools.shutdown();
		await rm(workspaceDir, { recursive: true, force: true });
	}
}
