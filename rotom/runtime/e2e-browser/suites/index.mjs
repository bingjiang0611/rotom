import * as baseline from "./baseline.mjs";
import * as isolation from "./isolation.mjs";
import * as sameAgentParallel from "./same-agent-parallel.mjs";
import * as cleanup from "./cleanup.mjs";
import * as focus from "./focus.mjs";
import * as visibility from "./visibility.mjs";

/** Suite registry. Later tasks append their suites here. */
export const suites = {
	baseline,
	isolation,
	"same-agent-parallel": sameAgentParallel,
	cleanup,
	focus,
	visibility,
};
