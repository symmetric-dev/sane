# Context-engine branch sync — verified

The experiment branch now includes main-checkout commit `dd87753` through merge
`5cd1e1b`. The main checkout was already clean and committed; it was not modified.
Nothing was pushed, and no production context-delivery switch was made.

## Checkpoints

- `ba3743a`: inactive selective context-engine foundation and focused tests.
- `07fd4db`: isolated mock demo, reports, and raw verification logs.
- `5cd1e1b`: merge all three incoming main commits, preserving both sides.
- `9b90bdb`: experiment runners and audited Grok/dry-check captures.

The merge applied without conflicts. All 83 incoming paths were reviewed: 82
match upstream exactly; `user-input-preparation.ts` additionally retains our
paired-validator extraction. Incoming utility restrictions, title-independent
execution validation, worker policies, and browser/session changes are preserved.

One compatibility correction was necessary: `DemoFixture.agent` now explicitly
describes an assistant, rather than the upstream-expanded identity union that also
includes utility agents. The fixture still creates the same engineering assistant;
this is type-only and changes no production validator or runtime behavior.

## Verification after merging

- **422 focused tests passed**, zero failures, 1,384 assertions across ten files.
- **Zero scoped TypeScript diagnostics across 23 entry files** using cached
  external declarations and worktree workspace sources, not a full-App typecheck.
- All **seven mock scenarios and two damaged-journal replay variants pass**.
- Ordinary continuation: zero context-package loads, two execution loads, four
  durable pairing checks. Fresh-process replay leaves fixture files unchanged.
- Of 456 protected source/evidence files inventoried before the merge, only the
  deliberate fixture type correction differs. Existing reports/captures and the
  four production engine modules are unchanged.
- Read-only upstream/merge audit: no remaining merge-correctness findings.

The first post-merge check passed all runtime checks but found two type errors
from the broader identity union. Its diagnostic output is retained; the final
rerun after the narrow fixture correction passes. No new tests were written, no
full suite/browser/native/model calls were run, and no dependencies were installed.

Exact commands, source hashes, exit statuses, JUnit output and raw final logs are
saved alongside this file in `checks.json`, `tests.junit.xml`, and `*.log`.
`replay-verification.json` records the fresh replay's file-content/mode inventory.

The complete new fixture and verification helper remain at:
`/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-sync.lCZZTE/final/`.
These checks demonstrate the real engine/store/dispatch/journal path with
**simulated transport and acceptance**, not App integration or model behavior.

## Private raw evidence preserved locally

Artifact inspection found no recognizable credentials/private keys, but ten older
CC/Antigravity raw captures contain account-identifying metadata. Rather than
introduce that metadata into Git or rewrite evidence/manifests, these complete
directories remain unchanged and untracked:

- `reports/user-context-experiment-2026-10-25/`
- `reports/user-context-antigravity-2026-10-25/`

Both are also preserved in the local archive:
`/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/context-engine-sync.lCZZTE/private-raw-captures-portable.tar.gz`.
All 238 archived files were compared byte-for-byte by SHA-256 with the originals;
there were no mismatches. See `private-archive-verification.json` for its digest.
The archive is not committed. Existing manifests remain unchanged: the artifact
audit verified all 171 Antigravity and 163 Grok manifest entries locally.

## Integration boundary

The canonical prepared-input reconstruction mismatch is **still present upstream**:
canonical activation references/creation flags and the initial OpenCode `build`
selection do not round-trip through the existing strict codec. Incoming utility
exclusions do not fix it. Correct this contract before routing composed messages
through prepared/queued inputs; do not loosen validation to hide the mismatch.

Then settle bridge-owned trusted selection/readers, native identity finalization,
and synchronous owner-controlled durable evidence before a bounded native cutover.
The merge does not supply these pieces or retire any injector/acknowledgment gate.
