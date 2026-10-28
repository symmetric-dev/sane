"""Offline evidence inspection only; no CLI, network, or model calls.

The native SQLite payloads are protobuf blobs. This checks byte inclusion in
stream-correlated user steps, not a decoded admission field or model consumption.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 experiments/user-owned-context/antigravity-history.py <run-directory>")
directory = Path(sys.argv[1]).resolve()
inputs = json.loads((directory / "inputs.json").read_text())
evidence = json.loads((directory / "evidence.json").read_text())
database = directory / "final.native.db"
connection = sqlite3.connect(f"file:{database}?mode=ro&immutable=1", uri=True)
schema = connection.execute("SELECT name, sql FROM sqlite_master WHERE type='table'").fetchall()
rows = connection.execute("SELECT idx, step_type, step_payload FROM steps ORDER BY idx").fetchall()
connection.close()
observations = []
session_ids = set()
system_indices = set()
for index, probe in enumerate(inputs["probes"]):
    events = [json.loads(line) for line in (directory / f"agy-{index + 1}-{probe['name']}.stdout.jsonl").read_text().splitlines() if line]
    session_ids.update(event["conversation_id"] for event in events if event["event"] == "init")
    steps = [event["step_update"] for event in events if event["event"] == "step_update"]
    user_indices = sorted({step["step_index"] for step in steps if step["step_type"] == "user_input"})
    system_indices.update(step["step_index"] for step in steps if step["step_type"] == "system_message")
    prompt = probe["text"].encode()
    matches = [idx for idx, _, payload in rows if prompt in (payload or b"")]
    observations.append({
        "turn": probe["name"], "streamUserIndices": user_indices,
        "nativeRowsContainingExactPromptBytes": matches,
        "promptSha256": hashlib.sha256(prompt).hexdigest(),
        "bodyOnly": probe["kind"] != "ordinary" or probe["body"] == probe["text"],
        "matchedExactlyOneCorrelatedUserStep": len(user_indices) == 1 and matches == user_indices,
    })
activation_rows = [idx for idx, _, payload in rows if b'<sane-context kind="activation">' in (payload or b"")]
checks = {
    "fivePromptsInNativeUserSteps": len(observations) == 5 and all(item["matchedExactlyOneCorrelatedUserStep"] for item in observations),
    "activationInFirstUserStepOnly": activation_rows == observations[0]["streamUserIndices"],
    "ordinaryPromptsAreBodyOnly": all(item["bodyOnly"] for item in observations),
    "oneNativeConversation": session_ids == {evidence["nativeSessionId"]},
}
manifest = {
    "kind": "offline-native-history-byte-inspection", "realModelCalls": 0,
    "originalRunComplete": evidence["complete"],
    "nativeSessionId": evidence["nativeSessionId"],
    "databaseSha256": hashlib.sha256(database.read_bytes()).hexdigest(),
    "schema": schema, "checks": checks, "observations": observations,
    "nativeSystemMessageIndices": sorted(system_indices),
    "limit": "Opaque protobuf payload substring checks, not field-level protobuf decoding or an admission receipt. A native payload can contain multiple serialized representations of the same user text; activation-in-one-step does not mean one marker byte occurrence. Native system restart notices are not SANE context injection.",
}
path = directory / "history-review.json"
path.write_text(json.dumps(manifest, indent=2) + "\n")
path.chmod(0o600)
print(json.dumps(checks, indent=2))
if not all(checks.values()):
    raise SystemExit(1)
