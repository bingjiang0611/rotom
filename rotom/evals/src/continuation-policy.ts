/**
 * The execution contract the continuation suite appends to the product system prompt. It lives
 * here rather than in the eval file so offline tests can pin it without starting a suite.
 */
import type { ContinuationCase } from "./continuation-cases.ts";

export function executionPolicy(caseDefinition: ContinuationCase): string {
	return `Fixture execution contract:
- This is an isolated local fixture repository. Do not run Git discovery, directory listing, package-manager commands, or inspect parent/host configuration.
- Read only supplied fixture files. Edit only: ${caseDefinition.editable.length > 0 ? caseDefinition.editable.map((file) => `\`${file}\``).join(", ") : "none"}.
- The only allowed shell commands are: ${caseDefinition.commands.map((command) => `\`${command}\``).join(", ")}. edit.then_run is unavailable; run an allowed command with bash after a successful edit. Do not combine commands or use another tool to bypass this boundary.
- Follow the response schema in the user task. This contract restricts execution and does not supply the task answer.${caseDefinition.reply === "json" ? `
- The caller requires the JSON schema stated in the task. This overrides the product human-readable final-report template: return one raw JSON object, with no prose, headings or Markdown fences.` : ""}`;
}
