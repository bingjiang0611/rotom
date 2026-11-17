export const helperUpdateCopy = {
	automaticFailed: "rotom is installed, but automatic helper synchronization was not verified. See the helper error above; do not assume Computer Use was upgraded.",
	startupSyncFailed: "Computer Use keeps the installed helper and this session continues without the upgrade. Automatic synchronization never downgrades a certificate-signed helper, so PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 alone changes nothing here. To replace a helper whose signing identity is gone, set PI_COMPUTER_USE_CODESIGN_IDENTITY to an existing approved identity, or run 'PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 rotom helper update' to accept ad-hoc signing explicitly; macOS may then ask for Accessibility and Screen Recording again.",
	usage: "Usage: rotom helper update\nClose owning sessions first. 运行 rotom helper update（它会询问是否停止旧 helper），交互终端默认否；其他使用它的 rotom 会话会失去 Computer Use。 On managed Macs set PI_COMPUTER_USE_CODESIGN_IDENTITY to an existing approved identity. This command installs to ~/Applications/pi-computer-use.app; it does not start the helper.",
	untrusted: "Helper updater is missing or is not a trusted regular file.",
	interrupted: "Helper updater was interrupted. Inspect the reported paths before retrying; installation status is unknown.",
};
