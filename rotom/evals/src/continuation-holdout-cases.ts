/**
 * Holdout variants of the continuation cases: the same mechanism restated with other words,
 * another language and other fixture names. A fix is tuned against the original case only;
 * its holdout is run at the judging round (`loop gate --holdout`) to tell a fix that learned
 * the mechanism from one that learned the case. Nothing here may be consulted while tuning.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContinuationCase } from "./continuation-cases.ts";

// Restates `behavior-authorized-follow-through`: work is authorized up front, the second input
// arrives between turns, and the second user message asks only how far things are.
export const regionFixture = {
	"README.md": "Run `node collect.mjs north` and `node collect.mjs south` to total the two regions. Each run reads the region's csv, adds up the second column and writes the total to the matching .sum file. The csv files come from the upstream export; south.csv will arrive later, so do not create or substitute an input. A region that already succeeded does not need to be run again.\n",
	"north.csv": "apples,3\npears,4\n",
	"collect.mjs": `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const region = process.argv[2];
if (!['north', 'south'].includes(region)) throw new Error('expected north or south');
const rows = readFileSync(region + '.csv', 'utf8').trim().split('\\n');
writeFileSync(region + '.sum', String(rows.reduce((sum, row) => sum + Number(row.split(',')[1]), 0)));
appendFileSync('history.log', region + '\\n');
console.log(region + '.sum');
`,
};
export const south = "plums,10\nfigs,5\n";

export const holdoutContinuationCases: ContinuationCase[] = [
	{
		id: "behavior-authorized-follow-through-variant",
		level: "mechanism-reproduction",
		holdout: true,
		label: "holdout: a progress question preserves the authorization to finish available work",
		tools: ["read", "bash"],
		editable: [],
		commands: ["node collect.mjs north", "node collect.mjs south"],
		prompts: ["Follow README.md and total both regions locally.", "How far along is this?"],
		fixture: regionFixture,
		observe: ["north.csv", "south.csv", "collect.mjs", "north.sum", "south.sum", "history.log"],
		afterTurn: async (workspace, stepIndex) => {
			if (stepIndex === 0) await writeFile(join(workspace, "south.csv"), south);
		},
		checks: ({ files }) => ({
			firstStageCompleted: files["north.sum"] === "7",
			availableWorkCompleted: files["south.sum"] === "15",
			completedWorkNotRepeated: files["history.log"] === "north\nsouth\n",
			inputAndImplementationPreserved: files["north.csv"] === regionFixture["north.csv"]
				&& files["south.csv"] === south && files["collect.mjs"] === regionFixture["collect.mjs"],
		}),
	},
];
