import * as piAI from '@earendil-works/pi-ai/compat';
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createRefreshGuard } from './refresh-guard.mjs';
import { installQoderExtension, qoderEnabled } from './session-policy.mjs';

// Pi's extension loader explicitly aliases this public compatibility export.
// Inject it so the ESM helper never relies on the maintenance cwd's packages.
export default async function qoderProvider(pi: ExtensionAPI) {
  // Bundled, but opt-in: unrelated sessions must not discover ambient Qoder auth.
  if (!qoderEnabled(process.env)) return;
  await installQoderExtension(pi, {
    piAI,
    oauthOptions: { claimRefresh: createRefreshGuard(getAgentDir()) },
  });
}
