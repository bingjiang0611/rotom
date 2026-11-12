export const helperUpdateCommand = "rotom helper update";
export const helperUpdateCopy = {
	macOnly: "Helper update is supported only on macOS.",
	missingBundle: "The packaged helper app is missing. Reinstall a complete rotom package; no helper was changed.",
	wrongBundle: "Refusing a helper with an unexpected bundle or signing identifier.",
	unsafePath: "Refusing a symlink or non-canonical helper update path.",
	busy: (pids) => `Helper is still in use (pid ${pids}). Close its owning rotom sessions and quit that helper, then run ${helperUpdateCommand}. No helper was changed.`,
	unknownProcesses: "Cannot establish whether the helper is in use. No helper was changed; inspect the process-check error before retrying.",
	locked: "Another helper update is in progress, or an interrupted update left a lock. Inspect it before retrying; do not remove an active lock.",
	noSign: "PI_COMPUTER_USE_NO_SIGN conflicts with an explicit signing identity. No helper was changed.",
	adhoc: "Refusing to replace an existing helper with an ad-hoc bundle. Set PI_COMPUTER_USE_CODESIGN_IDENTITY to an existing approved identity, or explicitly authorize PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1. This does not override system security policy.",
	notInstalled: "Helper installation did not complete. Inspect the target before retrying.",
	incomplete: (backup) => `Helper replacement did not complete. The previous app is preserved at ${backup}. Inspect both paths; do not automatically replay the update.`,
	complete: (target) => `Updated helper at ${target}. No helper was started and no session was restarted. Start a new session to check protocol and permissions.`,
};
