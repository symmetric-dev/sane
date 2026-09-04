# SANE Alpha Document Templates

These are source templates for the manual SANE Alpha workflow. They are not all
copied when a workstream is bootstrapped: a role or SANE repository-initialization
command copies or references the template for the artifact it is about to create.

HTML comments are authoring guidance. Assistants replace or remove them with
workstream-specific content before delivering an artifact, while preserving the
required heading structure.

| Template | Created at | Owning role | V2 contract |
| --- | --- | --- | --- |
| `repository/paths` | `<implementation-repository>/.sane/paths` | SANE repository initialization | — |
| `PRD.md` | `<workstream>/PRD.md` | Product | `PRODUCT_REQUIREMENTS_DOCUMENT_DEFINITION.md` |
| `research/INDEX.md` | `<workstream>/research/INDEX.md` | Research | `RESEARCH_INDEX_DEFINITION.md` |
| `research/TECH_BRIEF.md` | `<workstream>/research/TECH_BRIEF.md` | Research | `RESEARCH_INDEX_DEFINITION.md` |
| `design/SPEC.md` | `<workstream>/design/SPEC.md` | Design | `ROOT_DESIGN_DOCUMENT_DEFINITIONS.md` |
| `design/STAGES.md` | `<workstream>/design/STAGES.md` | Design | `ROOT_DESIGN_DOCUMENT_DEFINITIONS.md` |
| `design/stage/SPEC.md` | `<workstream>/design/stages/<id>-<slug>/SPEC.md` | Design | `STAGE_DOCUMENT_DEFINITIONS.md` |
| `design/stage/SECTIONS.md` | `<workstream>/design/stages/<id>-<slug>/SECTIONS.md` | Engineering | `STAGE_DOCUMENT_DEFINITIONS.md` |
| `design/section/SPEC.md` | `<workstream>/design/stages/<id>-<slug>/sections/<id>-<slug>.md` | Engineering | `SECTION_TECHNICAL_DESIGN_DEFINITION.md` |
| `execution/EXECUTION_PLAN.md` | `<workstream>/execution/stages/<id>-<slug>/EXECUTION_PLAN.md` | Execution | `EXECUTION_DOCUMENT_DEFINITIONS.md` |
| `execution/JOB.md` | `<workstream>/execution/stages/<id>-<slug>/jobs/<id>-<slug>.md` | Execution | `EXECUTION_DOCUMENT_DEFINITIONS.md` |
| `implementation/REPORT.md` | `<workstream>/implementation/reports/<id>-<slug>/<id>-<slug>.md` | Implementation | `IMPLEMENTATION_REPORT_DEFINITION.md` |

`SANE_CONTEXT.md` and `SANE_STATE.md` are initial-workstream templates. The
bootstrap command will copy them together with `PRD.md`.
