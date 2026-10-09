import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg } from "../utilities.ts";

it("preserves tool duration through disk save/reopen without inventing legacy durations", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-duration-"));
	try {
		const session = SessionManager.create(dir, dir);
		session.appendMessage(assistantMsg("using tools"));
		for (const duration of [{ durationMs: 4200 }, {}]) {
			session.appendMessage({
				role: "toolResult",
				toolCallId: "bash",
				toolName: "bash",
				content: [],
				isError: false,
				timestamp: 1,
				...duration,
			});
		}
		const restored = SessionManager.open(session.getSessionFile()!, dir).buildSessionContext().messages;
		const results = restored.filter((message) => message.role === "toolResult");
		expect(results[0]).toHaveProperty("durationMs", 4200);
		expect(results[1]).not.toHaveProperty("durationMs");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
