import copy
from pathlib import Path
import unittest

from bundle import adapt_capture, adapt_checks, initial_only, scoped_observations
from test_report import fixture


class BundleTests(unittest.TestCase):
    def test_native_parent_and_child_observations_are_separate(self):
        evidence = dict(checks=[dict(id="aggregate")], observations=[
            dict(runId="parent", sessionId="one", text="parent text"),
            dict(runId="child", sessionId="two", text="child text"),
            dict(runId="child", sessionId="other", text="foreign text")])
        result = scoped_observations(evidence, dict(runId="child", sessionId="two"))
        self.assertEqual(result["observations"], [evidence["observations"][1]])
        self.assertEqual(result["checks"], evidence["checks"])
        self.assertEqual(len(evidence["observations"]), 3)

    def test_adapter_retains_event_identity_not_runner_identity(self):
        events = fixture()["records"]
        capture = dict(schema=1, realModelInvoked=False, runId="runner-not-app", data=dict(records=events))
        trace = adapt_capture(capture)
        self.assertEqual(trace["runId"], "fixture-run")
        self.assertEqual(trace["records"], events)
        bad = copy.deepcopy(capture)
        bad["data"]["records"][-1]["sessionId"] = "other"
        with self.assertRaises(ValueError):
            adapt_capture(bad)

    def test_bridge_filter_and_initial_scope_survive_adaptation(self):
        checks = adapt_checks(dict(schema=1, evidenceKind="deterministic-mock", realModelInvoked=False, complete=True,
                                  checks=[dict(file="bridge", command=["bun", "test", "--test-name-pattern", "canonical bridge"],
                                               exitCode=0, passed=1, failed=0)]), Path("checks.json"))
        self.assertIn("NOT the full file", checks["checks"][0]["scope"])
        evidence = dict(checks=[dict(id="initial"), dict(id="post-compaction")],
                        observations=[dict(reason="initial", text="first"), dict(reason="post-compaction", text="later")])
        result = initial_only(evidence)
        self.assertEqual(result["checks"], [dict(id="initial")])
        self.assertEqual(result["observations"], [dict(reason="initial", text="first")])
        with self.assertRaises(ValueError):
            initial_only(dict(checks=[], observations=[]))


if __name__ == "__main__":
    unittest.main()
