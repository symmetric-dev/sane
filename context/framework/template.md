# Framework context: purpose and authoring conventions

This file is documentation only and is not loaded into agent context. Framework
files are selected by an explicit catalog, not by scanning this directory.

## Files and selection

| File | When its body is supplied |
| --- | --- |
| `core.md` | All SANE assistants and workers. |
| `assistant.md` | Assistants only. |
| `worker-assignment-discipline.md` | Planning and Execution assistants only. |
| `worker-protocol.md` | Workers whose recorded runtime protocol is `explicit-v1`. |
| `branch-continuation.md` | Branches migrated from historical startup instructions, and their descendants. Ordinary canonical forks do not get a new notice. |

The first three files form standing framework context. The last two are static
fragments selected by runtime conditions and appended to the generated Session
block. Their wording comes from the pinned package, not from live source files.

## Author-only notes

Use YAML frontmatter for a file's purpose and any maintenance notes:

```yaml
---
description: A short explanation of what this file is for and who receives it.
notes: |
  Longer author-only notes can go here.
  Explain rationale, ownership, or editing cautions without instructing the agent.
---
```

Frontmatter must include a nonempty `description`. The parser removes the entire
frontmatter block before injection, including `notes` and any other metadata.
The description is retained as package metadata; framework notes and descriptions
are not appended to the instruction body. Only the Markdown below the closing
`---` is instruction text. Framework fragment bodies omit trailing whitespace
when composed so separator formatting remains stable.

The same optional frontmatter convention is supported by worker-procedure files.
Agent definitions and assistant skills already have their own required metadata;
their permissions and other execution fields retain their existing meaning.

## Static instructions versus generated facts

Keep behavioral instructions in these files. Code selects applicable fragments,
pins their parsed bodies, validates bindings, and enforces operations.

Do not embed a particular session's IDs, roots, jobs, waiting state, or message
correlation values here. Those are supplied by generated Assignment and Session
blocks. Procedure-index entries are also generated from pinned package paths.
For path placeholders such as `<workstream>` and `<implementation>`, see
`../worker-procedures/template.md`; they are conventions, not automatic template
substitutions.

New canonical activations snapshot parsed bodies and descriptions. Editing authored
files affects new activations, not existing pinned packages. Historical sessions
keep their original framework; older runtime fragments are recovered from their
recorded context deliveries rather than replaced with today's wording.
