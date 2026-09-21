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

Retry now covers mechanical worker failures only; its default limit awaits user
agreement. Implementation assessment and correction routing belong in the Fix
and Correction Policy.

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
   lack those instructions. The Pickup draft asks for missing guidance. One option
   is to copy the type's root template to `resources/ROOT_TEMPLATE.md` during
   bootstrap. The user is also considering keeping artifact templates with their
   owning skills, like the Execution policies, instead of a template collection
   copied into each workstream's `resources/` directory. Neither option is
   implemented yet.

   Skill-local templates would keep authoring instructions beside the procedure
   that uses them and make updates available through context installation. Before
   choosing this layout, decide which skill owns each template, how workers and
   CLI commands resolve it, and whether existing workstreams use current templates
   or retain a pinned version. Bootstrap, `sane provide`, and job context bundles
   currently use the shared template/resource layout and would need reconciliation.
2. **SDD solution-area timing — resolved:** Design lists solution areas, intended
   outcomes, and boundaries without file references or spec lifecycle status.
   Engineering authors the corresponding specs later. The SDD template now
   reflects this distinction.
3. **Execution policies:** checkpoint review/commits and optional Execution-to-
   Grounder Context enrichment are now drafted. Implementer/Reviewer guidance
   and reports capture recommendations and checkpoint evidence. Initial policies
   now live in `skills/sane-assistant-execution-assistance/resources/` as
   `FIX_AND_CORRECTION_POLICY.md` and `RETRY_POLICY.md`. Review their routing,
   sequences, and attempt limits. Retry covers mechanical failures; correction
   limits are separate. Execution asks for limits when none were supplied.
4. **Live coordination authority:** the Execution draft asks before requesting
   Planning work unless the user's delegation already covers it. Planning may
   amend in-scope work and register jobs. Review whether the user-facing
   delegation procedure needs more specific limits.
5. **Research without an originating request:** the draft asks the user to select
   a recipient. This is a concrete fallback; its formal classification remains
   open. Research also needs review of the boundary between correcting a current
   report and starting a new historical report for later follow-up.
6. **Installed context migration — implemented:** successful installation removes
   the five retired combined-role skill directories and reports the removals.
   Dry-run reports planned removals without changing files. Unrelated installed
   skills are preserved. Existing workstream resource templates remain their own
   copies and are not refreshed by context installation.
7. **Shared context — updated:** `templates/shared/README.md` now keeps a short
   Pickup, Assistance, and Delivery flow, with approval and handoff in the
   relevant steps. Detailed procedures remain role-local. Existing agent
   permission frontmatter was preserved; migration of its compatibility syntax
   is a separate concern.

The earlier definitions and template documents retain the design discussion;
they are not loaded as operational instructions by these assistants.
