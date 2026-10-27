import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { standingFrameworkNames } from "sane-core/sane-framework";
import { contextHash, validateContextPackage, type ContextPackage } from "../../packages/sane-app/src/context-package";
import { contextMessageFromSubmission, decodeContextMessageSubmission, projectContextMessageRestart } from "../../packages/sane-app/src/context-message-evidence";
import { composeContextMessage, validateContextMessageBinding, type ContextMessage } from "../../packages/sane-app/src/context-message";
import type { DemoCheck, DemoJournalRead, DemoReplayResult, DemoRunResult, DemoScenarioId, DemoScenarioResult } from "./contract";
import { readDemoJournal } from "./journal";

const MAX_FILE = 8 * 1024 * 1024;
const MAX_MANIFEST = 512 * 1024;
const IDS: readonly DemoScenarioId[] = ["activation", "ordinary", "update", "stale-source", "owner-refusal", "persistence-failure", "attempt-unresolved"];
const FACTS = ["no-evidence", "prepared-only", "withheld", "attempt-unresolved", "submitted-unconfirmed", "submitted-not-accepted", "accepted", "unknown"];
function failure(reason: string): never { throw new Error(`Invalid mock demo run: ${reason}`); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure("expected object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) failure("missing or unknown fields");
}
function text(value: unknown, max = 8192): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0") || Buffer.from(value).toString("utf8") !== value) failure("invalid bounded UTF-8 string");
}
function count(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100_000) failure("invalid counter"); }
function array(value: unknown, max: number): asserts value is unknown[] { if (!Array.isArray(value) || value.length > max) failure("invalid bounded array"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? failure("non-JSON value");
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function child(root: string, path: string): boolean { const rel = relative(root, path); return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function absolute(value: unknown): asserts value is string {
  text(value); if (!isAbsolute(value) || resolve(value) !== value || value.split(sep).includes("..") || /[\r\n]/.test(value)) failure("noncanonical absolute path");
}
/** All traversed components must be real directories/files, not links. Missing
 * suffixes are permitted only so a missing-journal variant can stay unknown. */
function safePath(root: string, path: string): void {
  if (path !== root && !child(root, path)) failure("path escapes fixture root");
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) failure("fixture root must be a real directory");
  let at = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    at = join(at, part);
    try { if (lstatSync(at).isSymbolicLink() || realpathSync(at) !== at) failure("symbolic link in fixture path"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}
function boundedRead(root: string, path: string, max = MAX_FILE): string {
  safePath(root, path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) failure("input is not a bounded regular file");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0, n: number;
    while ((n = readSync(fd, buffer, size, buffer.length - size, null)) > 0) { size += n; if (size > stat.size) failure("input changed during read"); }
    if (size !== stat.size) failure("input changed during read");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } finally { closeSync(fd); }
}
function identity(value: unknown, checkout: string): void {
  const id = object(value); keys(id, ["source", "runId", "nativeCommandId"], ["requestId"]);
  text(id.runId); if (id.nativeCommandId !== null) text(id.nativeCommandId);
  if (Object.hasOwn(id, "requestId")) text(id.requestId);
  const source = object(id.source); keys(source, ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"]);
  text(source.harnessId); text(source.sessionId);
  if (source.harnessId !== "mock-context-demo" || source.cwd !== checkout) failure("query must bind the mock harness and fixture checkout");
  if (source.authorityId !== null) text(source.authorityId);
  if (source.nativeSessionId !== null) text(source.nativeSessionId);
}
function validateRun(value: unknown): DemoRunResult {
  const run = object(value); keys(run, ["schema", "type", "simulation", "root", "checkout", "scenarios"], ["replayVariants"]);
  if (run.schema !== 1 || run.type !== "mock-context-demo-run" || run.simulation !== true) failure("unsupported schema/type or non-simulation");
  absolute(run.root); absolute(run.checkout);
  if (dirname(run.root) === run.root || !child(run.root, run.checkout)) failure("checkout must be inside dedicated fixture root");
  safePath(run.root, run.checkout);
  array(run.scenarios, IDS.length);
  const seen = new Set<string>(), directories = new Set<string>(), queries = new Set<string>();
  for (const entry of run.scenarios) {
    const s = object(entry);
    keys(s, ["id", "title", "journalDirectory", "identity", "messageId", "expectedFact", "expectedMockSends", "mockSends", "contextLoads", "executionLoads", "pairingChecks", "trace", "checks"], ["error"]);
    if (!IDS.includes(s.id as DemoScenarioId) || seen.has(s.id as string)) failure("unknown or duplicate scenario ID");
    seen.add(s.id as string); text(s.title); text(s.messageId); absolute(s.journalDirectory);
    if (!child(run.root, s.journalDirectory) || s.journalDirectory === run.checkout || child(run.checkout, s.journalDirectory) || directories.has(s.journalDirectory)) failure("invalid or duplicate journal directory");
    directories.add(s.journalDirectory); safePath(run.root, s.journalDirectory);
    identity(s.identity, run.checkout);
    const query = canonical({ identity: s.identity, messageId: s.messageId });
    if (queries.has(query)) failure("duplicate scenario query"); queries.add(query);
    if (!FACTS.includes(s.expectedFact as string)) failure("invalid expected fact");
    for (const field of ["expectedMockSends", "mockSends", "contextLoads", "executionLoads", "pairingChecks"]) count(s[field]);
    array(s.trace, 256); s.trace.forEach(item => text(item));
    array(s.checks, 128);
    for (const value of s.checks) { const check = object(value); keys(check, ["name", "passed", "detail"]); text(check.name); text(check.detail); if (typeof check.passed !== "boolean") failure("invalid recorded check"); }
    if (Object.hasOwn(s, "error")) text(s.error);
  }
  if (!run.scenarios.length) failure("no scenarios");
  if (Object.hasOwn(run, "replayVariants")) {
    array(run.replayVariants, 2); const variants = new Set<string>();
    const activation = run.scenarios.find(value => object(value).id === "activation") as DemoScenarioResult | undefined;
    for (const value of run.replayVariants) {
      const variant = object(value); keys(variant, ["id", "directory", "identity", "messageId", "expectedFact"]);
      if (!["torn", "missing"].includes(variant.id as string) || variants.has(variant.id as string) || variant.expectedFact !== "unknown") failure("invalid/duplicate replay variant");
      variants.add(variant.id as string); absolute(variant.directory); safePath(run.root, variant.directory);
      if (!child(run.root, variant.directory) || variant.directory === run.checkout || child(run.checkout, variant.directory) || directories.has(variant.directory)) failure("invalid variant directory");
      directories.add(variant.directory); identity(variant.identity, run.checkout); text(variant.messageId);
      if (!activation || !same(variant.identity, activation.identity) || variant.messageId !== activation.messageId) failure("variant must query original activation identity/message");
    }
  }
  return value as DemoRunResult;
}

/** Strict bounded manifest decode. The manifest cannot redirect reads into an
 * unrelated root: its own directory is the fixture read boundary. */
export function readDemoRun(path: string): DemoRunResult {
  const absolutePath = resolve(path), root = dirname(absolutePath);
  if (basename(absolutePath) !== "run.json") failure("expected fixture run.json");
  const value = JSON.parse(boundedRead(root, absolutePath, MAX_MANIFEST));
  // Check the anchor before schema validation performs any filesystem checks.
  if (object(value).root !== root) failure("manifest root differs from manifest directory");
  const run = validateRun(value);
  return run;
}

/** Preflight every journal child before handing it to the experiment reader.
 * This is deliberately not a repair or an interpretation of journal records. */
function inspectTree(root: string, directory: string, maxFiles = 512): string[] {
  const files: string[] = []; let entries = 0, total = 0;
  function walk(path: string, depth: number): void {
    safePath(root, path); if (++entries > maxFiles || depth > 12) failure("fixture subtree too large");
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.isDirectory()) { for (const entry of readdirSync(path).sort()) walk(join(path, entry), depth + 1); }
    else {
      if (!stat.isFile() || stat.size > MAX_FILE || (total += stat.size) > 32 * MAX_FILE) failure("unbounded/non-regular fixture input");
      files.push(path);
    }
  }
  walk(directory, 0); return files;
}
function readJournal(root: string, directory: string): DemoJournalRead {
  try { inspectTree(root, directory); return readDemoJournal(directory); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { owner: null, issues: [reason], snapshot: { coverage: { state: "unavailable", source: directory, reason }, events: [], observations: [] } };
  }
}
function check(name: string, passed: boolean, detail: string): DemoCheck { return { name, passed, detail }; }

/** Discover only experiment-owned pin files, not authored sources or an arbitrary
 * provenance path from a message. Selection authority comes from owner refs. */
function pinnedFiles(run: DemoRunResult): string[] {
  const files: string[] = [];
  const entries = readdirSync(run.root).sort();
  if (entries.length > 256) failure("too many fixture root entries");
  for (const entry of entries) {
    const path = join(run.root, entry);
    if (path === run.checkout || path === join(run.root, "run.json") || run.scenarios.some(s => s.journalDirectory === path)
      || run.replayVariants?.some(v => v.directory === path)) continue;
    files.push(...inspectTree(run.root, path, 2048));
    if (files.length > 4096) failure("too many fixture pin files");
  }
  return files;
}
function pinnedPackage(run: DemoRunResult, files: readonly string[], revision: string): { bundle: ContextPackage; directory: string } {
  if (!/^[a-f0-9]{64}$/.test(revision)) failure("invalid protected context revision");
  const candidates = files.filter(path => basename(path) === "manifest.json" && basename(dirname(path)) === revision);
  if (candidates.length !== 1) failure("protected context pin is absent or ambiguous");
  const path = candidates[0]!, bundle = JSON.parse(boundedRead(run.root, path)); validateContextPackage(bundle);
  if (bundle.revision !== revision) failure("protected context pin revision mismatch");
  const directory = dirname(path);
  for (const asset of bundle.assets) {
    const suffix = asset.kind === "procedure" ? asset.source.startsWith("context/worker-procedures/") ? `${asset.id}.md` : `${asset.id}/SKILL.md`
      : asset.kind === "resource" ? asset.source.replace(/^(?:context\/)?skills\//, "") : `${asset.id}.md`;
    const target = resolve(directory, suffix);
    if (!child(directory, target) || contextHash(boundedRead(run.root, target)) !== asset.sha256) failure("pinned asset bytes differ");
  }
  return { bundle, directory };
}
function verifyPins(run: DemoRunResult, journal: DemoJournalRead, message: ContextMessage | null, files: readonly string[]): void {
  const owner = journal.owner; if (!owner) failure("protected owner unavailable");
  const contextRef = owner.activation.saneContext.package, executionRef = owner.activation.saneExecution;
  if (!contextRef || contextRef.schema !== 1 || contextRef.delivery !== "standing-native-role" || !executionRef || executionRef.schema !== 1 || !/^[a-f0-9]{64}$/.test(executionRef.revision)) failure("protected owner lacks paired pins");
  const { bundle, directory } = pinnedPackage(run, files, contextRef.revision);
  if (!same(bundle.identity, owner.agent)) failure("protected context role differs from owner");
  const candidates = files.filter(path => basename(path) === `${executionRef.revision}.json`);
  if (candidates.length !== 1) failure("protected execution pin absent/ambiguous");
  const execution = JSON.parse(boundedRead(run.root, candidates[0]!));
  if (execution.schema !== 1 || execution.revision !== executionRef.revision || !Array.isArray(execution.children)
    || contextHash(JSON.stringify({ schema: execution.schema, policy: execution.policy, children: execution.children })) !== executionRef.revision
    || execution.policy?.spec?.name !== `sane/${owner.agent.kind}/${owner.agent.role}`) failure("protected execution pin differs from owner role/revision");
  const role = bundle.assets.find(asset => asset.kind === "role");
  if (!role || role.text !== execution.policy.spec.body) failure("execution/context role bytes differ");
  if (owner.run.agent !== undefined && (owner.run.agent !== owner.agent.role || owner.run.agentKind !== owner.agent.kind)) failure("run header role differs from owner");
  if (owner.run.saneExecution && !same(owner.run.saneExecution, executionRef)) failure("run header execution pin differs from owner");
  if (!message) return;
  if (message.packageRevision !== null && message.packageRevision !== contextRef.revision) failure("recorded selection context revision differs from owner");
  for (const segment of message.segments) {
    const provenance = segment.provenance;
    const refs = provenance.kind === "asset" ? [provenance.asset] : provenance.kind === "procedure-index" ? provenance.assets : [];
    for (const ref of refs) {
      const asset = bundle.assets.find(asset => asset.id === ref.id);
      if (!asset || asset.source !== ref.source || asset.sha256 !== ref.sha256 || (provenance.kind === "asset" && segment.text !== asset.text)) failure("recorded asset differs from independently selected protected package");
      const suffix = asset.kind === "procedure" ? asset.source.startsWith("context/worker-procedures/") ? `${asset.id}.md` : `${asset.id}/SKILL.md`
        : asset.kind === "resource" ? asset.source.replace(/^(?:context\/)?skills\//, "") : `${asset.id}.md`;
      if (ref.path !== resolve(directory, suffix)) failure("recorded pinned asset path differs from protected package path");
    }
  }
  if (message.placement.kind === "bootstrap" && owner.agent.kind === "assistant") {
    // Generate package selection and index from the OWNER-selected package, not
    // from recorded segment IDs/refs/text. The sentinel fragment/body are never
    // compared as authored state; only independently known package segments are.
    const paths = Object.fromEntries(bundle.assets.map(asset => {
      const suffix = asset.kind === "procedure" ? asset.source.startsWith("context/worker-procedures/") ? `${asset.id}.md` : `${asset.id}/SKILL.md`
        : asset.kind === "resource" ? asset.source.replace(/^(?:context\/)?skills\//, "") : `${asset.id}.md`;
      return [asset.id, resolve(directory, suffix)];
    }));
    validateContextMessageBinding(owner.dispatch.source);
    const expected = composeContextMessage({ binding: owner.dispatch.source, origin: "activation", body: "", placement: { kind: "bootstrap" }, context: { bundle, paths },
      session: { id: "session", category: "session", text: "Replay sentinel, not recorded Session state", source: "replay-only", revision: "replay-only", reason: "replay-only" } });
    const packageContents = (value: ContextMessage) => value.segments.filter(s => s.provenance.kind !== "fragment").map(({ range: _, ...content }) => content);
    if (!same(packageContents(message), packageContents(expected))) failure("bootstrap package selection differs from independent owner-pinned composition");
  }
}

/** Read-only fresh-process reconstruction. No transport, store writer, repair,
 * native harness, or automatic retry is imported or invoked. */
export function replayDemoRun(input: DemoRunResult): DemoReplayResult {
  const run = validateRun(input);
  let files: string[] = [], pinIssue: string | undefined;
  try { files = pinnedFiles(run); } catch (error) { pinIssue = String(error); }
  const journals = new Map(run.scenarios.map(s => [s.id, readJournal(run.root, s.journalDirectory)]));
  const activation = run.scenarios.find(s => s.id === "activation"), bootstrap = journals.get("activation");
  const scenarios = run.scenarios.map(scenario => {
    const journal = journals.get(scenario.id)!;
    const projection = projectContextMessageRestart({ identity: scenario.identity, messageId: scenario.messageId }, journal.snapshot);
    const issues = [...journal.issues];
    const owner = journal.owner;
    const effects = journal.snapshot.events.filter(event => event.kind === "hook"
      && !!event.data && typeof event.data === "object" && (event.data as { type?: unknown }).type === "demo-mock-send");
    const checks: DemoCheck[] = [
      check("recovered expected fact", projection.fact === scenario.expectedFact, `Recovered ${projection.fact}; manifest expectation ${scenario.expectedFact} is not execution proof. Accepted means simulated harness acceptance only.`),
      check("protected owner association", !!owner && same(owner.dispatch, scenario.identity) && owner.messageId === scenario.messageId
        && owner.run.runId === scenario.identity.runId && owner.run.sessionId === scenario.identity.source.sessionId && owner.run.cwd === scenario.identity.source.cwd
        && (owner.run.nativeCommandId === undefined || owner.run.nativeCommandId === scenario.identity.nativeCommandId), "Exact original query dispatch/message/run/session/checkout association; no owner substitution."),
      check("recorded scenario assertions", scenario.checks.length > 0 && scenario.checks.every(c => c.passed), "Recorded scenario assertions, not independently recovered native effects."),
      check("recorded expected mock effects", scenario.mockSends === scenario.expectedMockSends, `Recorded instrumentation: ${scenario.mockSends} sends; expected ${scenario.expectedMockSends}.`),
      check("durable mock effect instrumentation", effects.length === scenario.mockSends && effects.every(event =>
        event.runId === scenario.identity.runId && event.sessionId === scenario.identity.source.sessionId
        && (event.data as { messageId?: unknown }).messageId === scenario.messageId && (event.data as { simulation?: unknown }).simulation === true),
      "Recorded effect counters match exact message-correlated mock hook records; these are simulated effects, not native proof."),
    ];
    if (effects.length) {
      const before = journal.snapshot.observations.find(record => (record.value as { stage?: unknown }).stage === "before-native");
      checks.push(check("durable attempt precedes mock effect", !!before && effects.every(event => before.order < event.seq),
        "The same owner journal orders the fsynced attempt before each scripted mock effect."));
    }
    if (["activation", "ordinary", "update"].includes(scenario.id)) checks.push(check("successful scenario simulated acceptance", projection.fact === "accepted", "Successful mock scenario must independently recover exact correlated simulated acceptance; a changed manifest expectation cannot replace this fact."));
    let message: ContextMessage | null = null;
    try {
      const submissions = journal.snapshot.events.filter(event => event.kind === "submission" && event.runId === scenario.identity.runId && event.sessionId === scenario.identity.source.sessionId
        && !!event.data && typeof event.data === "object" && (event.data as { messageId?: unknown }).messageId === scenario.messageId);
      if (submissions.length > 1) failure("duplicate exact submission");
      if (submissions[0]) {
        const submission = decodeContextMessageSubmission(submissions[0].data);
        message = contextMessageFromSubmission(submission);
        if (!same(submission.composition.dispatch, scenario.identity)) failure("recorded submission dispatch differs from original query");
      }
      checks.push(check("exact recorded bytes and ranges", !["activation", "ordinary", "update", "attempt-unresolved"].includes(scenario.id) || message !== null,
        message ? "Production submission decoder validated UTF-8 ranges, framing, hashes and exact transport; this alone is not source trust." : "No exact submission recorded; no transport body is invented."));
    } catch (error) { issues.push(String(error)); checks.push(check("exact recorded bytes and ranges", false, String(error))); }
    try {
      if (pinIssue) throw new Error(pinIssue);
      verifyPins(run, journal, message, files);
      checks.push(check("independent protected role and pins", true, "Verified owner-selected context/execution revisions and pinned role/asset bytes; not selected from the message."));
    } catch (error) { issues.push(String(error)); checks.push(check("independent protected role and pins", false, String(error))); }
    if (scenario.id === "activation") {
      const expected = owner ? [`role.${owner.agent.kind}.${owner.agent.role}`, ...standingFrameworkNames(owner.agent).map(name => `framework.${name}`), "procedure-index", `sane-assistant-${owner.agent.role}-pickup`, "session"] : [];
      checks.push(check("independent bootstrap selection", !!owner && owner.agent.kind === "assistant" && message?.placement.kind === "bootstrap" && message.origin === "activation"
        && same(message.segments.map(s => s.id), expected) && message.segments.filter(s => s.category === "role").length === 1,
      "Main role once, required standing frameworks, pinned index, correct role Pickup and Session in independent owner-role order."));
      checks.push(check("recorded activation effect count", scenario.mockSends === 1, "Recorded mock instrumentation must show exactly one send."));
    }
    if (scenario.id === "ordinary") {
      checks.push(check("ordinary is exact authored body", message?.placement.kind === "body-only" && message.segments.length === 0 && message.packageRevision === null && message.transport.text === message.body.text,
        "No marker stripping or implicit context; exact decoded authored bytes equal recorded transport."));
      checks.push(check("recorded ordinary loader boundaries", scenario.contextLoads === 0 && scenario.executionLoads > 0 && scenario.mockSends === 1
        && scenario.contextLoads === scenario.trace.filter(item => item === "load:context").length
        && scenario.executionLoads === scenario.trace.filter(item => item === "load:execution").length
        && scenario.pairingChecks === scenario.trace.filter(item => item.startsWith("pairing:")).length,
        "Recorded instrumentation only: zero context loads; execution/pairing counters match the recorded trace; exactly one mock send. Historical and current schema-1 counts are diagnostic, not native acceptance authority."));
      const bootstrapProjection = activation && bootstrap ? projectContextMessageRestart({ identity: activation.identity, messageId: activation.messageId }, bootstrap.snapshot) : null;
      checks.push(check("ordinary durable bootstrap pairing", !!owner && !!bootstrap?.owner && !!activation && same(bootstrap.owner.dispatch, activation.identity)
        && bootstrap.owner.messageId === activation.messageId && bootstrapProjection?.fact === "accepted" && bootstrapProjection.coverage.state === "complete"
        && same(owner.agent, bootstrap.owner.agent) && same(owner.activation, bootstrap.owner.activation) && same(owner.dispatch.source, bootstrap.owner.dispatch.source),
      "Protected bootstrap owner's role, context/execution pins and exact finalized native binding must pair; simulated acceptance is not retained model memory."));
    }
    if (scenario.id === "update") checks.push(check("Session-only explicit update", message?.placement.kind === "selected" && message.placement.purpose === "update" && message.origin === "context-update"
      && message.segments.length === 1 && message.segments[0]?.id === "session" && message.segments[0]?.category === "session" && message.packageRevision === null && scenario.mockSends === 1,
    "Exactly selected Session fragment; no role, framework or Pickup resend. Fragment semantics and loader counters remain recorded scenario instrumentation."));
    if (["stale-source", "owner-refusal", "persistence-failure"].includes(scenario.id)) checks.push(check("recorded failure has no mock effects", scenario.mockSends === 0 && scenario.expectedMockSends === 0
      && projection.fact !== "accepted" && projection.fact !== "submitted-unconfirmed" && projection.fact !== "submitted-not-accepted", "Zero sends is recorded mock instrumentation; durable projection independently must not establish submission/acceptance."));
    if (scenario.id === "owner-refusal") checks.push(check("genuine owner withholding recovered", projection.fact === "withheld", "Only exact correlated owner non-submission establishes withholding; errors or an edited expectation cannot certify refusal."));
    if (scenario.id === "attempt-unresolved") checks.push(check("unresolved attempt never authorizes resend", projection.fact === "attempt-unresolved" && scenario.mockSends === 1 && scenario.expectedMockSends === 1,
      "One scripted effect followed by unknown outcome remains unresolved; read-only replay never sends, retries or repairs. This is not a killed native process."));
    // Partial coverage is intentional for persistence failure, but a healthy
    // scenario cannot pass just because its manifest also expected unknown.
    checks.push(check("scenario coverage boundary", scenario.id === "persistence-failure" ? projection.coverage.state !== "complete" && projection.fact === "unknown" : projection.coverage.state === "complete" && journal.issues.length === 0,
      `${projection.coverage.state}: ${projection.coverage.reason ?? projection.reason}`));
    return { scenario, projection, message, issues, checks };
  });
  const variants = (run.replayVariants ?? []).map(variant => {
    const journal = readJournal(run.root, variant.directory);
    const projection = projectContextMessageRestart({ identity: variant.identity, messageId: variant.messageId }, journal.snapshot);
    return { id: variant.id, directory: variant.directory, projection, checks: [
      check("original activation query retained", !!activation && same(projection.identity, activation.identity) && projection.messageId === activation.messageId, "Corruption never changes the query to fit surviving owner records."),
      check("incomplete restart stays unknown", projection.coverage.state !== "complete" && projection.fact === "unknown", `${projection.coverage.state}: ${projection.coverage.reason ?? projection.reason}; read-only, no resend.`),
    ] };
  });
  return { schema: 1, type: "mock-context-demo-replay", simulation: true, root: run.root, scenarios, variants,
    passed: scenarios.every(s => s.checks.every(c => c.passed)) && variants.every(v => v.checks.every(c => c.passed)) };
}
