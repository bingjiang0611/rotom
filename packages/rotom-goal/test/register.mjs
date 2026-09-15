// Exercise maintained TS against the exact product Pi, without modifying an
// installed runtime or depending on ancestor node_modules/PATH resolution.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
const modules = new URL("../../../rotom/runtime/pi/node_modules/", import.meta.url);
const aliases = Object.fromEntries(
	[
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	].map((name) => [
		name,
		new URL(`${name}/${name === "typebox" ? "build/index.mjs" : "dist/index.js"}`, modules).href,
	]),
);
registerHooks({
	resolve(specifier, context, next) {
		if (aliases[specifier]) return { url: aliases[specifier], shortCircuit: true };
		if (
			specifier.startsWith(".") &&
			specifier.endsWith(".js") &&
			context.parentURL?.includes("/rotom-goal/")
		) {
			const source = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
			if (existsSync(source)) return { url: source.href, shortCircuit: true };
		}
		return next(specifier, context);
	},
});
