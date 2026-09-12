import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Chalk } from "chalk";
import { theme } from "../theme/theme.ts";

// Compact Heat Rotom badge, selected in D-ROTOM-STARTUP-03/B: a flat oven and plasma arms.
// Two pixel rows share one terminal cell; no image protocol, download or animation.
export const ROTOM_PIXELS = [
	".....r.....",
	".r..ror..r.",
	"rwrrooorrwr",
	".rrooooorr.",
	"..rowowor..",
	"..rooooor..",
	"..robbbor..",
	"..robgbor..",
	"...rooor...",
	"...rr.rr...",
] as const;

export function renderRotomSprite(): string[] {
	const color = new Chalk({ level: theme.getColorMode() === "truecolor" ? 3 : 2 });
	const palette: Record<string, string> = {
		r: "#ef7058", // plasma / outline
		o: "#f8ab59", // oven shell
		w: "#fff1d8", // eyes / flame cores
		b: "#30404c", // oven window
		g: "#8dabb4", // window reflection
	};
	const lines: string[] = [];
	for (let y = 0; y < ROTOM_PIXELS.length; y += 2) {
		let line = "";
		for (let x = 0; x < ROTOM_PIXELS[0].length; x++) {
			const top = palette[ROTOM_PIXELS[y]?.[x] ?? "."];
			const bottom = palette[ROTOM_PIXELS[y + 1]?.[x] ?? "."];
			line += top
				? bottom
					? color.hex(top).bgHex(bottom)("▀")
					: color.hex(top)("▀")
				: bottom
					? color.hex(bottom)("▄")
					: " ";
		}
		lines.push(line);
	}
	return lines;
}

export interface RotomHeaderState {
	version: string;
	model?: string;
	expandHint: string;
	expandedHelp: string;
}

interface ExpandableResource extends Component {
	setExpanded(expanded: boolean): void;
}

function oneLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export class RotomHeader implements Component {
	private readonly getState: () => RotomHeaderState;
	private expanded: boolean;
	private resources: readonly ExpandableResource[] | undefined;

	constructor(getState: () => RotomHeaderState, expanded = false) {
		this.getState = getState;
		this.expanded = expanded;
	}

	// These are the existing loaded-resource components, not a second discovery or formatting path.
	// Undefined means binding/reloading; an empty array means a completed, empty listing.
	setResources(resources: readonly ExpandableResource[] | undefined): void {
		this.resources = resources;
		this.setExpanded(this.expanded);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const resource of this.resources ?? []) resource.setExpanded(expanded);
	}

	invalidate(): void {
		for (const resource of this.resources ?? []) resource.invalidate();
	}

	private renderResources(width: number): string[] {
		if (!this.resources?.length) {
			return new Text(
				theme.fg("dim", this.resources ? "No context, skills or extensions" : "Loading resources…"),
				0,
				0,
			).render(width);
		}
		return this.resources.flatMap((resource, index) => [...(index > 0 ? [""] : []), ...resource.render(width)]);
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const state = this.getState();
		const title = `${theme.bold(theme.fg("accent", "rotom"))} ${theme.fg("muted", `v${oneLine(state.version)}`)}`;
		const lines = [title, ""];
		if (width >= 40 && !this.expanded) {
			const leftWidth = 13;
			const left = ["", ...renderRotomSprite().map((line) => ` ${line}`)];
			const right = this.renderResources(Math.min(width, 104) - leftWidth - 2);
			for (let i = 0; i < Math.max(left.length, right.length); i++) {
				const badge = left[i] ?? "";
				lines.push(`${badge}${" ".repeat(leftWidth - visibleWidth(badge))}  ${right[i] ?? ""}`);
			}
		} else {
			// Small panes omit the badge instead of stacking a large face. Expanded paths use the full width.
			lines.push(...this.renderResources(width));
		}
		if (!state.model) lines.push(theme.fg("muted", "No model selected · /login · /model"));
		if (this.expanded) lines.push("", ...new Text(state.expandedHelp, 1, 0).render(width));
		else lines.push(theme.fg("dim", `${oneLine(state.expandHint)} details`));
		return lines.map((line) => truncateToWidth(line, width));
	}
}
