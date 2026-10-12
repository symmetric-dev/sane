import copy
import tempfile
import unittest
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

from report import W, build, checks_summary, digest


def fixture():
    segments = []
    for identity, channel, text in (
        ("framework.core", "standing", "  Synthetic framework <&>\n\tline\r\n"),
        ("worker-procedure.scout", "standing", "Synthetic procedure"),
        ("worker-assignment", "standing", "Synthetic assignment"),
        ("role.scout", "native-role-reference", "Synthetic role reference"),
        ("session", "dynamic", "Synthetic dynamic context"),
    ):
        segments.append(dict(id=identity, channel=channel, text=text, source="synthetic:" + identity,
                             reason="Synthetic test coverage", sha256=digest(text)))
    standing = "\n\n".join(s["text"] for s in segments if s["channel"] == "standing")
    dynamic = segments[-1]["text"]
    delivery = dict(schema=1, binding=dict(sessionId="fixture-session", harness="fixture", authorityId="fixture-authority",
                                         nativeSessionId="fixture-native", cwd="/synthetic"), packageRevision="synthetic-revision",
                    standing=standing, dynamic=dynamic, staticHash=digest(standing), dynamicHash=digest(dynamic),
                    payloadHash=digest(standing + "\n\n" + dynamic), segments=segments)
    def event(kind, data, index):
        return dict(kind=kind, runId="fixture-run", sessionId="fixture-session", seq=index, time="synthetic", data=data)
    records = [event("context", dict(type="canonical-context", stage="prepared", delivery=delivery), 1)]
    for index, stage in enumerate(("configured", "stored-readback"), 2):
        receipt = {k: delivery[k] for k in ("binding", "packageRevision", "staticHash", "dynamicHash", "payloadHash")}
        records.append(event("context", dict(type="canonical-context", stage=stage, channel="synthetic-transport", **receipt), index))
    records.append(event("launch", dict(harness="fixture", agent="synthetic-scout", agentFile=dict(path="/synthetic/role.md", sha256=digest("different native definition"))), 4))
    return dict(schema=1, runId="fixture-run", sessionId="fixture-session", status="synthetic-only", records=records)


class ReportTests(unittest.TestCase):
    def render(self, trace, evidence=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.docx"
            build(trace, evidence, "synthetic", "unit fixture", path)
            data = path.read_bytes()
            with zipfile.ZipFile(path) as archive:
                for name in archive.namelist():
                    ET.fromstring(archive.read(name))
                root = ET.fromstring(archive.read("word/document.xml"))
                styles = ET.fromstring(archive.read("word/styles.xml"))
            return data, root, styles

    def text(self, root):
        return "\n".join(node.text or "" for node in root.iter(f"{{{W}}}t"))

    def test_exact_highlighted_text_styles_and_reproducibility(self):
        trace = fixture()
        data, root, styles = self.render(trace)
        self.assertEqual(data, self.render(trace)[0])
        highlighted = []
        for run in root.iter(f"{{{W}}}r"):
            if run.find(f"{{{W}}}rPr/{{{W}}}highlight") is not None:
                highlighted.append("".join("\n" if n.tag == f"{{{W}}}br" else "\t" if n.tag == f"{{{W}}}tab" else n.text or "" for n in run if n.tag != f"{{{W}}}rPr"))
        delivery = trace["records"][0]["data"]["delivery"]
        for text in [delivery["standing"], delivery["dynamic"]] + [s["text"] for s in delivery["segments"]]:
            self.assertIn(text, highlighted)
        self.assertIn("ContextText", [s.get(f"{{{W}}}styleId") for s in styles])
        text = self.text(root)
        for phrase in ("NOT injected", "NOT OBSERVED", "Came from synthetic:", "Source hash integrity: MATCH", "stored-readback", "agentFile"):
            self.assertIn(phrase, text)

    def test_missing_unknown_mismatch(self):
        trace = fixture()
        trace["records"][0]["data"]["delivery"]["segments"][0]["sha256"] = "bad"
        trace["records"][1]["sessionId"] = "wrong"
        trace["records"][2]["data"]["stage"] = "effective-model-request"
        text = self.text(self.render(trace)[1])
        self.assertIn("Source hash integrity: UNKNOWN / MISMATCH", text)
        self.assertIn("mismatched event binding; payload omitted", text)
        self.assertIn("unsupported stage", text)
        empty = self.text(self.render(dict(schema=1, records=[]))[1])
        for phrase in ("no check evidence", "no canonical context", "native launch metadata unavailable", "NOT OBSERVED"):
            self.assertIn(phrase, empty)

    def test_allowlist_excludes_arbitrary_objects_and_launch_args(self):
        trace = fixture()
        trace["secret"] = "SECRET_SENTINEL"
        for event in trace["records"]:
            event["data"].update(env={"TOKEN": "SECRET_SENTINEL"}, args=["SECRET_SENTINEL"], stderr="SECRET_SENTINEL", auth="SECRET_SENTINEL")
        trace["records"][-1]["data"]["model"] = {"unknown": "SECRET_SENTINEL"}
        evidence = dict(schema=1, checks=[dict(id="check", status="passed", logs="SECRET_SENTINEL")])
        self.assertNotIn("SECRET_SENTINEL", self.text(self.render(trace, evidence)[1]))

    def test_observation_binding_and_fixture_label(self):
        observation = dict(stage="effective-model-request", evidenceKind="fixture", observer="test capture",
                           evidenceRef="test:one", requestId="req", runId="fixture-run", sessionId="fixture-session",
                           channel="system", source="fixture capture", reason="test", text="captured text", sha256=digest("captured text"))
        evidence = dict(schema=1, observations=[observation])
        text = self.text(self.render(fixture(), evidence)[1])
        self.assertIn("producer-declared request capture", text)
        self.assertIn("evidenceKind: fixture", text)
        observation["runId"] = "wrong"
        text = self.text(self.render(fixture(), evidence)[1])
        self.assertIn("not accepted as a request observation", text)
        self.assertNotIn("captured text", text)

    def test_check_summary_and_bad_input(self):
        for status in ("passed", "failed", "skipped", "incomplete"):
            self.assertEqual(checks_summary([dict(status=status, id="check", scope="unit", evidenceKind="fixture", evidenceRef="test", summary="outcome")])[0], status)
        self.assertEqual(checks_summary([dict(status="passed")])[0], "incomplete")
        self.assertEqual(checks_summary([])[0], "incomplete")
        self.assertEqual(checks_summary([dict(status="invented")])[0], "incomplete")
        with self.assertRaises(ValueError):
            self.render(dict(schema=2, records=[]))

    def test_observation_rejects_every_conflicting_binding_identity(self):
        trace = fixture()
        binding = trace["records"][0]["data"]["delivery"]["binding"]
        observation = dict(stage="effective-model-request", evidenceKind="fixture", observer="test capture",
                           evidenceRef="test:binding", requestId="req", runId="fixture-run", sessionId="fixture-session",
                           channel="system", source="fixture capture", reason="test", text="unique observed capture",
                           sha256=digest("unique observed capture"), binding=copy.deepcopy(binding))
        def render(value, source=trace):
            return self.text(self.render(source, dict(schema=1, observations=[value]))[1])
        self.assertIn("producer-declared request capture", render(observation))
        for key in binding:
            with self.subTest(key=key):
                bad = copy.deepcopy(observation)
                bad["binding"][key] = "other-identity"
                text = render(bad)
                self.assertIn("not accepted as a request observation", text)
                self.assertNotIn("unique observed capture", text)
        ambiguous = copy.deepcopy(trace)
        ambiguous["records"][1]["data"]["binding"]["nativeSessionId"] = "another-native"
        self.assertNotIn("producer-declared request capture", render(observation, ambiguous))
        unavailable = dict(schema=1, runId="fixture-run", sessionId="fixture-session", records=[])
        self.assertNotIn("producer-declared request capture", render(observation, unavailable))

    def test_observation_requires_complete_metadata_and_correct_hash(self):
        observation = dict(stage="effective-model-request", evidenceKind="fixture", observer="test capture",
                           evidenceRef="test:contract", requestId="req", runId="fixture-run", sessionId="fixture-session",
                           channel="system", source="fixture capture", reason="test", text="private capture",
                           sha256=digest("private capture"))
        for key in ("channel", "source", "reason", "sha256"):
            for replacement in (None, "", "  "):
                with self.subTest(key=key, value=replacement):
                    bad = dict(observation, **{key: replacement})
                    text = self.text(self.render(fixture(), dict(schema=1, observations=[bad]))[1])
                    self.assertIn("not accepted as a request observation", text)
                    self.assertNotIn("private capture", text)
        observation["sha256"] = "0" * 64
        text = self.text(self.render(fixture(), dict(schema=1, observations=[observation]))[1])
        self.assertNotIn("producer-declared request capture", text)

    def test_hook_accepted_is_dynamic_only_with_correlated_receipt(self):
        trace = fixture()
        receipt = copy.deepcopy(trace["records"][1])
        receipt["seq"] = 5
        receipt["data"].update(stage="hook-accepted", channel="UserPromptSubmit", dynamicDelivered=True)
        trace["records"].append(receipt)
        text = self.text(self.render(trace)[1])
        for phrase in ("stage: hook-accepted", "Dynamic-only acknowledgement", "NOT static-context delivery proof",
                       "NOT effective model-request proof", "NOT OBSERVED", "channel: UserPromptSubmit",
                       "dynamicDelivered: True", "seq: 5"):
            self.assertIn(phrase, text)
        for key in ("packageRevision", "staticHash", "dynamicHash", "payloadHash"):
            self.assertIn(f"{key}: {receipt['data'][key]}", text)
        self.assertNotIn("unsupported stage", text)
        receipt["data"]["dynamicDelivered"] = False
        self.assertIn("INCOMPLETE: hook acknowledgement requires", self.text(self.render(trace)[1]))

    def test_policy_translation_is_allowlisted_and_not_context_or_parity(self):
        trace = fixture()
        rule = dict(action="edit", resource="restricted/**", effect="deny", secret="SECRET_SENTINEL")
        translation = dict(schema=1, scope="native-child-definitions", parentPermissions="legacy-headless-settings",
                           secret="SECRET_SENTINEL", children=[dict(canonicalId="sane/worker/scout", nativeId="scout",
                           model=dict(source="pinned", value="claude-sonnet", secret="SECRET_SENTINEL"),
                           effort=dict(source="native-inheritance"), disallowedTools=["Edit", "Agent", {"secret": "SECRET_SENTINEL"}],
                           restrictions=[dict(rule=rule, tools=["Edit"], translation="conservative-whole-tool", secret="SECRET_SENTINEL")])],
                           diagnostics=[dict(agent="sane/worker/scout", code=code, message="Fixture diagnostic", rule=rule,
                                             tools=["Agent"], secret="SECRET_SENTINEL") for code in
                                        ("resource-deny-widened", "nested-agent-restriction-widened", "headless-ask-to-allow", "temperature-unavailable")])
        trace["records"][-1]["data"]["executionPolicy"] = dict(revision="policy-revision", agent="sane-app-execution",
                          nativeRoleRegistration=False, policyTranslation=translation, secret="SECRET_SENTINEL")
        text = self.text(self.render(trace)[1])
        for phrase in ("separate from context injection", "NOT full policy parity", "source: pinned", "Native inheritance",
                       "conservative-whole-tool", "Agent is disabled", "not an independent approval boundary",
                       "temperature is not applied", "parentPermissions: legacy-headless-settings"):
            self.assertIn(phrase, text)
        self.assertNotIn("SECRET_SENTINEL", text)
        launch = trace["records"][-1]["data"]
        del launch["executionPolicy"]
        launch["policyTranslation"] = translation
        text = self.text(self.render(trace)[1])
        self.assertIn("Producer capture layout: launch.policyTranslation", text)
        self.assertIn("source: pinned", text)
        self.assertNotIn("SECRET_SENTINEL", text)
        translation["schema"] = 2
        text = self.text(self.render(trace)[1])
        self.assertIn("unknown or missing policy translation contract", text)
        self.assertNotIn("Fixture diagnostic", text)


if __name__ == "__main__":
    unittest.main()
