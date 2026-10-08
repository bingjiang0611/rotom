import type { InlineExtension } from "../core/extensions/types.ts";
import { getRotomVersion } from "../utils/rotom-product.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Product CLI and SDK share the wrapper's Codemode policy. Do not load a
	// duplicate native factory; standalone Pi retains its replaceable built-in.
	...(getRotomVersion() ? [] : [{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true } as const]),
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	// Rotom does not discover or start MCP servers. Explicit user extensions remain user-owned.
];
