# Coverage plan — prompt-based context, operational hooks retained

Coverage disposition for the [shared context contract](shared-context.md) and [performance acceptance criteria](performance.md#acceptance-criteria-for-the-ordinary-worker-message-path). Test descriptions identify coverage by behavior, not audit-era line numbers or estimated counts. Scope and execution constraints are in [PLAN.md](PLAN.md).

## Scenario matrix

Cover assistant/worker activation, ordinary continuation, explicit update, sharing to new/existing recipients, branch inheritance, and new-model resume/restart. Across those cases verify exact selected bytes/body presentation, trusted validation, dispatch/settlement evidence, retained operational hooks, and absence of retired delivery mechanisms. Keep native compact lifecycle tests; compaction preservation/recovery is not part of this matrix.

## `claude-run-service.test.ts`

| Original coverage | Disposition |
| --- | --- |
| Authored parent role occurs once | REWRITE: role occurs once in bootstrap prompt; no duplicated selected main-role prompt in native definitions. Keep native-child definitions. |
| Assistant/worker × new/resume/upgrade/compact static-delivery matrix | REWRITE around activation, ordinary resume, and explicit updates; no per-turn context assertions. Delete upgrade-migration cases; retain compact lifecycle coverage. |
| Persisted upgrade snapshot-off behavior | DELETE: append-file migration/snapshot workaround is removed. |
| Missing/mismatched/foreign dynamic hook never accepted | DELETE context-ack cases; hook ingestion authentication/association tests remain. |
| Foreign binding, selected dynamic change, cancellation | KEEP guarantees; adapt to context-bearing prompt validation and new evidence names. |
| Base isolation | KEEP no canonical context/provider use for Base; ordinary body transport still works. |
| Trusted provider validation required | KEEP trusted composition guarantee for context-bearing messages; adapt API, not unconditional per-run provider use. |
| Journal/flags/credentials order, hook keys, forward.ts Stop | KEEP operational registration/authentication/order; change context-file/flag expectations only. |
| Framework SessionStart success/failure enforcement | DELETE obsolete context-hook enforcement; cover pre-send composition failure instead. |
| Terminal DTO cannot mint settlement proof | KEEP lifecycle/integrity proof; remove only the obsolete framework-rejection arm. |
| Fresh source validation across async stages | REWRITE stage list: remove context-file/injector stages; retain settings/permissions and surviving source/cancellation checks. |
| Hook auth/journal errors/secret lifetime, stream drainage, borrowed credentials | KEEP: forwarding and authenticated operational ingestion remain. |
| Legacy new-session hook fixture | REWRITE operational parts for new-model sessions; DELETE only legacy context-injector assertions. |

Keep queued-followup Stop/task-notification eligibility, drain-after-owner-settlement, activity/background-job observations, supervision, termination, result identity/index/integrity, and source pins. Removing context hooks does not require a stdout-only turn-completion redesign.

## `opencode-run-service.test.ts`

- Authored parent role and delivery matrix: REWRITE for the scenario matrix. Keep execution-policy RPC/child/model/permission assertions.
- Missing trusted validation: KEEP for selected context-bearing messages, with the new composition API.
- Foreign binding/dynamic change/cancelled faults: KEEP their guarantees for selected content; DELETE storage readback-mismatch/lost-write-ack faults.
- Base isolation: KEEP; no canonical context lookup or injected payload.
- Acknowledged creation framework delivery: DELETE the ack-map/storage assumptions; cover new-model composition/submission evidence without a parallel delivery stage machine.
- Keep queue, retry/recovery, cancellation, exact command admission, uncertainty/no-resend, prompt ordering, compact transport/lifecycle, and interrupt coverage. Removing entry-equality 409 does not remove binding or ownership validation.

## Other coverage

- `native-context-entry.test.ts`: DELETE with `deliverContextEntry`; no instruction-entry read/write/readback or migration behavior remains.
- `branch-context.test.ts`: replace inherited-entry reads with new-model inherited-context/branch placement; retain relevant pure branch-content checks and remove old upgrade/migration guidance.
- `opencode-native-queue.test.ts`: replace retired delivery-method assertions with no accidental context bootstrap/mutation under unknown policy. Keep preflight, configuration/binding, queue ownership, admission, and no-replay assertions; delete metadata-binding compatibility cases.
- Completion/queue fixtures: remove `takeFrameworkDelivery` / sink-only `saneSession` stubs when those APIs disappear. Do not otherwise rewrite unrelated coverage.
- `tests/context-foundations.test.ts`, bridge-runtime coverage, review/context-report tests, and canonical capture integration: replace old context receipts/sidecars/snapshots with the single new prompt model. Delete legacy-only negatives/parity fixtures; preserve trusted-input and role/permission isolation checks.
- Keep `opencode-retry-projection.test.ts` and operational hook consumers' coverage unless an assertion specifically pins retired context injection.
- Shared composition/body extraction: plan focused cases for exact selected bytes, ordinary follow-up pass-through, classification/display correctness, and no double-prefix across bridge/run-service boundaries.
- Performance regressions: count the eliminated operations defined in `performance.md` across the complete dispatch path, including `canonicalExecution` / `validateCanonicalActivation`, rather than using brittle elapsed-time thresholds. Distinguish activation, ordinary continuation, and selected updates; verify retained operational hooks still run. Timing/fan-out benchmarks are separate from these focused regression checks.
