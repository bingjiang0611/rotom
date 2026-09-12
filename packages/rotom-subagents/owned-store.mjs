// Explicit metadata initialization only. Never starts Pi, migrates sessions or replays work.
import path from 'node:path';
import { createJiti } from 'jiti';
const [operation, baseFlag, base, ...flags] = process.argv.slice(2);
const accepted = operation === 'init' && flags.length === 1 && flags[0] === '--accept-unverified-descendants';
if (!['init', 'inspect'].includes(operation) || baseFlag !== '--base' || !base || !path.isAbsolute(base)
	|| (operation === 'init' ? !accepted : flags.length !== 0)) {
	console.error('Usage: node owned-store.mjs init --base /absolute/base --accept-unverified-descendants\n       node owned-store.mjs inspect --base /absolute/base');
	process.exitCode = 2;
} else {
	try {
		const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
		const { initializeExecutionStore, resolveExecutionStore, OWNED_EXECUTION_SCOPE } = await jiti.import('./src/shared/execution-store.ts');
		const store = operation === 'init' ? initializeExecutionStore(base) : resolveExecutionStore(base, OWNED_EXECUTION_SCOPE);
		console.log(JSON.stringify({ operation, scope: store.scope, root: store.root,
			environmentForNewSessionOnly: { PI_SUBAGENTS_TEMP_ROOT: store.baseRoot, PI_SUBAGENTS_EXECUTION_SCOPE: store.scope },
			descendants: 'unverified', effects: 'unverified', recoveryAuthorized: false, liveSessionMigration: false,
			limits: 'single async Pi/external CLI or async workflow; no nested/worktree/gate/fork/import/external-job/standalone foreground',
			warning: 'Acknowledgment is not closure. Do not change IDs, sessions, scopes or bases to retry unknown work.' }));
	} catch (error) {
		console.error(JSON.stringify({ error: 'Execution store unavailable; no migration, replay or reset is authorized.',
			...(typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? { code: error.code } : {}) }));
		process.exitCode = 1;
	}
}
