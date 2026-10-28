import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendGrokCaptureTurn, beginGrokCaptureTurn, createGrokCaptureJournal, finishGrokCaptureTurn, GrokCaptureRefusal, loadGrokCaptureJournal, persistGrokCaptureJournal,
  type GrokCaptureJournal, type GrokCaptureTurnInput,
} from "./grok-capture";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const APP = "12345678-1234-4234-9234-123456789abc";
const NATIVE = "12345678-1234-4234-8234-123456789abd";
const OTHER = "abcdefab-1234-4234-9234-123456789abc";
const OTHER_NATIVE = "abcdefab-1234-4234-8234-123456789abd";
const AUTHORITY = `sane-native-v1:gk:${"ab".repeat(32)}`;
const OTHER_AUTHORITY = `sane-native-v1:gk:${"cd".repeat(32)}`;
const CC_AUTHORITY = `sane-native-v1:cc:${"ab".repeat(32)}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(TEMP, "grok-capture-")));
  roots.push(root);
  return root;
}

function captureName(appSessionId = APP): string {
  return `grok-capture.${appSessionId}.json`;
}

function input(overrides: Partial<GrokCaptureTurnInput> = {}): GrokCaptureTurnInput {
  return {
    appSessionId: APP,
    nativeSessionId: NATIVE,
    authorityId: AUTHORITY,
    cwd: join(TEMP, "grok-capture-cwd"),
    model: "fixture-model",
    effort: "fixture-effort",
    turnIndex: 0,
    prompt: "exact prompt",
    submission: "submitted",
    stdout: "",
    stderr: "",
    exitCode: null,
    nativeCancellation: "not-requested",
    ...overrides,
  };
}

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appSessionId: APP,
    nativeSessionId: NATIVE,
    authorityId: AUTHORITY,
    cwd: join(TEMP, "grok-capture-cwd"),
    model: "fixture-model",
    effort: "fixture-effort",
    turnIndex: 0,
    prompt: "exact prompt",
    submission: "submitted",
    nativeAcceptance: "unknown",
    acceptedMessageId: null,
    stdout: "",
    stderr: "",
    exitCode: null,
    nativeCancellation: "not-requested",
    ...overrides,
  };
}

describe("grok capture journal", () => {
  test("begin durably publishes pending identity before any completed turn and reload prevents retry", () => {
    const dir = tempRoot();
    const journal = createGrokCaptureJournal();
    const identity = { appSessionId: APP, nativeSessionId: NATIVE, authorityId: AUTHORITY, turnIndex: 0 };
    beginGrokCaptureTurn(dir, journal, identity);
    const path = join(dir, captureName());
    const before = readFileSync(path);
    expect(JSON.parse(before.toString())).toEqual({ version: 1, turns: [], execution: { ...identity, disposition: "pending" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const loaded = loadGrokCaptureJournal(dir, APP);
    expect(loaded.turns).toEqual([]);
    expect(loaded.execution).toEqual({ ...identity, disposition: "pending" });
    for (const patch of [{ nativeSessionId: OTHER_NATIVE }, { authorityId: OTHER_AUTHORITY }]) {
      expect(() => beginGrokCaptureTurn(dir, loaded, { ...identity, ...patch })).toThrow(/refuses to rebind/);
      expect(readFileSync(path)).toEqual(before);
    }
    expect(() => beginGrokCaptureTurn(dir, loaded, identity)).toThrow(/pending or blocked/);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir)).toEqual([captureName()]);
  });

  test("safe finish advances idle to the next completed turn and allows continuation after reload", () => {
    const dir = tempRoot();
    const journal = createGrokCaptureJournal();
    const identity = { appSessionId: APP, nativeSessionId: NATIVE, authorityId: AUTHORITY };
    beginGrokCaptureTurn(dir, journal, { ...identity, turnIndex: 0 });
    appendGrokCaptureTurn(journal, input({ stdout: "first output", exitCode: 0 }));
    finishGrokCaptureTurn(dir, journal, { blocked: false });
    const loaded = loadGrokCaptureJournal(dir, APP);
    expect(loaded.execution).toEqual({ ...identity, turnIndex: 1, disposition: "idle" });
    expect(loaded.turns.map(turn => [turn.turnIndex, turn.stdout])).toEqual([[0, "first output"]]);
    beginGrokCaptureTurn(dir, loaded, { ...identity, turnIndex: 1 });
    const pending = loadGrokCaptureJournal(dir, APP);
    expect(pending.execution).toEqual({ ...identity, turnIndex: 1, disposition: "pending" });
    expect(pending.turns).toEqual(loaded.turns);
    appendGrokCaptureTurn(loaded, input({ turnIndex: 1, prompt: "continued", exitSignal: null }));
    finishGrokCaptureTurn(dir, loaded, { blocked: false });
    expect(loadGrokCaptureJournal(dir, APP).execution).toEqual({ ...identity, turnIndex: 2, disposition: "idle" });
  });

  test("blocked finish survives reload and refuses both replay and a next turn without writes", () => {
    const dir = tempRoot();
    const journal = createGrokCaptureJournal();
    const identity = { appSessionId: APP, nativeSessionId: NATIVE, authorityId: AUTHORITY };
    beginGrokCaptureTurn(dir, journal, { ...identity, turnIndex: 0 });
    appendGrokCaptureTurn(journal, input({ nativeCancellation: "unproven", exitSignal: "SIGTERM" }));
    finishGrokCaptureTurn(dir, journal, { blocked: true });
    const path = join(dir, captureName());
    const before = readFileSync(path);
    const loaded = loadGrokCaptureJournal(dir, APP);
    expect(loaded.execution).toEqual({ ...identity, turnIndex: 0, disposition: "blocked" });
    for (const turnIndex of [0, 1]) {
      expect(() => beginGrokCaptureTurn(dir, loaded, { ...identity, turnIndex })).toThrow(/pending or blocked/);
      expect(readFileSync(path)).toEqual(before);
    }
    expect(loaded.turns[0].exitSignal).toBe("SIGTERM");
    expect(readdirSync(dir)).toEqual([captureName()]);
  });

  test("native identity and source authority cannot be rebound after a safe finish", () => {
    const dir = tempRoot();
    const journal = createGrokCaptureJournal();
    const identity = { appSessionId: APP, nativeSessionId: NATIVE, authorityId: AUTHORITY };
    beginGrokCaptureTurn(dir, journal, { ...identity, turnIndex: 0 });
    appendGrokCaptureTurn(journal, input());
    finishGrokCaptureTurn(dir, journal, { blocked: false });
    const path = join(dir, captureName());
    const before = readFileSync(path);
    for (const patch of [{ nativeSessionId: OTHER_NATIVE }, { authorityId: OTHER_AUTHORITY }]) {
      const loaded = loadGrokCaptureJournal(dir, APP);
      expect(() => beginGrokCaptureTurn(dir, loaded, { ...identity, ...patch, turnIndex: 1 })).toThrow(/refuses to rebind/);
      expect(() => appendGrokCaptureTurn(loaded, input({ ...patch, turnIndex: 1 }))).toThrow(/refuses to rebind/);
      const replacement = createGrokCaptureJournal();
      appendGrokCaptureTurn(replacement, input(patch));
      expect(() => persistGrokCaptureJournal(dir, replacement)).toThrow(/refuses to rebind/);
      expect(loaded.execution).toEqual({ ...identity, turnIndex: 1, disposition: "idle" });
      expect(loaded.turns).toHaveLength(1);
      expect(readFileSync(path)).toEqual(before);
      expect(readdirSync(dir)).toEqual([captureName()]);
    }
  });

  test("load refuses a capture whose execution source does not match its transcript", () => {
    const dir = tempRoot();
    const path = join(dir, captureName());
    writeFileSync(path, JSON.stringify({
      version: 1,
      turns: [stored()],
      execution: { appSessionId: APP, nativeSessionId: NATIVE, authorityId: OTHER_AUTHORITY, turnIndex: 1, disposition: "idle" },
    }), { mode: 0o600 });
    const before = readFileSync(path);
    expect(() => loadGrokCaptureJournal(dir, APP)).toThrow(/refuses to rebind/);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir)).toEqual([captureName()]);
  });

  test("a loaded writer detects same-byte disk replacement and size drift without overwriting either", () => {
    for (const change of ["replacement", "drift"] as const) {
      const dir = tempRoot();
      const journal = createGrokCaptureJournal();
      appendGrokCaptureTurn(journal, input());
      persistGrokCaptureJournal(dir, journal);
      const loaded = loadGrokCaptureJournal(dir, APP);
      const path = join(dir, captureName());
      const original = readFileSync(path);
      if (change === "replacement") {
        const replacement = join(dir, "replacement.json");
        writeFileSync(replacement, original, { mode: 0o600 });
        renameSync(replacement, path);
      } else {
        writeFileSync(path, Buffer.concat([original, Buffer.from("\n ")]));
      }
      const changed = readFileSync(path);
      appendGrokCaptureTurn(loaded, input({ turnIndex: 1, prompt: "must not overwrite external changes" }));
      expect(() => persistGrokCaptureJournal(dir, loaded)).toThrow(/file changed outside the session writer/);
      expect(readFileSync(path)).toEqual(changed);
      expect(readdirSync(dir)).toEqual([captureName()]);
      expect(loadGrokCaptureJournal(dir, APP).turns).toHaveLength(1);
    }
  });

  test("persisted transcripts preserve optional exit signals without promoting native acceptance", () => {
    for (const signal of [{}, { exitSignal: null }, { exitSignal: "SIGTERM" }]) {
      const dir = tempRoot();
      const journal = createGrokCaptureJournal();
      beginGrokCaptureTurn(dir, journal, { appSessionId: APP, nativeSessionId: NATIVE, authorityId: AUTHORITY, turnIndex: 0 });
      appendGrokCaptureTurn(journal, input({ ...signal, exitCode: 0, stdout: `{"id":"msg_0","subtype":"success","session_id":"${NATIVE}"}` }));
      finishGrokCaptureTurn(dir, journal, { blocked: false });
      const raw = JSON.parse(readFileSync(join(dir, captureName()), "utf8"));
      const loaded = loadGrokCaptureJournal(dir, APP);
      for (const turn of [raw.turns[0], loaded.turns[0]]) {
        expect(turn.nativeAcceptance).toBe("unknown");
        expect(turn.acceptedMessageId).toBeNull();
        expect(Object.hasOwn(turn, "exitSignal")).toBe(Object.hasOwn(signal, "exitSignal"));
        expect(turn.exitSignal).toBe((signal as { exitSignal?: string | null }).exitSignal);
      }
    }
  });

  test("round-trips exact prompt text and does not accept success-shaped stdout or exit 0", () => {
    const dir = tempRoot();
    const prompt = "exact prompt\r\nwith \"quotes\", msg_0, subtype success, session " + NATIVE + " \uFEFF😀";
    const stdout = `{"id":"msg_0","subtype":"success","session_id":"${NATIVE}","acceptedMessageId":"msg_0"}`;
    const journal = createGrokCaptureJournal();
    const appended = appendGrokCaptureTurn(journal, input({
      prompt,
      stdout,
      stderr: "fixture-stderr",
      exitCode: 0,
      submission: "submitted",
    }));
    expect(appended.acceptedMessageId).toBeNull();
    expect(appended.nativeAcceptance).toBe("unknown");
    expect(appended.exitCode).toBe(0);
    persistGrokCaptureJournal(dir, journal);
    const loaded = loadGrokCaptureJournal(dir, APP);
    expect(loaded.version).toBe(1);
    expect(loaded.turns).toHaveLength(1);
    expect(loaded.turns[0].prompt).toBe(prompt);
    expect(loaded.turns[0].stdout).toBe(stdout);
    expect(loaded.turns[0].stdout).toContain(`"id":"msg_0"`);
    expect(loaded.turns[0].stdout).toContain(`"subtype":"success"`);
    expect(loaded.turns[0].stderr).toBe("fixture-stderr");
    expect(loaded.turns[0].exitCode).toBe(0);
    expect(loaded.turns[0].acceptedMessageId).toBeNull();
    expect(loaded.turns[0].nativeAcceptance).toBe("unknown");
    expect(loaded.turns[0].acceptedMessageId).not.toBe("msg_0");
    expect(loaded.turns[0].nativeSessionId).toBe(NATIVE);
    expect(Object.keys(loaded.turns[0])).not.toContain("messageId");
    const raw = JSON.parse(readFileSync(join(dir, captureName()), "utf8")) as { version: number; turns: Array<Record<string, unknown>> };
    expect(raw.version).toBe(1);
    expect(Object.keys(raw).sort()).toEqual(["turns", "version"]);
    expect(raw.turns[0].acceptedMessageId).toBeNull();
    expect(raw.turns[0].nativeAcceptance).toBe("unknown");
    expect(statSync(join(dir, captureName())).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).not.toContain("grok-captures.json");
  });

  test("a duplicate turn index throws and leaves the first turn intact", () => {
    const dir = tempRoot();
    const journal = createGrokCaptureJournal();
    const first = appendGrokCaptureTurn(journal, input({ prompt: "keep me", turnIndex: 0 }));
    expect(() => appendGrokCaptureTurn(journal, input({ prompt: "replace me", turnIndex: 0 }))).toThrow(/duplicate or nonsequential turn index/);
    expect(journal.turns).toHaveLength(1);
    expect(journal.turns[0]).toBe(first);
    expect(first.prompt).toBe("keep me");
    persistGrokCaptureJournal(dir, journal);
    expect(loadGrokCaptureJournal(dir, APP).turns.map(turn => turn.prompt)).toEqual(["keep me"]);
  });

  test("continuation keeps the same native session id", () => {
    const dir = tempRoot();
    const journal = createGrokCaptureJournal();
    const first = appendGrokCaptureTurn(journal, input({ turnIndex: 0, prompt: "first" }));
    const second = appendGrokCaptureTurn(journal, input({ turnIndex: 1, prompt: "continued" }));
    expect(second.nativeSessionId).toBe(first.nativeSessionId);
    expect(second.nativeSessionId).toBe(NATIVE);
    expect(second.appSessionId).toBe(APP);
    expect(journal.turns.map(turn => turn.turnIndex)).toEqual([0, 1]);
    persistGrokCaptureJournal(dir, journal);
    const loaded = loadGrokCaptureJournal(dir, APP);
    expect(loaded.turns.map(turn => turn.nativeSessionId)).toEqual([NATIVE, NATIVE]);
    expect(loaded.turns.map(turn => [turn.turnIndex, turn.prompt])).toEqual([[0, "first"], [1, "continued"]]);
  });

  test("persist writes only grok-capture.<appSessionId>.json", () => {
    const dir = tempRoot();
    const journal = createGrokCaptureJournal();
    appendGrokCaptureTurn(journal, input());
    persistGrokCaptureJournal(dir, journal);
    const names = readdirSync(dir);
    expect(names).toEqual([captureName()]);
    expect(names).not.toContain("grok-captures.json");
    expect(names).not.toContain("metadata.json");
    expect(names).not.toContain("admissions.json");
    expect(names).not.toContain("sources.json");
    expect(names.some(name => name.toLowerCase().includes("receipt"))).toBe(false);
    expect(names.some(name => name.endsWith(".tmp"))).toBe(false);
  });

  test("a relative cwd and a cc authority refuse before any write", () => {
    const dir = tempRoot();
    for (const patch of [{ cwd: "relative/cwd" }, { authorityId: CC_AUTHORITY }]) {
      const journal = createGrokCaptureJournal();
      expect(() => appendGrokCaptureTurn(journal, input(patch))).toThrow(GrokCaptureRefusal);
      expect(journal.turns).toEqual([]);
      expect(() => persistGrokCaptureJournal(dir, { version: 1, turns: [stored(patch)] } as GrokCaptureJournal)).toThrow(GrokCaptureRefusal);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test("empty model, empty effort, and a non-UUID session id refuse before any write", () => {
    const dir = tempRoot();
    for (const patch of [{ model: "" }, { effort: "" }, { appSessionId: "not-a-uuid" }, { nativeSessionId: "ses_native" }]) {
      const journal = createGrokCaptureJournal();
      expect(() => appendGrokCaptureTurn(journal, input(patch))).toThrow(GrokCaptureRefusal);
      expect(journal.turns).toEqual([]);
      expect(() => persistGrokCaptureJournal(dir, { version: 1, turns: [stored(patch)] } as GrokCaptureJournal)).toThrow(GrokCaptureRefusal);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test("load refuses an unknown version, claimed acceptance, or a non-null accepted message id", () => {
    const dir = tempRoot();
    const path = join(dir, captureName());
    writeFileSync(path, JSON.stringify({ version: 2, turns: [] }), { mode: 0o600 });
    const versioned = readFileSync(path);
    expect(() => loadGrokCaptureJournal(dir, APP)).toThrow(/Unsupported Grok capture file version/);
    const journal = createGrokCaptureJournal();
    appendGrokCaptureTurn(journal, input());
    expect(() => persistGrokCaptureJournal(dir, journal)).toThrow(/Unsupported Grok capture file version/);
    expect(readFileSync(path)).toEqual(versioned);
    writeFileSync(path, JSON.stringify({ version: 1, turns: [stored({ nativeAcceptance: "accepted", acceptedMessageId: "msg_0" })] }), { mode: 0o600 });
    const claimed = readFileSync(path);
    expect(() => loadGrokCaptureJournal(dir, APP)).toThrow(/native acceptance is not unknown/);
    expect(readFileSync(path)).toEqual(claimed);
    writeFileSync(path, JSON.stringify({ version: 1, turns: [stored({ acceptedMessageId: "msg_0" })] }), { mode: 0o600 });
    expect(() => loadGrokCaptureJournal(dir, APP)).toThrow(/accepted message id is not null/);
    writeFileSync(path, JSON.stringify({ version: 1, turns: [stored({ acceptedMessageId: NATIVE })] }), { mode: 0o600 });
    expect(() => loadGrokCaptureJournal(dir, APP)).toThrow(/accepted message id is not null/);
  });

  test("a missing session file loads as an empty version-1 journal", () => {
    const dir = tempRoot();
    const loaded = loadGrokCaptureJournal(dir, APP);
    expect(loaded.version).toBe(1);
    expect(loaded.turns).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    expect(() => loadGrokCaptureJournal(dir, "not-a-uuid")).toThrow(/not a UUID/);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("two App session files in one directory do not erase each other", () => {
    const dir = tempRoot();
    const first = createGrokCaptureJournal();
    appendGrokCaptureTurn(first, input({ prompt: "session-a", stdout: "a-out" }));
    persistGrokCaptureJournal(dir, first);
    const second = createGrokCaptureJournal();
    appendGrokCaptureTurn(second, input({
      appSessionId: OTHER,
      nativeSessionId: OTHER_NATIVE,
      prompt: "session-b",
      stdout: "b-out",
    }));
    persistGrokCaptureJournal(dir, second);
    const otherPath = join(dir, captureName(OTHER));
    const otherBytes = readFileSync(otherPath);
    const continued = loadGrokCaptureJournal(dir, APP);
    appendGrokCaptureTurn(continued, input({ turnIndex: 1, prompt: "session-a-continued", stdout: "a-out-2" }));
    persistGrokCaptureJournal(dir, continued);
    expect(readFileSync(otherPath)).toEqual(otherBytes);
    expect(loadGrokCaptureJournal(dir, OTHER).turns.map(turn => [turn.prompt, turn.stdout, turn.appSessionId])).toEqual([
      ["session-b", "b-out", OTHER],
    ]);
    expect(loadGrokCaptureJournal(dir, APP).turns.map(turn => [turn.turnIndex, turn.prompt])).toEqual([
      [0, "session-a"],
      [1, "session-a-continued"],
    ]);
    expect(readdirSync(dir).sort()).toEqual([captureName(), captureName(OTHER)].sort());
    expect(readdirSync(dir)).not.toContain("grok-captures.json");
  });

  test("a persist that drops an existing turn leaves the file unchanged", () => {
    const dir = tempRoot();
    const journal = createGrokCaptureJournal();
    appendGrokCaptureTurn(journal, input({ turnIndex: 0, prompt: "keep", stdout: "out-0" }));
    appendGrokCaptureTurn(journal, input({ turnIndex: 1, prompt: "also keep", stdout: "out-1" }));
    persistGrokCaptureJournal(dir, journal);
    const path = join(dir, captureName());
    const before = readFileSync(path);
    const dropped = createGrokCaptureJournal();
    appendGrokCaptureTurn(dropped, input({ turnIndex: 0, prompt: "keep", stdout: "out-0" }));
    expect(() => persistGrokCaptureJournal(dir, dropped)).toThrow(/drop a stored turn/);
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir)).toEqual([captureName()]);
    expect(loadGrokCaptureJournal(dir, APP).turns.map(turn => turn.prompt)).toEqual(["keep", "also keep"]);
  });

  test("replacing stdout of an existing turn leaves the file unchanged", () => {
    const dir = tempRoot();
    const journal = createGrokCaptureJournal();
    appendGrokCaptureTurn(journal, input({ prompt: "keep", stdout: "original" }));
    persistGrokCaptureJournal(dir, journal);
    const path = join(dir, captureName());
    const before = readFileSync(path);
    const changed = createGrokCaptureJournal();
    appendGrokCaptureTurn(changed, input({ prompt: "keep", stdout: `{"id":"msg_0","subtype":"success"}` }));
    expect(() => persistGrokCaptureJournal(dir, changed)).toThrow(/change a stored turn/);
    expect(readFileSync(path)).toEqual(before);
    expect(loadGrokCaptureJournal(dir, APP).turns[0].stdout).toBe("original");
    expect(loadGrokCaptureJournal(dir, APP).turns[0].nativeAcceptance).toBe("unknown");
    expect(loadGrokCaptureJournal(dir, APP).turns[0].acceptedMessageId).toBeNull();
  });

  test("a journal with mixed App session ids refuses before any write", () => {
    const dir = tempRoot();
    const keeper = createGrokCaptureJournal();
    appendGrokCaptureTurn(keeper, input({ prompt: "keeper" }));
    persistGrokCaptureJournal(dir, keeper);
    const path = join(dir, captureName());
    const before = readFileSync(path);
    const mixed = {
      version: 1 as const,
      turns: [
        stored({ turnIndex: 0, prompt: "keeper" }),
        stored({ appSessionId: OTHER, nativeSessionId: OTHER_NATIVE, turnIndex: 1, prompt: "other" }),
      ],
    };
    expect(() => persistGrokCaptureJournal(dir, mixed as GrokCaptureJournal)).toThrow(/refuses to rebind the App session/);
    expect(readdirSync(dir)).toEqual([captureName()]);
    expect(readFileSync(path)).toEqual(before);
  });
});
