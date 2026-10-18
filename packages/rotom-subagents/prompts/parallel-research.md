---
description: Parallel subagents research
---

Launch parallel research subagents to build a grounded answer to the current question or decision.

Use fresh context, not forked context, unless I explicitly ask for forked context. Scouts should inspect sources directly instead of relying on the main conversation history.

Use `scout` subagents for local codebase context, existing implementation patterns, repo constraints, and files that would be affected. There is no builtin web-research agent: the parent gathers external evidence itself with its own tools, or uses a custom agent that explicitly declares web tools and their `extensions`.

Give each subagent a distinct angle. Unless I specify angles, use these three:

1. External evidence
   Gathered by the parent (or a custom web-research agent): current, authoritative sources such as official docs, specs, release notes, benchmarks, issue threads, or primary explanations.

2. Local code context
   Use `scout` to inspect the repository for relevant files, existing patterns, constraints, tests, and likely integration points.

3. Practical tradeoffs
   Use `scout` to compare options, risks, edge cases, maintenance cost, and what would be easiest to validate.

Adapt the angles when the question calls for it:
- Library/API questions: include official docs and recent examples.
- Architecture decisions: include local module boundaries, dependency direction, and migration cost.
- Debugging questions: include likely failure modes, local call paths, and exact error evidence.
- UI/product questions: include user flow, accessibility, design precedent, and implementation constraints.
- Time-sensitive topics: include a recent-developments angle and prefer 2026/2025 sources.

Prefer two or three strong subagents over many vague ones. The parent agent should frame the question and assign angles; the child agents should research or scout, not invent broad plans.

Ask each subagent to return concise findings with evidence:
- file paths and line ranges for local findings
- source links for external findings
- confidence level and gaps
- recommended next step or decision implication

Do not ask subagents to edit files. This is a research pass only unless I explicitly ask for implementation.

After the subagents return, synthesize the answer into:
- what we know
- what the local codebase implies
- tradeoffs and risks
- gaps or assumptions
- the recommended next move

If findings disagree, call out the disagreement instead of smoothing it over.

$@
