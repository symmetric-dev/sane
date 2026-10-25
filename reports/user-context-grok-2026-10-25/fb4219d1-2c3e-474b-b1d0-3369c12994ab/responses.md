# Grok user-role context probe

Live: true; complete: true; submissions: 5/5.

## activation

Envelope: raw-json

~~~~text
{"role":"engineering","workstream":"probe-alpha","workstreamRoot":"/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/sane-grok-context-uRgmHy/alpha/workstream","implementationRoot":"/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/sane-grok-context-uRgmHy/alpha/implementation","migrationStrategy":"additive-only"}
~~~~

- PASS: sameSession
- PASS: requestedModelReported
- PASS: noObservedToolCalls
- PASS: jsonObject
- PASS: role
- PASS: workstream
- PASS: workstreamRoot
- PASS: implementationRoot
- PASS: migrationStrategy

## ordinary-followup

Envelope: raw-json

~~~~text
{"artifact":"/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/sane-grok-context-uRgmHy/alpha/workstream/design/solutions/retries.md","migrationStrategy":"additive-only"}
~~~~

- PASS: sameSession
- PASS: requestedModelReported
- PASS: noObservedToolCalls
- PASS: jsonObject
- PASS: artifact
- PASS: migrationStrategy

## context-update

Envelope: raw-json

~~~~text
{"workstream":"probe-beta","artifact":"/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/sane-grok-context-uRgmHy/beta/workstream/design/solutions/retries.md","implementationRoot":"/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/sane-grok-context-uRgmHy/beta/implementation","migrationStrategy":"additive-only"}
~~~~

- PASS: sameSession
- PASS: requestedModelReported
- PASS: noObservedToolCalls
- PASS: jsonObject
- PASS: workstream
- PASS: artifact
- PASS: implementationRoot
- PASS: migrationStrategy

## user-override

Envelope: text

~~~~text
MIGRATION=phased-replacement
~~~~

- PASS: sameSession
- PASS: requestedModelReported
- PASS: noObservedToolCalls
- PASS: exactResponse

## ordinary-after-update

Envelope: raw-json

~~~~text
{"role":"engineering","workstream":"probe-beta","artifact":"/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/sane-grok-context-uRgmHy/beta/workstream/design/solutions/retries.md","implementationRoot":"/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode/sane-grok-context-uRgmHy/beta/implementation","migrationStrategy":"phased-replacement","nextStep":"Draft the retry solution specification with you from the approved design and the solution template before any implementation."}
~~~~

- PASS: sameSession
- PASS: requestedModelReported
- PASS: noObservedToolCalls
- PASS: jsonObject
- PASS: role
- PASS: workstream
- PASS: artifact
- PASS: implementationRoot
- PASS: migrationStrategy
- PASS: nextStepPresent
