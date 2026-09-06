# SANE Alpha Evaluation Initiative

## Purpose

The Evaluation Initiative collects reliable evidence from real SANE Alpha
sessions so that later SANE phases can identify useful collaboration patterns,
remove unnecessary workflow friction, and build tooling around proven behavior.

This document defines only the **data-collection** part of the initiative. It
does not define quality scoring, pattern analysis, model evaluation, automated
workflow changes, or Beta acceptance criteria. Those are later decisions that
must use the collected evidence rather than assumptions about it.

## Why Session Evidence Is Separate

SANE has three distinct record types:

| Record | Primary purpose | Location |
| --- | --- | --- |
| Workstream artifacts | Historical record of the bounded change: intent, evidence, decisions, approvals, and delivery | Paired workstream repository |
| Project documentation | Practical current-state description of the implementation repository | Implementation repository |
| Session evidence | Experimental trace of how users and agents performed the work | Separate local evidence store |

Session evidence is related to a workstream but is not a governed delivery
artifact and must not become a duplicate project documentation tree. Keeping it
separate also permits distinct retention, access, and privacy controls.

## Initial Data-Collection Outcome

The initial outcome is a **Session Evidence Export Contract** and one or more
manually exported session packages that conform to it.

Each package must be sufficient to link one session to its declared SANE scope,
the artifacts and repository revisions relevant to it, and its reported outcome.
The package preserves evidence; it does not judge the quality of the session.

Initial collection should include successful, blocked, redirected, cancelled,
and incomplete sessions. Collecting only successful sessions would create a
misleading dataset.

## Session Evidence Export Contract

### Raw Native Export

Store the available OpenCode-native session export or source session data without
rewriting it into a summary. When available, this includes user and assistant
messages, tool calls and results, timestamps, and source-session identifiers.

The raw export is immutable after collection. Derived summaries, annotations, or
redactions must be separately identified rather than silently replacing it.

The first implementation must establish which OpenCode session data can be
exported reliably. This initiative does not assume a particular OpenCode file
format or export API.

### Manifest

Every export carries a concise, versioned manifest containing at least:

- exported-session identifier and export-schema version;
- source-session identifier, when available;
- export time and session start/end time, when available;
- selected SANE role agent;
- workstream type explicitly declared by the user;
- normalized workstream-relative path and selected Stage, when applicable;
- stable implementation and workstream repository identifiers or paths;
- model, agent-configuration, and skill-version identifiers when available;
- data completeness, exclusions, and redactions; and
- checksums for raw exported files.

The manifest links evidence to a session without requiring a later analyst to
infer its basic scope from a transcript.

### Outcome Linkage

The manifest or a separately named linkage record identifies:

- workstream artifacts read or changed when that information is available;
- relevant workstream and implementation-repository Git revisions;
- resulting delivered artifacts, reports, or target-repository paths;
- the user-reported delivery, approval, handoff, blocked, redirected, or
  cancelled status; and
- known missing information.

This records provenance, not a claim that the session was correct or successful.

## Collection Boundaries

### User Authority and Consent

Session export is explicit and user-authorized. It must not begin as hidden or
unannounced background collection. The user controls whether a session is
exported, which session scope is included, where it is stored, and when it is
deleted.

### Privacy and Sensitive Data

Session traces can contain credentials, private paths, proprietary code,
customer information, or personal discussion. The collection design must define
exclusion and redaction procedures before routine collection.

By default, evidence belongs in a local ignored evidence store, separate from
both the implementation and workstream repositories. It is not committed or
shared merely because the related workstream is delivered. Retention, access,
export, and deletion rules require an explicit user decision.

### Bounded Context

Collection preserves the trace of a session; it does not require every later
agent to read it. Workstream artifacts remain the normal handoff mechanism.
Historical session evidence may be selected for a specific evaluation question
later, but it is never automatic context for a workstream session.

## Package Shape

The permanent storage layout is intentionally undecided. The initial package
should nevertheless separate raw evidence from metadata and derived material,
for example:

```text
<evidence-store>/
  schema-v1/
    <exported-session-id>/
      manifest.json
      raw/
        <native-session-export>
      derived/
        # optional, explicitly labeled redactions or annotations
```

This is a logical shape, not a requirement to adopt a particular directory or
OpenCode export format.

## Initial Validation

Before claiming useful collection capability, manually validate at least one
complete package:

1. the user explicitly authorizes export;
2. the raw source-session evidence is captured without summary substitution;
3. the manifest identifies the role, user-declared type, workstream scope, and
   relevant repository revisions;
4. the package records its completeness and any exclusions or redactions;
5. checksums verify the stored raw files; and
6. the package can be located and linked to its workstream outcome without
   placing the trace in either repository.

The collection mechanism should be tested with more than one outcome state,
including a blocked or redirected session when safely available.

## Deferred: Analysis and Beta Decisions

Analysis comes after trustworthy collection. Later work may define annotations,
quality criteria, pattern detection, comparisons across roles or workstream
types, and evidence-based changes for a SANE Beta workflow.

No collection record alone determines that a pattern is good, that an agent
performed correctly, or that a workflow should be automated. Those conclusions
require a later user-directed analysis initiative with its own questions,
privacy rules, and decision criteria.
