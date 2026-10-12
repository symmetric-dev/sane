# Annotated canonical-context Word report

Offline Python 3 standard-library tool. No dependencies, native launches, network,
browser, source-file loading or SANE lifecycle calls. Yellow highlighted exact text
is followed/preceded by visible provenance annotations (not Word review comments).
Fixed ZIP metadata makes repeated builds byte-identical.

```sh
python3 packages/sane-app/scripts/context-report/report.py \
  --trace /path/to/context-api.json --evidence /path/to/checks.json \
  --kind live --label 'Local run capture' --output /path/to/report.docx
python3 -m unittest discover -s packages/sane-app/scripts/context-report -p 'test_*.py'
python3 packages/sane-app/scripts/context-report/sample.py /path/to/sample-output
```

`--kind` is required: `live`, `fixture` (test-produced evidence), or `synthetic`
(invented demonstration). This declaration is not independently authenticated.
Output directories must exist. Exit 0 means document generation succeeded, **not**
that checks passed or the model received the context. Missing evidence is rendered
as incomplete/unknown, never synthesized from current repository content.

## Exact input contract

`--trace` accepts the unmodified JSON response of `GET /api/runs/:runId/context`:

```ts
type Trace = {
  schema: 1; runId: string; sessionId: string; status: string;
  records: Array<{
    seq: number; time: string; runId: string; sessionId: string;
    kind: 'context' | 'launch'; data: Context | Launch;
  }>;
};
type Binding = {
  sessionId: string; harness: string; authorityId: string;
  nativeSessionId: string; cwd: string;
};
type Hashes = {
  packageRevision: string; staticHash: string; dynamicHash: string; payloadHash: string;
};
type Segment = {
  id: string; source: string; sha256: string; text: string; reason: string;
  channel: 'standing' | 'dynamic' | 'native-role-reference';
};
type Context = { type: 'canonical-context' } & (
  { stage: 'prepared'; delivery: Hashes & {
    schema: 1; binding: Binding; standing: string; dynamic: string; segments: Segment[];
  }} |
  (Hashes & { stage: 'configured' | 'stored-readback' | 'hook-accepted'; binding: Binding;
    channel: string; dynamicDelivered?: boolean; snapshot?: string })
);
type Launch = {
  harness?: string; resume?: boolean; operation?: string;
  workstreamId?: string; workstreamRoot?: string; implementationRoot?: string;
  agent?: string; nativeAgent?: string; saneContextVersion?: string;
  model?: string; variant?: string; claudeVersion?: string;
  agentFile?: {path: string; sha256: string};
  settings?: {path: string; sha256: string};
  framework?: {path: string; sha256: string};
  sessionBlock?: {path: string; sha256: string};
  executionPolicy?: {
    revision?: string; agent?: string; nativeRoleRegistration?: boolean;
    policyTranslation?: {
      schema: 1; scope: 'native-child-definitions';
      parentPermissions: 'legacy-headless-settings';
      children: Array<{
        canonicalId: string; nativeId: string;
        model: {source: 'pinned' | 'profile' | 'native-inheritance'; value?: string};
        effort: {source: 'pinned' | 'profile' | 'native-inheritance'; value?: string};
        disallowedTools: string[];
        restrictions: Array<{rule: {action: string; resource: string; effect: string};
          tools: string[]; translation: 'whole-tool' | 'conservative-whole-tool'}>;
      }>;
      diagnostics: Array<{agent: string; code: string; message: string;
        rule?: {action: string; resource: string; effect: string}; tools?: string[]}>;
    };
  };
};
```

Optional `--evidence` JSON (all listed strings are producer-supplied; no log blobs):

```ts
type Evidence = {
  schema: 1;
  checks?: Array<{
    id: string; status: 'passed' | 'failed' | 'skipped' | 'incomplete';
    scope: string; evidenceKind: 'live' | 'fixture' | 'synthetic';
    evidenceRef: string; summary: string;
  }>;
  observations?: Array<{
    stage: 'effective-model-request';
    evidenceKind: 'live' | 'fixture' | 'synthetic';
    observer: string; evidenceRef: string; requestId: string;
    runId: string; sessionId: string;
    channel: string; source: string; reason: string;
    text: string; sha256: string;
    binding?: Binding;
    packageRevision?: string; staticHash?: string; dynamicHash?: string; payloadHash?: string;
  }>;
};
```

Observations must have an explicit collector, reference, request ID, classification,
nonblank channel/source/reason/SHA-256, exact text matching that SHA-256,
and matching run/session before their text is accepted. If `binding` is supplied,
every supplied field must match an unambiguous expected value across same-run
canonical trace bindings (sessionId must also match the trace envelope). Conflicting,
unknown, malformed, or unestablished supplied binding fields make the observation
incomplete; its text is omitted. Missing optional binding is not inferred.
A fixture observation stays
labeled fixture even in a report whose primary trace is live. Request text is only
the supplied channel/slice: completeness and authenticity are not inferred.
Unknown fields are omitted recursively; unknown event kinds/stages are flagged.
Bad root schemas fail. Missing optional or evidence fields remain visibly unknown.

Checks summary precedence: failed > incomplete (including unknown statuses, missing
check provenance, or no checks) > skipped > passed. These are reported producer outcomes, independent of
missing request observations and context hash warnings. Hashes are checked over
UTF-8 text; packageRevision is reported, not recomputed without the source package.
`payloadHash` uses `standing + '\n\n' + dynamic`, matching the renderer.

The trace API does not emit effective-request observations. Prepared text,
configuration receipts, native history readback, hook acknowledgement, and launch selection are distinct
from request captures. `native-role-reference` is explicitly **not injected** by
that segment. The report preserves native agent file hashes independently of role
reference hashes. Framework, procedures, assignments, dynamic text and references
are displayed from segment provenance; category labels are heuristics because the
trace segment schema has no asset-kind field.

`hook-accepted` is the CC service's receipt after the exact UserPromptSubmit native
hook response. Its scope is **dynamic only** and requires channel `UserPromptSubmit`
and `dynamicDelivered: true`. It is neither static-context nor effective-request
proof. The report includes event seq/time/run/session, package revision, all receipt
hashes and native binding for correlation; static/payload hashes do not broaden the
acknowledgement's scope. Missing/contradictory acknowledgement fields are incomplete.

Launch `executionPolicy.policyTranslation` is rendered separately as operational
configuration, never context injection or full policy parity. Its recursively
allowlisted fields show child model/effort provenance, disallowed tools and rules.
Diagnostics explain resource-deny widening, nested allowlists disabling Agent,
headless ask conversion, and unavailable child temperature. Unknown root translation
contracts are incomplete and their details are omitted. These receipts do not prove
runtime enforcement. Arbitrary nested fields, tool objects and launch arguments are
never serialized wholesale.
Native capture producers may supply the identical translation schema directly at
`launch.policyTranslation`; this uses the same recursive allowlist and is labeled
as producer capture layout, not an App executionPolicy receipt.

## Data handling and verification

Only fields listed above are exported. In particular launch args, environment,
authentication, stdout/stderr, arbitrary nested objects and check logs are omitted.
Inputs must already exclude secrets from the **allowlisted context text and
metadata**: exact text preservation cannot also redact those fields. This tool is
not a secret scanner. It never dereferences source paths or evidence references.
Protect both input and output files as context-bearing artifacts.

Tests unzip and parse every OOXML part, reconstruct exact highlighted text including
tabs/newlines/CRLF, inspect styles, verify deterministic output, exercise unknown
and mismatched evidence, and test excluded-field leakage. No screenshots needed.
Visual rendering requires a separately available Word/LibreOffice installation;
none was available during implementation, so visual pagination was not verified.

## Interim completed-evidence bundle

`bundle.py --focused DIR --claude DIR --opencode DIR --output DIR` consumes the
completed focused runner's checks/captures plus reporter-compatible native capture
artifacts. It writes two App-authored fixture documents, five Claude native request
documents, one OpenCode **initial-context-only** document, an index and hash manifest.
Actual fixture events retain their own run/session IDs (not the runner envelope ID).
No native events or observations are synthesized. Native captures remain labeled
real harness / mock provider, without semantic model proof. Later OC operations,
full-suite and final merge status remain explicitly incomplete in this interim bundle.
Supply `--opencode-operations DIR` for the subsequent completed native operations
run: adds separate operations and child DOCX files, scopes request observations by
their existing run/session IDs, and updates operations status from the supplied
checks. The earlier initial-only proof stays distinct. Child temperature/tool names
are read only from allowlisted request body fields; no App context source provenance
is invented for the native child. Claude native-child policy proof remains pending. A reported
assertion count not present in the input JSON is identified as user-reported.
If the Claude directory contains upgrade captures, all three upgrade scenarios are
required and added: upgrade, default-snapshot negative control, and upgrade resume.
Their success does not imply Claude native-child verification. If `scout-native`
trace/check files are present, the bundle also renders that separate native-child
proof and its policy diagnostics, and updates the interim status accordingly.
Every resulting ZIP CRC and XML part is validated. The generated index contains the
exact reproduction command and input/output hashes are recorded in the manifest.
