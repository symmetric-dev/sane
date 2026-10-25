"""Offline inspection of owned Grok captures. No native commands or model calls."""
import hashlib
import json
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 experiments/user-owned-context/grok-history.py <run-directory>")
directory = Path(sys.argv[1]).resolve()
inputs = json.loads((directory / "inputs.json").read_text())
evidence = json.loads((directory / "evidence.json").read_text())
probes = inputs["probes"]
session_id = evidence["nativeSessionId"]


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def text(row):
    content = row.get("content", "")
    return content if isinstance(content, str) else "\n".join(
        part.get("text", "") for part in content if part.get("type") == "text"
    )


observations = []
for index, probe in enumerate(probes):
    label = f"grok-{index + 1}-{probe['name']}"
    history = rows(directory / f"{label}.native/chat_history.jsonl")
    authored = [row for row in history if row["type"] == "user" and "prompt_index" in row]
    updates = rows(directory / f"{label}.native/updates.jsonl")
    user_updates = [row["params"]["update"]["content"]["text"] for row in updates
                    if row["params"]["update"]["sessionUpdate"] == "user_message_chunk"]
    observations.append({
        "turn": probe["name"], "promptSha256": hashlib.sha256(probe["text"].encode()).hexdigest(),
        "nativePromptIndices": [row["prompt_index"] for row in authored],
        "nativeAuthoredHistoryEqualsExactPrefix": [text(row) for row in authored] == [p["text"] for p in probes[:index + 1]],
        "nativeUserUpdatesEqualExactPrefix": user_updates == [p["text"] for p in probes[:index + 1]],
        "sameNativeSessionInUpdates": all(row["params"]["sessionId"] == session_id for row in updates),
    })

native = directory / "final.native"
history = rows(native / "chat_history.jsonl")
updates = rows(native / "updates.jsonl")
authored = [row for row in history if row["type"] == "user" and "prompt_index" in row]
extra_user = [{"row": index, "syntheticReason": row.get("synthetic_reason"), "bytes": len(text(row).encode()),
               "sha256": hashlib.sha256(text(row).encode()).hexdigest(), "hasSaneContextMarker": "<sane-context" in text(row)}
              for index, row in enumerate(history) if row["type"] == "user" and "prompt_index" not in row]
assistants = [row for row in history if row["type"] == "assistant"]
summary = json.loads((native / "summary.json").read_text())
checks = {
    "fiveSerialAuthoredNativePrompts": len(authored) == 5 and len(observations) == 5 and all(
        o["nativeAuthoredHistoryEqualsExactPrefix"] and o["nativeUserUpdatesEqualExactPrefix"] and o["sameNativeSessionInUpdates"] for o in observations),
    "activationOnlyInFirstAuthoredUserMessage": [i for i, row in enumerate(authored) if '<sane-context kind="activation">' in text(row)] == [0],
    "updateOnlyInThirdAuthoredUserMessage": [i for i, row in enumerate(authored) if '<sane-context kind="update">' in text(row)] == [2],
    "ordinaryPromptsAreBodyOnly": all(p["text"] == p["body"] for p in probes if p["kind"] == "ordinary"),
    "noSaneContextInNativeExtraUserMessages": all(not row["hasSaneContextMarker"] for row in extra_user),
    "noSaneInNativeSystemPrompt": "SANE" not in (native / "system_prompt.txt").read_text(),
    "noObservedNativeToolCalls": not any("tool" in row["type"] for row in history) and not any(
        "tool_call" in row["params"]["update"]["sessionUpdate"] for row in updates),
    "fiveNativeAssistantReplies": len(assistants) == 5,
    "requestedLowEffortReportedInNativeHistory": len(assistants) == 5 and all(row.get("reasoning_effort") == "low" for row in assistants),
    "nativeSummaryMatchesSession": summary["info"]["id"] == session_id and summary["current_model_id"] == "grok-4.7",
}
report = {
    "kind": "offline-grok-native-history-inspection", "realModelCalls": 0,
    "originalRunComplete": evidence["complete"], "nativeSessionId": session_id,
    "checks": checks, "observations": observations, "nativeExtraUserMessages": extra_user,
    "nativeAssistantModels": [{key: row.get(key) for key in ["model_id", "model_fingerprint", "reasoning_effort"]} for row in assistants],
    "nativeFilesSha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in native.iterdir() if p.is_file()},
    "limit": "Decoded native persisted authored messages and ACP updates match exact inputs at each prefix. Not an independent admission receipt, provider/backend attestation, or proof of consumption. Native user-info/rules and a bundled-skills synthetic reminder precede authored activation; no claim of a synthetic-free transcript.",
}
path = directory / "history-review.json"
path.write_text(json.dumps(report, indent=2) + "\n")
path.chmod(0o600)
print(json.dumps(checks, indent=2))
if not all(checks.values()):
    raise SystemExit(1)
