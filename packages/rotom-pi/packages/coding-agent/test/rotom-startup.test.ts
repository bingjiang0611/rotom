import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ROTOM_PIXELS,
	RotomHeader,
	type RotomHeaderState,
	renderRotomSprite,
} from "../src/modes/interactive/components/rotom-header.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, setTheme, Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { ROTOM_RELEASES_URL } from "../src/utils/rotom-product.ts";

beforeEach(() => initTheme("dark"));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function state(): RotomHeaderState {
	return {
		version: "0.1.0-alpha.11",
		model: "Example Model",
		expandHint: "ctrl+o",
		expandedHelp: "ctrl+c to clear\nctrl+d to exit (empty)",
	};
}

function resource(compact: string, expanded = compact) {
	const text = new Text(compact, 0, 0);
	return {
		render: (width: number) => text.render(width),
		invalidate: vi.fn(() => text.invalidate()),
		setExpanded: vi.fn((value: boolean) => text.setText(value ? expanded : compact)),
	};
}

describe("rotom startup header", () => {
	it("keeps the Heat Rotom badge at 21 columns by 7 rows", () => {
		expect(ROTOM_PIXELS).toHaveLength(14);
		for (const row of ROTOM_PIXELS) {
			expect(row).toHaveLength(21);
			expect(row).toMatch(/^[.robwg]+$/);
		}
		for (const name of ["dark", "light"]) {
			setTheme(name);
			const sprite = renderRotomSprite();
			expect(sprite).toHaveLength(7);
			expect(sprite.every((line) => visibleWidth(line) === 21)).toBe(true);
		}
	});

	it("uses ANSI-256 sprite colors without changing the silhouette", () => {
		const mode = vi.spyOn(Theme.prototype, "getColorMode").mockReturnValue("truecolor");
		const truecolor = renderRotomSprite();
		mode.mockReturnValue("256color");
		const indexed = renderRotomSprite();
		expect(indexed.map(stripAnsi)).toEqual(truecolor.map(stripAnsi));
		expect(indexed.join("")).toMatch(/\x1b\[(?:38|48);5;/);
		expect(indexed.join("")).not.toMatch(/\x1b\[(?:38|48);2;/);
	});

	it.each([1, 12, 32, 39, 40, 52, 71, 72, 80, 100, 120, 180])(
		"fits %i columns with long CJK/emoji resource labels",
		(width) => {
			const header = new RotomHeader(() => ({ ...state(), version: "0.1\n\x1b[31m\t" }));
			header.setResources([resource(`[Skills]\n${"模型👻".repeat(60)}`)]);
			for (const expanded of [false, true]) {
				header.setExpanded(expanded);
				const lines = header.render(width);
				expect(lines.length).toBeGreaterThan(0);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(line).not.toMatch(/[\n\r\t]/);
				}
			}
		},
	);

	it.each([46, 52, 80, 100])("keeps resources on the right at %i columns without duplicate session/tips", (width) => {
		const header = new RotomHeader(state);
		header.setResources([
			resource("[Context]\nAGENTS.md"),
			resource("[Skills]\nexample"),
			resource("[Extensions]\nexample-extension"),
		]);
		const lines = header.render(width).map(stripAnsi);
		const output = lines.join("\n");
		expect(output).toContain("rotom v0.1.0-alpha.11");
		expect(output).toContain("ctrl+o details");
		expect(output).toContain("▀");
		expect(lines.filter((line) => /[▀▄]/.test(line))).toHaveLength(7);
		for (const label of ["[Context]", "[Skills]", "[Extensions]"]) {
			expect(lines.find((line) => line.includes(label))?.indexOf(label)).toBe(24);
		}
		expect(output).not.toMatch(/Quick start|Session|Example Model|╭|│/);
		expect(lines).toHaveLength(11);
	});

	it("uses the full width for tiny panes and expanded resource paths", () => {
		const path = "/tmp/project/.pi/skills/example/SKILL.md";
		const section = resource("[Skills]\nexample", `[Skills]\n${path}`);
		const header = new RotomHeader(state);
		header.setResources([section]);
		const narrow = stripAnsi(header.render(39).join("\n"));
		expect(narrow).not.toMatch(/[▀▄]/);
		expect(narrow.split("\n").map((line) => line.trimEnd())).toContain("[Skills]");
		header.setExpanded(true);
		const expanded = stripAnsi(header.render(52).join("\n"));
		expect(expanded).toContain(path);
		expect(expanded).not.toMatch(/[▀▄]/);
		expect(expanded).toContain("ctrl+d to exit (empty)");
		header.setExpanded(false);
		expect(stripAnsi(header.render(52).join("\n"))).not.toContain(path);
		expect(section.setExpanded).toHaveBeenLastCalledWith(false);
		header.invalidate();
		expect(section.invalidate).toHaveBeenCalled();
	});

	it("applies the current expansion state to newly bound resource components", () => {
		const header = new RotomHeader(state, true);
		header.setResources([resource("compact-first", "expanded-first")]);
		expect(stripAnsi(header.render(80).join("\n"))).toContain("expanded-first");
		header.setExpanded(false);
		header.setResources([resource("compact-second", "expanded-second")]);
		const output = stripAnsi(header.render(80).join("\n"));
		expect(output).toContain("compact-second");
		expect(output).not.toContain("expanded-second");
	});

	it("distinguishes loading from empty and clears stale resource components", () => {
		const header = new RotomHeader(state);
		expect(stripAnsi(header.render(80).join("\n"))).toContain("Loading resources");
		header.setResources([]);
		expect(stripAnsi(header.render(80).join("\n"))).toContain("No context, skills or extensions");
		header.setResources([resource("[Skills]\nstale-skill")]);
		header.setResources(undefined);
		expect(stripAnsi(header.render(80).join("\n"))).not.toContain("stale-skill");
	});

	it("refreshes the theme and retains an empty-model action without repeating model/cwd", () => {
		const data = state();
		const header = new RotomHeader(() => data);
		expect(header.render(0)).toEqual([]);
		const dark = header.render(80).join("\n");
		setTheme("light");
		header.invalidate();
		expect(header.render(80).join("\n")).not.toBe(dark);
		data.model = undefined;
		const output = stripAnsi(header.render(80).join("\n"));
		expect(output).toContain("No model selected · /login · /model");
		expect(output).not.toContain("Example Model");
	});
});

describe("rotom interactive update integration", () => {
	it("uses only rotom release information, not upstream notes or self-update commands", () => {
		vi.stubEnv("ROTOM_PRODUCT_VERSION", "0.1.0-alpha.11");
		const context = { chatContainer: new Container(), ui: { requestRender: vi.fn() } };
		InteractiveMode.prototype.showNewVersionNotification.call(context as unknown as InteractiveMode, {
			version: "0.1.0-alpha.12",
			note: "UPSTREAM-NOTE",
		});
		const output = stripAnsi(context.chatContainer.render(100).join("\n"));
		expect(output).toContain("rotom update available");
		expect(output).toContain("0.1.0-alpha.11 → 0.1.0-alpha.12");
		expect(output).toContain(ROTOM_RELEASES_URL);
		expect(output).not.toMatch(/pi.dev|UPSTREAM-NOTE|Run pi update/);
	});

	it("does not read/write upstream changelog state for a rotom launch", () => {
		vi.stubEnv("ROTOM_PRODUCT_VERSION", "0.1.0-alpha.11");
		const prototype = InteractiveMode.prototype as unknown as { getChangelogForDisplay(): string | undefined };
		// An empty context proves the branch cannot touch settings or install telemetry.
		expect(prototype.getChangelogForDisplay.call({})).toBeUndefined();
	});

	it("keeps the standalone Pi notification compatible", () => {
		vi.stubEnv("ROTOM_PRODUCT_VERSION", "");
		const context = { chatContainer: new Container(), ui: { requestRender: vi.fn() } };
		InteractiveMode.prototype.showNewVersionNotification.call(context as unknown as InteractiveMode, {
			version: "1.2.3",
		});
		const output = stripAnsi(context.chatContainer.render(100).join("\n"));
		expect(output).toContain("Run pi update");
		expect(output).toContain("https://pi.dev/changelog");
	});
});
