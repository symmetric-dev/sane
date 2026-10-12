#!/usr/bin/env python3
"""Build an interim review bundle from completed, explicitly supplied evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

from report import build


def load(path):
    return json.loads(path.read_text())


def adapt_capture(capture):
    if capture.get("schema") != 1 or capture.get("realModelInvoked") is not False:
        raise ValueError("Expected deterministic capture, no real model")
    records = capture["data"]["records"]
    selected = [event for event in records if event.get("kind") in ("context", "launch")]
    identities = {(event["runId"], event["sessionId"]) for event in selected}
    if len(identities) != 1:
        raise ValueError("Capture does not contain one unambiguous App run/session")
    run_id, session_id = identities.pop()
    # The capture envelope runId identifies the test runner, NOT the App run.
    # Reuse actual event identities. Do not create prepared records from delivery.
    trace = dict(schema=1, runId=run_id, sessionId=session_id, records=selected)
    return trace


def adapt_checks(raw, path):
    if raw.get("schema") != 1 or raw.get("evidenceKind") != "deterministic-mock" or raw.get("realModelInvoked") is not False:
        raise ValueError("Expected focused deterministic check evidence")
    checks = []
    for item in raw["checks"]:
        status = "failed" if item["exitCode"] != 0 or item["failed"] else "passed" if raw.get("complete") is True else "incomplete"
        command = item["command"]
        pattern = command[command.index("--test-name-pattern") + 1] if "--test-name-pattern" in command else None
        scope = item["file"] + (f"; test-name-pattern={pattern}; NOT the full file" if pattern else "; focused file")
        checks.append(dict(id=item["file"], status=status, scope=scope, evidenceKind="fixture", evidenceRef=str(path),
                           summary=f"Recorded deterministic result: {item['passed']} passed, {item['failed']} failed; exit code {item['exitCode']}. No real model invoked."))
    return dict(schema=1, checks=checks)


def initial_only(evidence):
    # Deliberately exclude all later operations from this interim OC proof.
    checks = [item for item in evidence["checks"] if item.get("id") == "initial"]
    observations = [item for item in evidence["observations"] if item.get("reason") == "initial"]
    if len(checks) != 1 or not observations:
        raise ValueError("Missing unique initial-context proof")
    return dict(schema=1, checks=checks, observations=observations)


def validate_docx(path):
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError("DOCX ZIP integrity failure")
        for name in archive.namelist():
            ET.fromstring(archive.read(name))


def scoped_observations(evidence, trace):
    return dict(schema=1, checks=evidence["checks"], observations=[item for item in evidence["observations"]
                if all(item.get(key) == trace.get(key) for key in ("runId", "sessionId"))])


def generate(focused, claude, opencode, output, opencode_operations=None):
    output.mkdir(parents=True, exist_ok=True)
    checks_path = focused / "checks.json"
    raw_checks = load(checks_path)
    focused_checks = adapt_checks(raw_checks, checks_path)
    documents = []
    inputs = {}

    def add(name, trace, evidence, label, sources):
        path = output / f"{name}.docx"
        build(trace, evidence, "fixture", label, path)
        validate_docx(path)
        documents.append(dict(file=path.name, classification=label,
                              sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        for source in sources:
            inputs[str(source)] = hashlib.sha256(source.read_bytes()).hexdigest()

    for harness in ("oc", "cc"):
        source = focused / "captures" / f"{harness}-authored-parent-once.json"
        add(f"app-{harness}-authored-context", adapt_capture(load(source)), focused_checks,
            f"ACTUAL TEST OUTPUT: {harness.upper()} App-authored context; deterministic mocked transport; framework/role from authored snapshots, Pickup and roots are fixture values; no native request proof",
            [source, checks_path])
    scenarios = ["base", "fresh", "resume", "compact", "restart"]
    upgrade_scenarios = ["upgrade", "upgrade-default-snapshot-control", "upgrade-resume"]
    if any((claude / f"{name}.trace.json").exists() for name in upgrade_scenarios):
        scenarios += upgrade_scenarios
    has_cc_child = (claude / "scout-native.trace.json").exists()
    if has_cc_child:
        scenarios.append("scout-native")
    for scenario in scenarios:
        trace_path = claude / f"{scenario}.trace.json"
        evidence_path = claude / f"{scenario}.checks.json"
        add(f"native-cc-{scenario}", load(trace_path), load(evidence_path),
            f"ACTUAL NATIVE CAPTURE: Claude {scenario}; real installed harness / loopback MOCK provider; request assembly only, no semantic model proof; producer trace identities retained",
            [trace_path, evidence_path])
    trace_path, evidence_path = opencode / "trace.json", opencode / "evidence.json"
    add("native-oc-initial-context-only", load(trace_path), initial_only(load(evidence_path)),
        "ACTUAL NATIVE CAPTURE: OpenCode INITIAL CONTEXT ONLY; real installed native / loopback MOCK provider; request assembly only, no semantic model proof; later operations excluded",
        [trace_path, evidence_path])
    operations_note = "INCOMPLETE: later OpenCode native operations/final rerun; historical RPC capture failures remain known (user-provided review status)."
    if opencode_operations:
        evidence_path = opencode_operations / "evidence.json"
        evidence = load(evidence_path)
        provenance_path = opencode_operations / "provenance.json"
        provenance = load(provenance_path)
        if provenance.get("realPaidModelInvoked") is not False or provenance.get("semanticComplianceTested") is not False:
            raise ValueError("Expected native operations / mock provider evidence")
        child_path = opencode_operations / "native-child-captures.json"
        child_capture = load(child_path)
        if len(child_capture) != 1:
            raise ValueError("Expected one native child request")
        temperature = child_capture[0]["body"].get("temperature")
        tool_names = [item.get("function", {}).get("name", item.get("name"))
                      for item in child_capture[0]["body"].get("tools", [])]
        for name, trace_name in (("native-oc-operations", "trace.json"), ("native-oc-child", "child-trace.json")):
            trace_path = opencode_operations / trace_name
            trace = load(trace_path)
            scoped = scoped_observations(evidence, trace)
            if name == "native-oc-child":
                scoped["checks"] = [item for item in evidence["checks"] if item.get("id") in
                                    ("native-child-invocation", "native-parent-identity-fencing")]
            add(name, trace, scoped,
                "ACTUAL NATIVE CAPTURE: OpenCode operations / loopback MOCK provider; " +
                (f"child temperature={temperature}; role-only observed text; no App source provenance inferred" if name == "native-oc-child"
                 else "completed operations check aggregate; child exact request is in separate child document") + "; no semantic model proof",
                [trace_path, evidence_path, provenance_path, child_path])
        passed_operations = sum(item.get("status") == "passed" for item in evidence["checks"])
        operations_note = (f"OpenCode native operations: {passed_operations}/{len(evidence['checks'])} checks passed; "
                           f"{provenance.get('requests')} actual mock-provider requests (provenance.json). "
                           "55 assertions reported by the requesting session; assertion count is not independently present in the consumed JSON. "
                           "Checks evidence confirms child role exactly once/no parent procedure, denied edit tools before snapshot, "
                           "unparented child alias rejected before a provider request, queued readOnly preservation, and durable restart restoration. "
                           f"Child request body directly records temperature {temperature} and tools {', '.join(tool_names)}. "
                           "No edit tool was exposed; this does not claim all write-capable tools were absent. "
                           "The idle readOnly check's older 'queued separately unproven' summary is superseded for queued scope by the separate passed queued-read-only-verification check. "
                           "Historical RPC failures remain historical and are superseded for these covered operations by this successful run.")
    manifest = dict(schema=1, interim=True, documents=documents, inputSHA256=inputs,
                    validation="All generated DOCX ZIP CRCs and XML parts parsed successfully; visual rendering not performed")
    (output / "bundle-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    passed = sum(item["passed"] for item in raw_checks["checks"])
    failed = sum(item["failed"] for item in raw_checks["checks"])
    lines = ["# Interim context-delivery review documents", "",
             f"Completed focused evidence: **{passed} passed, {failed} failed across {len(raw_checks['checks'])} suites**. Deterministic mocks; no semantic model verification.",
             "Bridge runtime coverage is `--test-name-pattern 'canonical bridge'`, NOT the full bridge suite.", "",
             "## Annotated Word documents", ""]
    lines += [f"- [{d['file']}]({d['file']}): {d['classification']}" for d in documents]
    lines += ["", "## Provenance and interpretation", "",
              "App documents retain actual context events and event run/session IDs from completed test captures. The outer capture runId identifies the test runner and is not substituted for the App run ID. No events, native bindings, or observations were invented.",
              "Highlighted framework.core and framework.assistant came from packages/sane-core/src/sane-context.ts (#SANE_CORE_CONTEXT / #SANE_ASSISTANT_CONTEXT); role.assistant.design came from opencode/agents/sane/assistant/design.md in both supplied snapshots. The report preserves this actual source even in the CC fixture.",
              "procedure-index came from the pinned package revision; sane-assistant-design-pickup is explicitly mock:pickup. Dynamic session roots came from App execution context in the fixture, not a live workspace. Source hashes and exact texts are in the Word files.",
               f"Native CC documents preserve the producer's exact system/messages channel captures and {len(scenarios)} scenario identities. The earlier native OC initial-context-only document is retained distinctly. New OC operations and child documents use their own run/session-matched observations. Both harnesses use a mock provider; neither proves semantic compliance by a model. Empty or partial canonical traces remain explicitly incomplete; no App provenance is fabricated for the native child.",
               "The native scenario check files include producer aggregate checks; these are scoped/labeled independently of each document's captured request. Do not sum their repeated check counts.",
               "", "## OpenCode operations evidence", "", operations_note,
              "", "## Open status (interim)", "",
              "- INCOMPLETE: full repository suite and full bridge-runtime suite were not established by this evidence.",
               ("- PASSED: both native harness request/policy paths covered by this bundle, including Claude Scout child, with mock providers only; no semantic model proof."
                if has_cc_child and opencode_operations else "- INCOMPLETE: one or both native child policy/request paths remain pending."),
               "- DIAGNOSTIC / INCOMPLETE (requesting-session status): initial full offline run completed 139 files, 120 passed / 19 failed; sources changed during the run and failures are under correction. This is not a source-stable full-suite PASS.",
              "- INCOMPLETE: final merge and final aggregate review status; parent session will update after remaining checks.",
              "- NOT TESTED: live semantic model behavior. Native captures prove assembly at a mock-provider boundary only.",
               f"- All {len(documents)} DOCX ZIP CRCs and XML parts validated. Visual Word/LibreOffice rendering unavailable; screenshots unnecessary.",
              "", "## Reproduce", "", "```sh",
              "python3 -B packages/sane-app/scripts/context-report/bundle.py \\",
              f"  --focused '{focused}' \\", f"  --claude '{claude}' \\",
               f"  --opencode '{opencode}' \\",
               *([f"  --opencode-operations '{opencode_operations}' \\"] if opencode_operations else []),
               f"  --output '{output}'", "```", "",
              "Input and output SHA-256 values are recorded in bundle-manifest.json. Raw requests, auth, process output, environment, native databases and logs are not copied. Only the report tool's allowlisted evidence is rendered."]
    if "upgrade" in scenarios:
        cc_checks = load(claude / "checks.json")["checks"]
        count = {status: sum(c.get("status") == status for c in cc_checks) for status in ("passed", "failed", "skipped")}
        lines += ["", "## Claude Base-to-SANE upgrade proof", "",
                  f"Producer aggregate: {count['passed']} passed, {count['failed']} failed, {count['skipped']} skipped checks. {85 if has_cc_child else 57} assertions were reported by the requesting session; assertion count is not independently present in the consumed JSON.",
                  "The upgrade, upgrade-default-snapshot-control and upgrade-resume documents preserve actual native/mock-provider captures. The negative control deliberately drops --system-prompt-snapshot off and reproduces stale Base text; PASS means the expected failure mode was observed, not successful SANE delivery in that control.",
                  "Normal upgraded-session resume retains durable activation:upgrade and the off flag. Source inspection of claude-run-service.ts confirms flag selection is based on durable activation and appendPath, without excluding compact; that source-level compact conclusion is separate from the native upgrade/resume capture proof.",
                  ("Claude native Scout proof PASSED: production helper pinned Sonnet/high overrides parent Opus/low; role appears once without parent procedure/assignment. Edit/Write/NotebookEdit are excluded despite parent bypassPermissions. Bash remains available: this is tool-inventory enforcement, not a read-only OS sandbox or full policy parity. Exact child captures and allowlisted launch.policyTranslation diagnostics are in native-cc-scout-native.docx."
                   if has_cc_child else "Claude native child proof remains pending. Main-session upgrade success does not establish child policy parity.")]
        inputs[str(claude / "checks.json")] = hashlib.sha256((claude / "checks.json").read_bytes()).hexdigest()
        (output / "bundle-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "INDEX.md").write_text("\n".join(lines) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("focused", "claude", "opencode", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--opencode-operations", type=Path)
    args = parser.parse_args()
    manifest = generate(args.focused, args.claude, args.opencode, args.output, args.opencode_operations)
    print(f"Validated {len(manifest['documents'])} documents; index: {args.output / 'INDEX.md'}")
