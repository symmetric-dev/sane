# Assistant Context Draft Review

The first editable lifecycle split is now in the source skills and five
top-level assistant files. These are initial drafts for user review.

## Review locations

| Role | Agent | Skills (each directory contains `SKILL.md`) |
| --- | --- | --- |
| Design | `opencode/agents/sane/assistant/design.md` | `skills/sane-assistant-design-{pickup,assistance,delivery}/` |
| Engineering | `opencode/agents/sane/assistant/engineering.md` | `skills/sane-assistant-engineering-{pickup,assistance,delivery}/` |
| Planning | `opencode/agents/sane/assistant/planning.md` | `skills/sane-assistant-planning-{pickup,assistance,delivery}/` |
| Execution | `opencode/agents/sane/assistant/execution.md` | `skills/sane-assistant-execution-{pickup,assistance,delivery}/` |
| Research | `opencode/agents/sane/assistant/research.md` | `skills/sane-assistant-research-{pickup,assistance,delivery}/` |

Agent files retain the existing prose/list style and load only their own
lifecycle skills. Skills provide local working procedures and concrete tool
calls. Artifact structure remains in the document templates.

Execution policy drafts for the next review:

- [Fix and Correction Policy](../../skills/sane-assistant-execution-assistance/resources/FIX_AND_CORRECTION_POLICY.md)
- [Retry Policy](../../skills/sane-assistant-execution-assistance/resources/RETRY_POLICY.md)

The proposed numeric retry defaults await user agreement. Review fix/correction
routing first, then retry sequences and limits.

The five old combined role skills were replaced in source. The context installer
now includes all fifteen lifecycle skills. Existing installed copies are not
automatically removed or rewritten by these source changes.

## Design alignment completed

- Removed the skill-level prohibition on additional headings. Template rules
  now govern headings, including the SDD's decision subheadings.
- Removed the instruction to keep every undefined matter only in conversation.
  Root-template Open Questions instructions now apply; the SDD still excludes
  unresolved material decisions from its Decisions section.
- Removed the agent-only requirement to put the root document revision/hash in
  the SDD. The existing SDD template is the authority for its content.
- Removed Design-initiated live requests for Engineering rework. Engineering's
  delivery starts Planning with `new_session: true`; Design's delivery starts
  Engineering the same way.

## Remaining issues and decisions

1. **Root-template availability:** workstreams copy the root template directly
   into the root document, but retain no separate reusable root template in
   `resources/`. After guidance comments are replaced, later Design sessions may
   lack those instructions. The Pickup draft asks for missing guidance; consider
   supplying a reusable root template alongside the other resource templates.
2. **SDD solution-area timing:** its template requires each area to resolve to a
   spec, although Design finishes before Engineering authors those specs. Decide
   whether a planned path suffices or a stub must already exist.
3. **Execution policies:** checkpoint review/commits and optional Execution-to-
   Grounder Context enrichment are now drafted. Implementer/Reviewer guidance
   and reports capture recommendations and checkpoint evidence. Initial policies
   now live in `skills/sane-assistant-execution-assistance/resources/` as
   `FIX_AND_CORRECTION_POLICY.md` and `RETRY_POLICY.md`. Review their routing,
   sequences, and proposed numeric defaults; Execution asks for limits until
   defaults are adopted.
4. **Live coordination authority:** the Execution draft asks before requesting
   Planning work unless the user's delegation already covers it. Planning may
   amend in-scope work and register jobs. Review whether the user-facing
   delegation procedure needs more specific limits.
5. **Research without an originating request:** the draft asks the user to select
   a recipient. This is a concrete fallback; its formal classification remains
   open. Research also needs review of the boundary between correcting a current
   report and starting a new historical report for later follow-up.
6. **Installed context migration:** the installer preserves old installed skill
   directories. Reinstallation adds the new skills but does not retire the old
   discoverable ones. Choose an explicit migration procedure before rollout;
   existing workstream resource templates also remain their own copies.
7. **Shared context:** `templates/shared/README.md` still provides every role the
   full phase overview and shared lifecycle instructions. Review it against the
   new preference for role-local context. Existing agent permission frontmatter
   was preserved; migration of its compatibility syntax is a separate concern.

The earlier definitions and template documents retain the design discussion;
they are not loaded as operational instructions by these assistants.
