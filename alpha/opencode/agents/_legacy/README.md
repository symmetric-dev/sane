# Legacy assistant agents (superseded by SANE 0.2.0)

Stage-era agents, preserved for history only. Do not install or follow them.

- `sane-assistant-product.md` — Product phase retired; root docs moved to Design.
- `sane-assistant-coordination.md` — renamed to `sane-assistant-execution.md`.
- `sane-assistant-design.md`, `sane-assistant-engineering.md`,
  `sane-assistant-planning.md`, `sane-assistant-research.md` — Stage-scoped
  (`design/stages/*`, `execution/stages/*`, `research/stage-NN/*`); the new
  single-scope versions live in `opencode/agents/sane/assistant/` (short names:
  `design.md`, `engineering.md`, `planning.md`, `execution.md`, `research.md`).

Workers (`sane/worker/*.md`) are unchanged in contract and stay in
`opencode/agents/sane/worker/` (short names: `fixer.md`, `grounder.md`,
`implementer.md`, `researcher.md`, `reviewer.md`, `scout.md`). Agent IDs are
path-derived (`sane/assistant/design`, `sane/worker/scout`).
