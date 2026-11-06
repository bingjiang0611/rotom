import * as baseline from "./baseline.mjs";
import * as isolation from "./isolation.mjs";
import * as sameAgentParallel from "./same-agent-parallel.mjs";
import * as cleanup from "./cleanup.mjs";
import * as focus from "./focus.mjs";
import * as visibility from "./visibility.mjs";
import * as chunked from "./chunked.mjs";
import * as settle from "./settle.mjs";
import * as lease from "./lease.mjs";
import * as quotas from "./quotas.mjs";
import * as parallel4 from "./parallel-4.mjs";
import * as navigate from "./navigate.mjs";
import * as consoleSuite from "./console.mjs";
import * as network from "./network.mjs";
import * as keyboard from "./keyboard.mjs";
import * as pointer from "./pointer.mjs";
import * as policy from "./policy.mjs";
import * as confirm from "./confirm.mjs";
import * as downloads from "./downloads.mjs";
import * as upload from "./upload.mjs";
import * as dialog from "./dialog.mjs";
import * as batch from "./batch.mjs";
import * as devtools from "./devtools.mjs";

/** Suite registry. Later tasks append their suites here. */
export const suites = {
	baseline,
	isolation,
	"same-agent-parallel": sameAgentParallel,
	cleanup,
	focus,
	visibility,
	chunked,
	settle,
	lease,
	quotas,
	"parallel-4": parallel4,
	navigate,
	console: consoleSuite,
	network,
	keyboard,
	pointer,
	upload,
	dialog,
	batch,
	devtools,
	policy,
	confirm,
	downloads,
};
