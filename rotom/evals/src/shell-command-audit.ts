const SHELL_COMMAND_BOUNDARY = String.raw`(?:^|[\n;&|()]\s*)(?:(?:if|then|elif|do|time|command|!)\s+|env(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+)*\s+)*`;

const FORBIDDEN_PROJECT_COMMANDS = [
	new RegExp(`${SHELL_COMMAND_BOUNDARY}(?:npm|pnpm|yarn)\\b(?:(?![;&|\\n]).)*?\\b(?:build|test|install|package|check|dev|start)\\b`, "iu"),
	new RegExp(`${SHELL_COMMAND_BOUNDARY}(?:mvn|(?:\\./)?mvnw)\\b(?:(?![;&|\\n]).)*?\\b(?:compile|test|verify|package|install)\\b`, "iu"),
	new RegExp(`${SHELL_COMMAND_BOUNDARY}(?:gradle|(?:\\./)?gradlew)\\b(?:(?![;&|\\n]).)*?\\b(?:assemble|build|check|test)\\b`, "iu"),
	new RegExp(`${SHELL_COMMAND_BOUNDARY}(?:cargo\\s+(?:build|test|check|install)|go\\s+test|make\\s+(?:build|test|install|check))\\b`, "iu"),
];

export function containsForbiddenProjectCommand(commandText: string): boolean {
	return FORBIDDEN_PROJECT_COMMANDS.some((pattern) => pattern.test(commandText));
}
