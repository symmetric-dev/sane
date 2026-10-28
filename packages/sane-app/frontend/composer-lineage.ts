/** Caller-owned editor lifetime and draft lineage. Never persist/reuse editorId
 * across reloads: a recovered request must not clear a fresh editor's draft. */
export type ComposerStamp = Readonly<{
  editorId: string;
  chainId: string;
  revision: number;
}>;

const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

function check(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid composer stamp");
}

function stampObject(value: unknown): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const keys = ["editorId", "chainId", "revision"];
  check(Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
  check(Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor && descriptor.enumerable));
}

export function decodeComposerStamp(value: unknown): ComposerStamp {
  stampObject(value);
  check(uuid(value.editorId) && uuid(value.chainId));
  check(typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0);
  return Object.freeze({ editorId: value.editorId, chainId: value.chainId, revision: value.revision });
}

/** Does not allocate an editor or chain ID. Overflow fails rather than aliasing
 * a revision and accidentally authorizing a stale draft clear. */
export function advanceComposerStamp(stamp: ComposerStamp): ComposerStamp {
  const current = decodeComposerStamp(stamp);
  check(current.revision < Number.MAX_SAFE_INTEGER);
  return Object.freeze({ ...current, revision: current.revision + 1 });
}

export function sameComposerStamp(left: ComposerStamp, right: ComposerStamp): boolean {
  const a = decodeComposerStamp(left), b = decodeComposerStamp(right);
  return a.editorId === b.editorId && a.chainId === b.chainId && a.revision === b.revision;
}
