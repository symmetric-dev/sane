#!/usr/bin/env python3
"""Generate explicitly SYNTHETIC evidence and sample report, never live results."""
import json
from pathlib import Path
import sys
from report import build
from test_report import fixture

if __name__ == "__main__":
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    trace = fixture()
    evidence = dict(schema=1, checks=[dict(id="synthetic-example", status="skipped", scope="sample only",
                    evidenceKind="synthetic", evidenceRef="sample.py", summary="Illustration only; no live verification performed")])
    (output / "synthetic-trace.json").write_text(json.dumps(trace, indent=2) + "\n")
    (output / "synthetic-checks.json").write_text(json.dumps(evidence, indent=2) + "\n")
    build(trace, evidence, "synthetic", "SYNTHETIC EXAMPLE ONLY — no live checks", output / "synthetic-report.docx")
