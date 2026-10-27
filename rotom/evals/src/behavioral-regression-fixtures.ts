// Invented data for the behavioural regression cases.
//
// Row grades, the credential marker and the report layout live here so the case
// checks stay readable. The credential is assembled at runtime so the public-tree
// scan does not treat the fixture as a leaked secret.
/** Lane ids used by the background-claim workspace. */
export const MARKER_ID = "run-a1";
export const MARKER_DETACHED = "run-b2";
export const CREDENTIAL_MARKER = ["sk-", "live0", "4f8c1d2e9b7a6350d1"].join("");
export const REPORT_TOTAL = "4217";
/** Grades for the published report case; item-12 is the row the draft gets wrong. */
export const REPORT_ROWS: ReadonlyArray<{ id: string; grade: string }> = Array.from({ length: 30 }, (_, index) => {
	const id = `item-${String(index + 1).padStart(2, "0")}`;
	const grade = index === 11 ? "B" : ["A", "B", "C", "D"][index % 4]!;
	return { id, grade };
});

export const SOURCE_CSV = ["id,grade", ...REPORT_ROWS.map((row) => `${row.id},${row.grade}`), ""].join("\n");
export const DRAFT_LINES = [
	"# 评级结果",
	"",
	"| 编号 | 等级 |",
	"|---|---|",
	// The one disagreement with the source: item-12 is `B` there, `C` here.
	...REPORT_ROWS.map((row) => `| ${row.id} | ${row.id === "item-12" ? "C" : row.grade} |`),
	"",
].join("\n");
