---
version: 1
slug: "rotom-extensions-observability-eval-ui-mjs"
primary_target: "rotom/extensions/observability/eval/ui.mjs"
related_targets: ["rotom/extensions/observability/eval/annotation-ui.mjs","rotom/extensions/observability/eval/judge-ui.mjs","rotom/extensions/observability/eval/replay-ui.mjs"]
---

# Eval page

Mode: Operate. Scope: `rotom/extensions/observability/eval/` only; preserve the existing observability header, trace contract, local-token boundary, and all current eval capabilities.

Audience/job: rotom maintainers reviewing many local sessions. They first reduce a queue by risk and evidence, then decide a single case through human annotation, model analysis, and replay comparison.

Proof/content: real session status, request/final text, rules, metrics, timeline events, tool failures, annotation provenance, judge evidence/usage, replay points/arms/conclusions, and explicit unknown/error states. Synthetic fixtures prove the UI; no private session content enters source or screenshots.

## Direction contract

THESIS: One evidence workbench keeps queue, causal evidence, and decisions in one view; it refuses the current long vertical stack where analysis and replay disappear below the fold.

OWN-WORLD: Preserve rotom’s restrained near-black shell, thin cool borders, compact system typography, and semantic mint/amber/red/blue. Use flat regions and evidence lines rather than nested decorative cards.

STORY: The maintainer narrows the queue, reads the decisive turns, sees model and replay evidence without hunting, makes the human decision, and advances to the next case.

FIRST VIEWPORT: A 300px triage rail on the left, a flexible evidence spine in the center, and a 300px scrollable evaluation rail on the right. The right rail always exposes human annotation, model analysis, and replay status. Replay points are pinned directly to their assistant events. The primary action is “保存并处理下一条”.

FORM: Evidence Workbench, first on the ordered structure list; signature interaction is the pinned evidence spine connecting request, failure, agent decision, final claim, and replay point. seed:3d470df9d747dcf7.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Constraints: desktop density first; at narrower widths collapse the evaluation rail into a standard switchable panel without hiding status summaries. Full keyboard focus, non-color state labels, reduced-motion support, loading/empty/error/unknown/active states, and bounded long content are required.
