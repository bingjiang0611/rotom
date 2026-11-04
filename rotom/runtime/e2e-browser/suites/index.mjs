import * as baseline from "./baseline.mjs";
import * as isolation from "./isolation.mjs";

/** Suite registry. Later tasks append their suites here. */
export const suites = {
	baseline,
	isolation,
};
