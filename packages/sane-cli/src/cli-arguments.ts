/** Pure syntax boundary. No ambient environment, filesystem, or core access.
 * SANE_CALLER_CONTEXT is JSON: either the full envelope {version:1,
 * repository:string, source:SourceInput, authorityId:string, nativeId:string}
 * or the C11 Phase 4 compact shell reference {version:1, harness, nativeId}.
 * Before enrollment, native hooks supply the full envelope plus bootstrap:true
 * and executionCheckout; that form is restricted to init/inspect.
 * The compact form carries no absolute paths or authority digests; the server
 * side resolves them from the enrolled conversation. Source locators are
 * syntactically absolute; canonicalization, digest agreement and
 * repository/pin validation belong to core.
 */
export type Harness = "cc" | "oc"
export type SourceInput =
  | { version: 1; harness: "cc"; kind: "local-profile"; profileRoot: string }
  | { version: 1; harness: "oc"; kind: "local-registration"; registrationFile: string }
export type QualifiedRef = { harness: Harness; authorityId: string; nativeId: string }
export type CallerEnvelope = { version: 1; repository: string; source: SourceInput; authorityId: string; nativeId: string }
/** C11 Phase 4 minimal per-shell-call reference. No paths, no authority digest. */
export type CallerReference = { version: 1; harness: Harness; nativeId: string }
/** Hook-qualified identity before enrollment; permits repository bootstrap only. */
export type CallerBootstrap = CallerEnvelope & { bootstrap: true; executionCheckout: string }
export type CallerClassification = { actorKind: "local" } | { actorKind: "native"; envelope: CallerEnvelope } | { actorKind: "native-ref"; ref: CallerReference } | { actorKind: "native-bootstrap"; envelope: CallerBootstrap }
export type CallerSignals = Readonly<Partial<Record<"SANE_CALLER_CONTEXT" | "SANE_SESSION_ID" | "OPENCODE_SESSION_ID", string>>>
export type CliIntent = {
  operation: string
  repository?: string
  workstream?: string
  caller: CallerClassification
  options: Readonly<Record<string, string | boolean>>
  positionals: readonly string[]
}
export type CliParseResult =
  | { kind: "help"; command?: string }
  | { kind: "unavailable"; code: "FEATURE_UNAVAILABLE"; command: string }
  | { kind: "command"; intent: CliIntent }
  | { kind: "error"; code: "INVALID_ARGUMENT" | "NATIVE_CONTEXT_UNAVAILABLE"; message: string }

class ParseFailure extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "NATIVE_CONTEXT_UNAVAILABLE", message: string) { super(message) }
}
function fail(message: string): never { throw new ParseFailure("INVALID_ARGUMENT", message) }
function nativeFail(): never { throw new ParseFailure("NATIVE_CONTEXT_UNAVAILABLE", "Native caller evidence is incomplete, malformed, or conflicting.") }
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return nativeFail()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) nativeFail()
}
function json(value: string): unknown { try { return JSON.parse(value) } catch { return nativeFail() } }
export function parseSourceInput(value: unknown): SourceInput {
  const source = object(value)
  if (source.harness !== "cc" && source.harness !== "oc") nativeFail()
  const locator = source.harness === "cc" ? "profileRoot" : "registrationFile"
  exact(source, ["version", "harness", "kind", locator])
  if (source.version !== 1 ||
    source.kind !== (source.harness === "cc" ? "local-profile" : "local-registration") ||
    !nonempty(source[locator]) || !(source[locator] as string).startsWith("/")) nativeFail()
  return source.harness === "cc"
    ? { version: 1, harness: "cc", kind: "local-profile", profileRoot: source[locator] as string }
    : { version: 1, harness: "oc", kind: "local-registration", registrationFile: source[locator] as string }
}
function envelope(value: unknown): CallerEnvelope {
  const input = object(value)
  exact(input, ["version", "repository", "source", "authorityId", "nativeId"])
  if (input.version !== 1 || !nonempty(input.repository) || !input.repository.startsWith("/") ||
    !nonempty(input.authorityId) || !nonempty(input.nativeId)) nativeFail()
  return { version: 1, repository: input.repository, source: parseSourceInput(input.source), authorityId: input.authorityId, nativeId: input.nativeId }
}
function reference(value: unknown): CallerReference {
  const input = object(value)
  exact(input, ["version", "harness", "nativeId"])
  if (input.version !== 1 || (input.harness !== "cc" && input.harness !== "oc") || !nonempty(input.nativeId)) nativeFail()
  return { version: 1, harness: input.harness, nativeId: input.nativeId }
}
const callerFlags = ["caller-repo", "caller-source", "caller-authority", "caller-native-id"]
export function classifyCaller(signals: CallerSignals, flags: Readonly<Record<string, string | boolean>> = {}): CallerClassification {
  let caller: CallerEnvelope | undefined
  let ref: CallerReference | undefined
  let bootstrap: CallerBootstrap | undefined
  if (signals.SANE_CALLER_CONTEXT !== undefined) {
    const parsed = json(signals.SANE_CALLER_CONTEXT)
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : []
    if (keys.length === 3 && keys.includes("version") && keys.includes("harness") && keys.includes("nativeId")) ref = reference(parsed)
    else if (keys.includes("bootstrap")) {
      const input = object(parsed)
      exact(input, ["version", "repository", "source", "authorityId", "nativeId", "bootstrap", "executionCheckout"])
      if (input.bootstrap !== true || !nonempty(input.executionCheckout) || !input.executionCheckout.startsWith("/")) nativeFail()
      const { bootstrap: _bootstrap, executionCheckout, ...identity } = input
      caller = envelope(identity)
      bootstrap = { ...caller, bootstrap: true, executionCheckout: executionCheckout as string }
    } else caller = envelope(parsed)
  }
  if (callerFlags.some(key => flags[key] !== undefined)) {
    if (bootstrap) nativeFail()
    if (!callerFlags.every(key => nonempty(flags[key]))) nativeFail()
    const explicit = envelope({ version: 1, repository: flags["caller-repo"], source: json(flags["caller-source"] as string), authorityId: flags["caller-authority"], nativeId: flags["caller-native-id"] })
    if (caller && JSON.stringify(caller) !== JSON.stringify(explicit)) nativeFail()
    if (ref && (explicit.source.harness !== ref.harness || explicit.nativeId !== ref.nativeId)) nativeFail()
    caller = explicit
  }
  const nativeId = caller?.nativeId ?? ref?.nativeId
  const harness = caller ? caller.source.harness : ref?.harness
  for (const key of ["SANE_SESSION_ID", "OPENCODE_SESSION_ID"] as const) {
    if (signals[key] !== undefined && (!nativeId || !nonempty(signals[key]) || signals[key] !== nativeId || (key === "OPENCODE_SESSION_ID" && harness !== "oc"))) nativeFail()
  }
  if (bootstrap) return { actorKind: "native-bootstrap", envelope: bootstrap }
  if (caller) return { actorKind: "native", envelope: caller }
  if (ref) return { actorKind: "native-ref", ref }
  return { actorKind: "local" }
}

const retired = new Set(["candidate", "link", "handoff", "worktree", "merge", "delete", "archive", "purge", "rename"])
const phases = ["design", "engineering", "planning", "execution"]
const flagsBoolean = new Set(["json", "verbose", "refresh-templates", "register", "clear", "dry-run"])
const managed = ["harness", "authority", "native-id"]
const parent = ["parent-harness", "parent-authority", "parent-native-id"]
const common = ["repo", "workstream", "json", "verbose", ...callerFlags]
const commandFlags: Record<string, string[]> = {
  "native-config": ["plugin-directory", "registration-file", "profile-root", "binding-root", "bun-executable", "app-connection-file", "format"],
  init: ["dry-run"], inspect: [], create: ["name", "title", "type", "dry-run"], list: [], detail: [], status: [], view: [], select: ["dry-run"],
  provide: ["refresh-templates"], validate: ["id"], approve: ["ref"], job: ["register"], research: ["topic", "path"],
  sessions: ["slot"], audit: [], "default-checkout": ["checkout", "clear"],
  authority: ["source"], conversation: [...managed, ...parent, "checkout"], phase: [...managed, "assignment-id"],
}
function safeId(value: string): void { if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(value)) fail("Expected a safe lowercase identifier.") }

/** Arguments exclude the executable. Help/retired commands terminate without caller/domain work. */
export function parseCliCommand(args: readonly string[], signals: CallerSignals = {}): CliParseResult {
  const command = args[0]
  if (!command || command === "help" || args.includes("--help") || args.includes("-h")) return { kind: "help", command }
  if (retired.has(command)) return { kind: "unavailable", code: "FEATURE_UNAVAILABLE", command }
  try {
    // Even invalid explicit targets cannot turn bare native signals into local calls.
    const options: Record<string, string | boolean> = {}
    const positionals: string[] = []
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!
      if (!arg.startsWith("-")) { positionals.push(arg); continue }
      if (!arg.startsWith("--") || arg.includes("=")) fail("Use --flag value syntax.")
      const key = arg.slice(2)
      if (Object.hasOwn(options, key)) fail(`Duplicate flag --${key}.`)
      if (![...common, ...(Object.hasOwn(commandFlags, command) ? commandFlags[command]! : [])].includes(key)) fail(`Unknown flag --${key}.`)
      if (flagsBoolean.has(key)) options[key] = true
      else {
        const value = args[++i]
        if (!nonempty(value) || value.startsWith("-")) {
          if (callerFlags.includes(key)) nativeFail()
          fail(`Missing value for --${key}.`)
        }
        options[key] = value
      }
    }
    const caller = classifyCaller(signals, options)
    if (caller.actorKind === "native-bootstrap" && !["init", "inspect"].includes(command)) throw new ParseFailure("NATIVE_CONTEXT_UNAVAILABLE", "Native conversation is not enrolled. Run sane init if needed, then sane_link with empty arguments or a kickoff sane_handoff.")
    if (!Object.hasOwn(commandFlags, command)) fail("Unknown command.")
    if (options.json && options.verbose) fail("--json conflicts with --verbose.")
    if (options.workstream) safeId(options.workstream as string)
    const requireFlags = (...keys: string[]) => { for (const key of keys) if (!options[key]) fail(`Required --${key}.`) }
    const only = (...keys: string[]) => {
      for (const key of Object.keys(options)) if (!common.includes(key) && !keys.includes(key)) fail(`Unexpected --${key} for this operation.`)
    }
    const count = (min: number, max = min) => { if (positionals.length < min || positionals.length > max) fail("Unexpected or missing positional arguments.") }
    const ref = (prefix = "") => {
      requireFlags(`${prefix}harness`, `${prefix}authority`, `${prefix}native-id`)
      if (!["cc", "oc"].includes(options[`${prefix}harness`] as string)) fail("Invalid harness.")
    }
    let operation: string = command
    switch (command) {
      case "native-config":
        count(0)
        requireFlags("plugin-directory", "registration-file", "profile-root", "binding-root", "bun-executable", "app-connection-file")
        if (caller.actorKind !== "local" || options.repo || options.workstream) fail("Native configuration requires a local invocation without repository or workstream selectors.")
        if (options.format && !["all", "opencode", "claude-mcp", "claude-settings"].includes(options.format as string)) fail("Invalid native configuration format.")
        break
      case "view": case "status": case "detail":
        count(0, 1)
        if (positionals[0]) { if (options.workstream) fail("Choose positional ID or --workstream, not both."); safeId(positionals[0]); options.workstream = positionals[0] }
        break
      case "create": count(0); requireFlags("name", "type"); safeId(options.name as string); if (options.workstream) fail("Use --name, not --workstream, for creation."); if (!["feature", "foundation", "issue", "maintenance"].includes(options.type as string)) fail("Invalid workstream type."); break
      case "select": count(0); requireFlags("workstream"); if (caller.actorKind !== "local") fail("Selection is only for local invocations."); break
      case "sessions": count(0); if (options.slot && ![...phases, "research"].includes(options.slot as string) && !/^research:[a-z0-9][a-z0-9_-]{0,95}$/.test(options.slot as string)) fail("Invalid phase slot."); break
      case "provide": case "approve": case "validate":
        count(1, command === "validate" ? 2 : 1)
        if (!phases.includes(positionals[0]!)) fail("Invalid approval phase.")
        if (command === "approve") requireFlags("ref")
        if (command === "validate") {
          if (positionals.length === 2) { if (positionals[0] !== "execution" || positionals[1] !== "report") fail("Invalid report validation."); requireFlags("id"); safeId(options.id as string) }
          else if (options.id) fail("--id requires execution report.")
        }
        break
      case "job":
        if (options.register) { count(0); operation = "job.register" }
        else { count(1, 2); safeId(positionals[0]!); if (positionals[1] && !["running", "completed"].includes(positionals[1])) fail("Invalid job progression."); operation = positionals[1] ? "job.update" : "job.context" }
        break
      case "research": {
        count(0, 1)
        const action = positionals[0] ?? "index"
        if (!["index", "register", "unregister"].includes(action)) fail("Invalid research subcommand.")
        if (action === "index") only()
        else { requireFlags("topic"); safeId(options.topic as string); if (action === "register") requireFlags("path"); else only("topic") }
        operation = `research.${action}`; break
      }
      case "default-checkout": count(0); requireFlags("workstream"); if (Boolean(options.checkout) === Boolean(options.clear)) fail("Supply exactly one of --checkout or --clear."); break
      case "authority": count(1); if (positionals[0] !== "declare") fail("Invalid authority subcommand."); requireFlags("repo", "source"); parseSourceInput(json(options.source as string)); operation = "authority.declare"; break
      case "conversation": {
        count(1); requireFlags("repo"); ref()
        const action = positionals[0]!
        if (!["register", "get", "context", "associate", "unassign"].includes(action)) fail("Invalid conversation subcommand.")
        if (action === "register") { requireFlags("checkout"); if (parent.some(key => options[key] !== undefined)) ref("parent-"); if (options.workstream) fail("Registration does not implicitly associate; use conversation associate.") }
        else only(...managed)
        if (action === "associate") requireFlags("workstream")
        else if (options.workstream) fail("Unexpected workstream selector for this conversation operation.")
        operation = `conversation.${action}`; break
      }
      case "phase": {
        requireFlags("repo")
        const action = positionals[0]
        if (action === "end") { count(1); requireFlags("assignment-id"); only("assignment-id"); if (options.workstream) fail("End uses the exact assignment ID only.") }
        else if (action === "assign" || action === "target") { count(2); if (![...phases, "research"].includes(positionals[1]!) && !/^research:[a-z0-9][a-z0-9_-]{0,95}$/.test(positionals[1]!)) fail("Invalid phase slot."); only(...managed); if (action === "assign" || managed.some(key => options[key] !== undefined)) ref(); if (action === "target") requireFlags("workstream"); else if (options.workstream) fail("Assignment uses persisted membership.") }
        else fail("Invalid phase subcommand.")
        operation = `phase.${action}`; break
      }
      default: count(0)
    }
    if (["init", "inspect", "list", "authority", "sessions"].includes(command) && options.workstream && command !== "sessions") fail("Unexpected workstream selector.")
    return { kind: "command", intent: { operation, repository: options.repo as string | undefined, workstream: options.workstream as string | undefined, caller, options, positionals } }
  } catch (error) {
    if (error instanceof ParseFailure) return { kind: "error", code: error.code, message: error.message }
    throw error
  }
}
