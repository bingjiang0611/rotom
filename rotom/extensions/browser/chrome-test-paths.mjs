import { resolve, join } from "node:path";
// XDG_RUNTIME_DIR is cleared so a Linux run keeps the relay under the temporary home.
export const RELAY_ENV = { XDG_RUNTIME_DIR: undefined };
export const root = resolve("rotom/extensions/browser");
export const restoreState_block = (worker) => worker.match(/async function restoreState\(\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
export const extensionDir = join(root, "chrome-extension");
export const installer = join(root, "install-chrome-relay.mjs");
export const extensionId = "kgadcllokaodnoknakblocmhidemimdi";
