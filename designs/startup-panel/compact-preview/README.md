# Compact startup proposals

**Design prototypes only — not running-app screenshots.** B was selected by the user at commit `e394f37`; implementation, installation and actual PTY captures are recorded in [D-ROTOM-STARTUP-03](../decisions.md).

## Brief / 2026-09-12

- User rejected the installed D-ROTOM-STARTUP-02 mascot as ugly/too large and requested actual Context / Skills / Extensions on the right.
- Preserve Heat Rotom identity, product version/update behavior, keyboard interaction, quiet startup and existing sessions. Do not switch installs before the user chooses a visual direction.
- Current session advertises Apple Terminal. Assume no inline-image protocol; do not present high-resolution PNG artwork as a promised terminal rendering. The proposed mascot is an original flat cell grid, with two pixel rows per terminal cell.
- Replace Quick start / Session on the right. Reuse the existing loaded-resource labels/formatting; no new resource discovery or hardcoded production lists. Show each resource listing once. Preserve diagnostic warnings and optional Prompts / Themes; do not hide errors inside the new panel.
- Target 52-column and 80-column terminals. The 52-column state must remain two-column instead of switching to a huge stacked mascot. Smaller panes will require a separate text-only fallback in implementation.

## Directions

| | A — compact card | B — minimal sidebar (recommended) |
|---|---|---|
| Mascot | 19×14 pixels / 19×7 cells | 11×10 pixels / 11×5 cells |
| Structure | Bordered two-column card; model under mascot | Unboxed small icon + wider resource column |
| Priority | Branding / familiar panel structure | Actual resources and less startup height |
| Trade-off | Longer lists make the card tall, especially at 52 columns | Less character detail; model/cwd remain in the existing footer |

The example labels are fixture data for comparing identical content, not a live account/resource query. The Python/Pillow drawings approximate terminal layout using a 12px column / 24px row; they do not verify native TUI behavior. Subsequent implementation and terminal checks are recorded separately in D-ROTOM-STARTUP-03; these selected prototype images are not silently replaced with new renders.

## Review / reproduce

- [52-column comparison](compare-52.png)
- [80-column comparison](compare-80.png)
- Individual panels: [A/52](a-52.png), [B/52](b-52.png), [A/80](a-80.png), [B/80](b-80.png).
- `python3 designs/startup-panel/compact-preview/render.py` (requires Python Pillow and macOS Menlo; reads no user configuration or credentials).
- The render asserts consistent sprite row widths, palette keys and resource text bounds. It does not test the product.

Reference/reuse: R-HEAT-ROTOM for recognizable oven/flame features; P-ROTOM-STARTUP for existing startup behavior and explicit rejection of D-02. No external artwork is embedded. No new global aesthetic preference is inferred. B was selected; A was not. Selected `b-52.png` SHA-256: `1f5505a1bcffb75bb7883006226934dca4c7fc57f434b3e776b247126cb1e1fa`. Selection of this prototype does not stand in for final desktop acceptance.
