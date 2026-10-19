import type { Plugin } from "@opencode/plugin"
import type { OperationPermission } from "../../../packages/sane-app/src/canonical-agent-operations.ts"
import { nativeConversationEnrolled } from "../../../packages/sane-cli/src/native-caller.ts"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
/** true = eligible, false = definitively not, undefined = cannot decide now. */
type Eligibility = boolean | undefined

/** Session rules appended for sessions SANE does not manage. OC rebuilds
 * Tool.snapshot every step and drops a tool whose LAST matching rule is
 * {glob(action) matches id, resource "*", deny}: it disappears from the direct
 * list, Code Mode catalog, search and execute. Explicit denies (rather than
 * deny `sane_*` + allow handoff) keep sane_handoff/sane_handoff_status — the
 * kickoff bootstrap — visible without overriding any agent/user rule for them.
 * Visibility only: every handler still qualifies and authorizes the caller. */
export const UNMANAGED_RULES: readonly OperationPermission[] = [
  { action: "sane_worker_*", resource: "*", effect: "deny" },
  { action: "sane_link", resource: "*", effect: "deny" },
  { action: "sane_context", resource: "*", effect: "deny" },
]
const ours = (rule: OperationPermission) => UNMANAGED_RULES.some(r => r.action === rule.action && r.resource === rule.resource && r.effect === rule.effect)
const PROMPT_BUDGET_MS = 5000

/** Per-session SANE tool visibility.
 *
 * Eligible = the session or a native ancestor is (a) a canonical execution
 * binding (App-configured root) or (b) a registered conversation in its
 * repository domain (App admission registers before the first prompt; a
 * kickoff registers its sender). Native children inherit the parent's session
 * permissions, and are judged by their ancestry, so children of managed roots
 * stay eligible and children of ordinary roots stay hidden.
 *
 * Decision points: the prompt hook (awaited, bounded) decides before the first
 * step and re-checks non-eligible sessions on every prompt, so an App session
 * observed before admission registration self-heals before it runs. The
 * context hook is a non-blocking backstop for sessions first seen there.
 * Eligibility is sticky (never true -> false); unknown never writes. */
export function createSaneVisibility(ctx: Context, options: { registrationFile: unknown; managed: (sessionID: string) => boolean }) {
  const enrolled = new Map<string, boolean>()
  const parents = new Map<string, string | null>()
  const hidden = new Map<string, boolean>()
  const queues = new Map<string, Promise<void>>()
  const seen = new Set<string>()

  const lookup = async (sessionID: string): Promise<Eligibility> => {
    let session: Awaited<ReturnType<Context["session"]["get"]>>
    try { session = await ctx.session.get({ sessionID }) } catch { return undefined }
    parents.set(sessionID, session.parentID ?? null)
    const registration = options.registrationFile, directory = session.location?.directory
    if (typeof registration !== "string" || !registration.startsWith("/") || typeof directory !== "string") return undefined
    return nativeConversationEnrolled({ version: 1, harness: "oc", kind: "local-registration", registrationFile: registration }, sessionID, directory)
  }
  const own = async (sessionID: string, refresh: boolean): Promise<Eligibility> => {
    if (options.managed(sessionID) || enrolled.get(sessionID) === true) return true
    if (enrolled.has(sessionID) && !refresh) return false
    const result = await lookup(sessionID)
    if (result !== undefined) enrolled.set(sessionID, result)
    return result
  }
  const parentOf = async (sessionID: string) => {
    if (!parents.has(sessionID)) parents.set(sessionID, (await ctx.session.get({ sessionID })).parentID ?? null)
    return parents.get(sessionID) ?? null
  }
  const evaluate = async (sessionID: string, refresh: boolean): Promise<Eligibility> => {
    let unknown = false
    const visited = new Set<string>()
    for (let current: string | null = sessionID; current && !visited.has(current) && visited.size < 64; current = await parentOf(current)) {
      visited.add(current)
      const result = await own(current, refresh)
      if (result === true) return true
      if (result === undefined) unknown = true
    }
    return unknown ? undefined : false
  }
  const apply = async (sessionID: string, eligible: Eligibility) => {
    if (eligible === undefined) return
    const hide = !eligible
    if (hidden.get(sessionID) === hide) return
    const session = await ctx.session.get({ sessionID })
    const current = (session.permissions ?? []) as OperationPermission[]
    // Idempotent: any present rule is kept in place; user rules after it win.
    const next = hide ? [...current, ...UNMANAGED_RULES.filter(rule => !current.some(r => r.action === rule.action && r.resource === rule.resource && r.effect === rule.effect))]
      : current.filter(rule => !ours(rule))
    // session.update REPLACES the list: merge from a fresh read, write only on change.
    if (next.length !== current.length) await ctx.session.update({ sessionID, permissions: next })
    hidden.set(sessionID, hide)
  }
  /** Serialized per session; never throws (a throwing context hook fails the request). */
  const sync = (sessionID: string, refresh: boolean) => {
    const run = (queues.get(sessionID) ?? Promise.resolve()).then(async () => apply(sessionID, await evaluate(sessionID, refresh))).catch(() => {})
    queues.set(sessionID, run)
    void run.finally(() => { if (queues.get(sessionID) === run) queues.delete(sessionID) })
    return run
  }
  const bounded = (work: Promise<void>) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, PROMPT_BUDGET_MS)
    timer.unref?.()
    void work.finally(() => { clearTimeout(timer); resolve() })
  })

  return {
    /** Awaited before the first step. Bounded so an unexpected lock between
     * session.update and prompt admission degrades to the context backstop. */
    prompt: async (sessionID: string) => { seen.add(sessionID); await bounded(sync(sessionID, true)) },
    /** First sighting only (e.g. plugin reload mid-session); effective next step. */
    context: (sessionID: string) => { if (seen.has(sessionID)) return; seen.add(sessionID); void sync(sessionID, false) },
    /** After a kickoff may have enrolled the caller. */
    refresh: (sessionID: string) => { void sync(sessionID, true) },
    clear: () => { enrolled.clear(); parents.clear(); hidden.clear(); seen.clear() },
  }
}
