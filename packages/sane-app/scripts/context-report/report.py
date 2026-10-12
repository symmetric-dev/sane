#!/usr/bin/env python3
"""Offline, allowlisted canonical-context evidence -> annotated Word report."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
ET.register_namespace("w", W)
STATUSES = ("passed", "failed", "skipped", "incomplete")
BINDING = ("sessionId", "harness", "authorityId", "nativeSessionId", "cwd")
HASHES = ("packageRevision", "staticHash", "dynamicHash", "payloadHash")
LAUNCH = ("harness", "resume", "operation", "workstreamId", "workstreamRoot",
          "implementationRoot", "agent", "nativeAgent", "saneContextVersion",
          "model", "variant", "claudeVersion")


def obj(value):
    return value if isinstance(value, dict) else {}


def seq(value):
    return value if isinstance(value, list) else []


def scalar(value):
    if isinstance(value, (str, bool, int, float)):
        return str(value)
    return "UNKNOWN / missing"


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def xml(tag, parent=None, **attrs):
    attrs = {f"{{{W}}}{key}": str(value) for key, value in attrs.items()}
    return ET.Element(f"{{{W}}}{tag}", attrs) if parent is None else ET.SubElement(parent, f"{{{W}}}{tag}", attrs)


class Document:
    def __init__(self):
        self.root = xml("document")
        self.body = xml("body", self.root)

    def p(self, text, style="Normal", highlight=False):
        # One preserved text node: no trimming, markdown parsing or reflow of evidence.
        if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", text):
            raise ValueError("Evidence contains characters not representable in XML 1.0")
        p = xml("p", self.body)
        xml("pStyle", xml("pPr", p), val=style)
        run = xml("r", p)
        if highlight:
            xml("highlight", xml("rPr", run), val="yellow")
        # Explicit breaks/tabs display correctly in Word while retaining exact text.
        for part in re.split(r"(\n|\t)", text):
            if part == "\n":
                xml("br", run)
            elif part == "\t":
                xml("tab", run)
            elif part:
                node = xml("t", run)
                node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                node.text = part

    def fields(self, data, keys):
        for key in keys:
            self.p(f"{key}: {scalar(obj(data).get(key))}")

    def text(self, value, label):
        self.p(label, "Heading3")
        if isinstance(value, str):
            self.p(f"Computed UTF-8 SHA-256: {digest(value)}")
            self.p(value, "ContextText", True)
        else:
            self.p("INCOMPLETE: exact text unavailable.")

    def write(self, path):
        section = xml("sectPr", self.body)
        xml("pgSz", section, w=12240, h=15840)
        xml("pgMar", section, top=1080, bottom=1080, left=1080, right=1080)
        styles = xml("styles")
        for name, size in (("Normal", 20), ("Title", 36), ("Heading1", 28),
                           ("Heading2", 24), ("Heading3", 22), ("ContextText", 18)):
            style = xml("style", styles, type="paragraph", styleId=name)
            xml("name", style, val=name)
            props = xml("pPr", style)
            xml("spacing", props, after=120)
            if name.startswith("Heading"):
                xml("keepNext", props)
                xml("outlineLvl", props, val=int(name[-1]) - 1)
            rp = xml("rPr", style)
            xml("rFonts", rp, ascii="Consolas" if name == "ContextText" else "Calibri", hAnsi="Consolas" if name == "ContextText" else "Calibri")
            xml("sz", rp, val=size)
        parts = {
            "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
            "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            "word/_rels/document.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
            "word/document.xml": ET.tostring(self.root, encoding="unicode"),
            "word/styles.xml": ET.tostring(styles, encoding="unicode"),
        }
        # Fixed ZIP timestamps and ordering make identical evidence byte-reproducible.
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in sorted(parts.items()):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + content.replace("\r", "&#13;")).encode("utf-8"))


def category(segment):
    identity = scalar(segment.get("id"))
    if segment.get("channel") == "native-role-reference":
        return "role reference (not injected)"
    if identity.startswith("framework."):
        return "framework"
    if identity == "worker-assignment":
        return "assignment"
    if segment.get("channel") == "dynamic":
        return "dynamic context"
    if "procedure" in identity or identity.startswith("sane-assistant-"):
        return "procedure / resource"
    return "role or other asset; category UNKNOWN (API has no kind field)"


def policy_translation(doc, execution):
    """Allowlist operational evidence separately from context text/launch arguments."""
    execution = obj(execution)
    if not execution:
        return
    doc.p("Operational policy translation — separate from context injection", "Heading3")
    doc.fields(execution, ("revision", "agent", "nativeRoleRegistration"))
    policy = obj(execution.get("policyTranslation"))
    doc.fields(policy, ("schema", "scope", "parentPermissions"))
    doc.p("Configured native-child policy translation only. NOT full policy parity, NOT context injection evidence, and NOT proof of runtime enforcement. Parent permissions retain legacy headless settings.")
    if policy.get("schema") != 1 or policy.get("scope") != "native-child-definitions" or policy.get("parentPermissions") != "legacy-headless-settings":
        doc.p("INCOMPLETE: unknown or missing policy translation contract; details omitted.")
        return
    for value in seq(policy.get("children")):
        child = obj(value)
        doc.fields(child, ("canonicalId", "nativeId"))
        for key in ("model", "effort"):
            doc.p(key)
            doc.fields(child.get(key), ("source", "value"))
            if obj(child.get(key)).get("source") == "native-inheritance":
                doc.p("Native inheritance: no explicit value supplied by this translation.")
        doc.p("disallowedTools")
        for tool in seq(child.get("disallowedTools")):
            if isinstance(tool, str):
                doc.p(tool)
        for value in seq(child.get("restrictions")):
            restriction = obj(value)
            doc.fields(restriction, ("translation",))
            doc.fields(restriction.get("rule"), ("action", "resource", "effect"))
            for tool in seq(restriction.get("tools")):
                if isinstance(tool, str):
                    doc.p("Restricted tool: " + tool)
    meanings = {
        "resource-deny-widened": "Conservative restriction: resource denial disables the whole tool, including otherwise allowed resources.",
        "nested-agent-restriction-widened": "Conservative restriction: nested Agent allowlist cannot be enforced; Agent is disabled including allowed exceptions.",
        "headless-ask-to-allow": "Headless limitation: authored ask is not an independent approval boundary; child inherits parent permission mode.",
        "temperature-unavailable": "Unsupported setting: authored child temperature is not applied by Claude --agents.",
    }
    for value in seq(policy.get("diagnostics")):
        diagnostic = obj(value)
        doc.fields(diagnostic, ("agent", "code", "message"))
        doc.p(meanings.get(diagnostic.get("code"), "UNKNOWN diagnostic code; no policy parity inferred.") if isinstance(diagnostic.get("code"), str) else "UNKNOWN diagnostic code")
        if "rule" in diagnostic:
            doc.fields(diagnostic.get("rule"), ("action", "resource", "effect"))
        for tool in seq(diagnostic.get("tools")):
            if isinstance(tool, str):
                doc.p("Diagnostic tool: " + tool)


def checks_summary(checks):
    counts = {status: 0 for status in STATUSES}
    for check in checks:
        status = obj(check).get("status")
        if status != "failed" and not check_complete(obj(check)):
            status = "incomplete"
        counts[status if status in STATUSES else "incomplete"] += 1
    overall = ("failed" if counts["failed"] else "incomplete" if not checks or counts["incomplete"]
               else "skipped" if counts["skipped"] else "passed")
    return overall, counts


def check_complete(check):
    return (check.get("evidenceKind") in ("synthetic", "fixture", "live")
            and all(isinstance(check.get(key), str) and check[key] for key in ("id", "scope", "evidenceRef", "summary")))


def observation_binding_matches(observation, trace):
    """Compare every supplied binding field against unambiguous same-run evidence."""
    if "binding" not in observation:
        return True
    binding = observation["binding"]
    if not isinstance(binding, dict):
        return False
    expected = {key: set() for key in BINDING}
    if isinstance(trace.get("sessionId"), str):
        expected["sessionId"].add(trace["sessionId"])
    for value in trace["records"]:
        event = obj(value)
        if any(not trace.get(key) or event.get(key) != trace[key] for key in ("runId", "sessionId")):
            continue
        data = obj(event.get("data"))
        if event.get("kind") != "context" or data.get("type") != "canonical-context":
            continue
        if data.get("stage") not in ("prepared", "configured", "stored-readback", "hook-accepted"):
            continue
        delivery = obj(data.get("delivery")) if data.get("stage") == "prepared" else data
        for key, value in obj(delivery.get("binding")).items():
            if key in expected and isinstance(value, str) and value:
                expected[key].add(value)
    return all(key in expected and isinstance(value, str) and bool(value)
               and expected[key] == {value} for key, value in binding.items())


def build(trace, supplement, evidence_kind, label, output):
    if obj(trace).get("schema") != 1 or not isinstance(trace.get("records"), list):
        raise ValueError("Trace requires schema: 1 and records: []")
    if supplement is not None and obj(supplement).get("schema") != 1:
        raise ValueError("Supplement requires schema: 1")
    supplement = obj(supplement)
    doc = Document()
    doc.p("Canonical context verification", "Title")
    doc.p(f"Evidence class: {evidence_kind.upper()} — {label}", "Heading1")
    doc.p("Fixture evidence is not a live result. Evidence classification and check outcomes are supplied by the producer; this offline report does not attest collection authenticity.")
    doc.p("Prepared = rendered locally; configured = transport setup; stored-readback = persisted native history; hook-accepted = dynamic-only UserPromptSubmit native hook acknowledgement. None proves inclusion in an effective model request. Native launch metadata records selection/configuration, not the model's consumed role text.")
    doc.fields(trace, ("runId", "sessionId", "status"))
    checks = seq(supplement.get("checks"))
    overall, counts = checks_summary(checks)
    doc.p("Checks summary", "Heading1")
    doc.p(f"Reported checks: {overall.upper()} (not a context-delivery verdict)")
    doc.p("; ".join(f"{key}: {value}" for key, value in counts.items()))
    if not checks:
        doc.p("INCOMPLETE: no check evidence supplied.")
    for item in checks:
        check = obj(item)
        doc.fields(check, ("id", "status", "scope", "evidenceKind", "evidenceRef", "summary"))
        if check.get("status") not in STATUSES:
            doc.p("INCOMPLETE: unknown check status.")
        if not check_complete(check):
            doc.p("INCOMPLETE: check evidence metadata missing; a claimed pass is not counted as passed.")
    doc.p("Canonical trace: prepared / configured / stored-readback / hook-accepted", "Heading1")
    canonical_count = launch_count = 0
    for index, value in enumerate(trace["records"]):
        event = obj(value)
        if event.get("kind") not in ("context", "launch"):
            doc.p(f"Record {index}: unsupported event omitted; evidence UNKNOWN.")
            continue
        doc.p(f"Record {index}: {event['kind']}", "Heading2")
        doc.fields(event, ("seq", "time", "runId", "sessionId"))
        if any(event.get(key) != trace.get(key) or not trace.get(key) for key in ("runId", "sessionId")):
            doc.p("INCOMPLETE: missing or mismatched event binding; payload omitted.")
            continue
        data = obj(event.get("data"))
        if event["kind"] == "launch":
            launch_count += 1
            doc.p("Native launch metadata — configured/selected only", "Heading3")
            doc.fields(data, LAUNCH)
            policy_translation(doc, data.get("executionPolicy"))
            if "policyTranslation" in data:
                doc.p("Producer capture layout: launch.policyTranslation (not an App executionPolicy receipt).")
                policy_translation(doc, {"policyTranslation": data["policyTranslation"]})
            for key in ("agentFile", "settings", "framework", "sessionBlock"):
                doc.p(key)
                doc.fields(data.get(key), ("path", "sha256"))
            continue
        if data.get("type") != "canonical-context":
            doc.p("UNKNOWN: unsupported context event type; payload omitted.")
            continue
        canonical_count += 1
        stage = data.get("stage")
        doc.fields(data, ("stage", "channel", "dynamicDelivered", "snapshot"))
        if stage not in ("prepared", "configured", "stored-readback", "hook-accepted"):
            doc.p("UNKNOWN: unsupported stage; not accepted as effective-request evidence.")
            continue
        delivery = obj(data.get("delivery")) if stage == "prepared" else data
        doc.fields(delivery, HASHES)
        doc.p("Binding", "Heading3")
        doc.fields(delivery.get("binding"), BINDING)
        if obj(delivery.get("binding")).get("sessionId") != trace.get("sessionId"):
            doc.p("INCOMPLETE: delivery session binding missing or mismatched.")
        if stage != "prepared":
            if stage == "hook-accepted":
                doc.p("Dynamic-only acknowledgement stage: records acceptance of the exact UserPromptSubmit native hook response when acknowledgement fields are valid. NOT static-context delivery proof; NOT effective model-request proof. Hashes and binding above correlate the prepared package; staticHash/payloadHash do not expand the acknowledged scope.")
                if data.get("channel") != "UserPromptSubmit" or data.get("dynamicDelivered") is not True:
                    doc.p("INCOMPLETE: hook acknowledgement requires channel UserPromptSubmit and dynamicDelivered true.")
            doc.p("Receipt only: exact context text is not present in this record; no request observation inferred.")
            continue
        for key, hash_key in (("standing", "staticHash"), ("dynamic", "dynamicHash")):
            doc.text(delivery.get(key), f"Exact prepared {key} transport text (came from renderer; see segments below)")
            text = delivery.get(key)
            doc.p(f"{hash_key} integrity: " + ("MATCH" if isinstance(text, str) and digest(text) == delivery.get(hash_key) else "UNKNOWN / MISMATCH"))
        standing, dynamic = delivery.get("standing"), delivery.get("dynamic")
        doc.p("payloadHash integrity: " + ("MATCH" if isinstance(standing, str) and isinstance(dynamic, str) and digest(standing + "\n\n" + dynamic) == delivery.get("payloadHash") else "UNKNOWN / MISMATCH"))
        segments = seq(delivery.get("segments"))
        if not segments:
            doc.p("INCOMPLETE: segment provenance unavailable.")
        for item in segments:
            segment = obj(item)
            doc.p(f"Segment: {scalar(segment.get('id'))} — {category(segment)}", "Heading3")
            doc.p(f"Came from {scalar(segment.get('source'))}")
            doc.p(f"Why included: {scalar(segment.get('reason'))}")
            doc.fields(segment, ("channel", "sha256"))
            if segment.get("channel") == "native-role-reference":
                doc.p("REFERENCE ONLY: authored role reference was NOT injected by this segment. Actual native definition may differ; compare launch agentFile hash where available.")
            doc.text(segment.get("text"), "Exact source segment text")
            text = segment.get("text")
            doc.p("Source hash integrity: " + ("MATCH" if isinstance(text, str) and digest(text) == segment.get("sha256") else "UNKNOWN / MISMATCH"))
    if not canonical_count:
        doc.p("INCOMPLETE: no canonical context records.")
    if not launch_count:
        doc.p("INCOMPLETE: native launch metadata unavailable.")
    doc.p("Effective model-request observations (separate evidence)", "Heading1")
    observations = seq(supplement.get("observations"))
    if not observations:
        doc.p("NOT OBSERVED: no effective model-request evidence supplied. Prepared/configured/stored-readback/hook-accepted cannot fill this gap.")
    for item in observations:
        observation = obj(item)
        valid = (observation.get("stage") == "effective-model-request"
                 and observation.get("evidenceKind") in ("synthetic", "fixture", "live")
                 and all(isinstance(observation.get(k), str) and observation[k].strip() for k in ("observer", "evidenceRef", "requestId", "channel", "source", "reason", "sha256"))
                 and isinstance(observation.get("text"), str)
                 and observation.get("sha256") == digest(observation["text"])
                 and observation_binding_matches(observation, trace)
                 and all(observation.get(k) == trace.get(k) and trace.get(k) for k in ("runId", "sessionId")))
        doc.p("Observation: " + ("producer-declared request capture" if valid else "INCOMPLETE / ambiguous; not accepted as a request observation"), "Heading2")
        doc.fields(observation, ("stage", "evidenceKind", "observer", "evidenceRef", "requestId", "runId", "sessionId", "channel", "source", "reason", "sha256"))
        doc.fields(observation, HASHES)
        doc.fields(observation.get("binding"), BINDING)
        if not valid:
            doc.p("INCOMPLETE: required capture metadata/text/hash is missing or invalid, outer IDs disagree, or supplied binding contradicts/is not established unambiguously by the trace. Capture text omitted.")
        if valid:
            doc.text(observation.get("text"), "Exact observed request text (only the supplied channel/slice; no completeness inferred)")
            text = observation.get("text")
            doc.p("Observation hash integrity: " + ("MATCH" if isinstance(text, str) and digest(text) == observation.get("sha256") else "UNKNOWN / MISMATCH"))
    doc.write(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trace", required=True, type=Path)
    parser.add_argument("--evidence", type=Path, help="Optional checks and effective-request observations JSON")
    parser.add_argument("--kind", required=True, choices=("synthetic", "fixture", "live"))
    parser.add_argument("--label", required=True, help="Human-readable evidence origin")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        build(json.loads(args.trace.read_text()), json.loads(args.evidence.read_text()) if args.evidence else None,
              args.kind, args.label, args.output)
    except (ValueError, OSError) as error:
        print(f"Report failed: {type(error).__name__}; check input schema, XML characters and file paths.", file=sys.stderr)
        return 1
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
