import { describe, expect, it } from "vitest";
import { containsForbiddenProjectCommand } from "../src/shell-command-audit.ts";

describe("containsForbiddenProjectCommand", () => {
	it.each([
		"npm test",
		"npm --workspace demo-app test",
		"pnpm -r test",
		"yarn --cwd demo-app build",
		"if ./mvnw -pl demo-app verify; then echo ok; fi",
		"env CI=1 ./gradlew --no-daemon check",
		"cargo test",
		"go test ./...",
		"make install",
	])("detects project lifecycle execution: %s", (command) => {
		expect(containsForbiddenProjectCommand(command)).toBe(true);
	});

	it.each([
		"git diff --check",
		"npm --version",
		"mvn --version",
		"grep -R 'npm test' .",
		"printf 'pnpm -r test\\n'",
		"rg -n 'gradle build' README.md",
		"python3 verify_fixture.py",
	])("does not reject static inspection: %s", (command) => {
		expect(containsForbiddenProjectCommand(command)).toBe(false);
	});
});
