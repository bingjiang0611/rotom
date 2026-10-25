import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export type QualityFinding = { rule: string; file: string; line: number; message: string };

// These are maintenance checks for known regressions, not a JS security sandbox.
// Literal property access is supported; arbitrary aliases/data flow are not.
function propertyPath(node: ts.Node): string | undefined {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) {
		const owner = propertyPath(node.expression);
		return owner && `${owner}.${node.name.text}`;
	}
	if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
		const owner = propertyPath(node.expression);
		return owner && `${owner}.${node.argumentExpression.text}`;
	}
	return undefined;
}

export function inspectQualityContracts(file: string, source: string): QualityFinding[] {
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const findings: QualityFinding[] = [];
	function report(node: ts.Node, rule: string, message: string) {
		findings.push({ rule, file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, message });
	}
	function visit(node: ts.Node, phaseReader = false) {
		const readsPhases = phaseReader || (ts.isFunctionDeclaration(node) && node.name?.text === "codingResultPhases");
		const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
			&& node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
		const directOverride = (assignment && propertyPath(node.left) === "process.emitWarning")
			|| (ts.isDeleteExpression(node) && propertyPath(node.expression) === "process.emitWarning");
		const descriptorOverride = ts.isCallExpression(node)
			&& ["Object.defineProperty", "Reflect.defineProperty", "Reflect.set", "Reflect.deleteProperty"].includes(propertyPath(node.expression) ?? "")
			&& node.arguments[0] && propertyPath(node.arguments[0]) === "process"
			&& node.arguments[1] && ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === "emitWarning";
		if (directOverride || descriptorOverride) {
			report(node, "no-global-warning-override", "Keep process.emitWarning intact; handle a specific diagnostic at its producer/UI boundary.");
		}
		// The phase reader may use tool metadata, never presentation content. This
		// catches regex/prefix variants without maintaining a list of English text.
		const contentAccess = (ts.isPropertyAccessExpression(node) && node.name.text === "content")
			|| (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "content")
			|| (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(tree) === "content");
		if (readsPhases && contentAccess) {
			report(node, "no-display-text-as-protocol", "codingResultPhases must read versioned details, not tool display content.");
		}
		ts.forEachChild(node, child => visit(child, readsPhases));
	}
	visit(tree);
	return findings;
}

// Deliberately bounded to the production entry points that owned these bugs.
// Tests may mock warnings; other consumers may legitimately inspect display text.
export const QUALITY_CONTRACT_FILES = [
	"runtime/launch-runtime.mjs",
	"extensions/coding-policy/index.ts",
	"extensions/third-party/index.ts",
	"extensions/third-party/deferred-tools/register.ts",
] as const;

export function checkQualityContracts(agentDir: string): QualityFinding[] {
	return QUALITY_CONTRACT_FILES.flatMap(file => inspectQualityContracts(file, readFileSync(join(agentDir, file), "utf8")));
}
