# Context-evidence report tool

Offline Python 3 standard-library utility that renders supplied canonical-context
evidence as an annotated Word report. It does not contact native services, fetch
source files, or execute a SANE workflow.

## Run

From the repository root, with an existing output directory:

```sh
python3 packages/sane-app/scripts/context-report/report.py \
  --trace /path/to/context-api.json --evidence /path/to/checks.json \
  --kind live --label 'Local run capture' --output /path/to/report.docx
```

`--evidence` is optional. `--kind` is required: `live`, `fixture`, or `synthetic`.
The label/classification is producer-supplied, not independently authenticated.
Exit 0 means report generation succeeded, not that checks passed or a model
received the context. [sample.py](sample.py) can generate synthetic example inputs
and output; [report.py](report.py) owns parsing, field allowlists, and rendering.

## Input interface

`--trace` accepts the unmodified JSON response of `GET /api/runs/:runId/context`:

```ts
type Trace = {
  schema: 1; runId: string; sessionId: string; status: string;
  records: Array<{
    seq: number; time: string; runId: string; sessionId: string;
    kind: 'context' | 'launch'; data: object;
  }>;
};
```

The optional evidence object has `schema: 1` and `checks` and/or `observations`
arrays. Checks supply `id`, `status` (`passed`, `failed`, `skipped`, `incomplete`),
`scope`, `evidenceKind`, `evidenceRef`, and `summary`.

Effective-request observations supply `stage: 'effective-model-request'`,
`evidenceKind`, `observer`, `evidenceRef`, `requestId`, `runId`, `sessionId`,
`channel`, `source`, `reason`, exact `text`, and its UTF-8 `sha256`. IDs and any
optional binding must agree with the trace. Missing or contradictory evidence is
shown as incomplete rather than filled from current source.

Prepared text, configuration, stored readback, hook acknowledgement, and observed
model requests are different evidence stages. A hook receipt is not proof of the
full model request, and mock-provider captures do not establish model compliance.

## Data handling

Only allowlisted fields are rendered, but exact context text and permitted
metadata are **not redacted**. Inputs must already exclude secrets. Protect both
inputs and reports as context-bearing artifacts and review them before sharing.
Evidence references are not dereferenced. Missing evidence is never invented.

[bundle.py](bundle.py) packages supplied focused/native capture directories into
reports, an index, and a hash manifest. Use its `--help` for required paths; this
is an evidence-packaging tool, not a current repository verification status report.
