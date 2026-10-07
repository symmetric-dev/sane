import { expect, test } from "bun:test";
import { ConversationListing } from "./conversation-listing";

const listing = (canSend = true) => ({ conversations: [], availability: { canSend } });
const signal = () => new AbortController().signal;

test("concurrent reads share acquisition; completed results have bounded freshness", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof listing>>();
  let calls = 0, now = 0;
  const source = new ConversationListing(async () => { calls++; return pending.promise; }, 1000, () => now);
  const main = source.read(signal()), notifications = source.read(signal());
  await Promise.resolve(); expect(calls).toBe(1);
  pending.resolve(listing());
  expect((await main).value).toBe((await notifications).value);
  now = 999; await source.read(signal()); expect(calls).toBe(1);
  now = 1000; await source.read(signal()); expect(calls).toBe(2);
});

test("one consumer abort does not abort its peer; the last cancellation abandons transport", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof listing>>();
  let transport!: AbortSignal;
  const source = new ConversationListing(async signal => { transport = signal!; return pending.promise; });
  const first = new AbortController(), second = new AbortController();
  const a = source.read(first.signal), b = source.read(second.signal);
  await Promise.resolve(); first.abort();
  await expect(a).rejects.toHaveProperty("name", "AbortError");
  expect(transport.aborted).toBe(false);
  pending.resolve(listing()); expect((await b).value.availability.canSend).toBe(true);

  source.invalidate();
  const abandoned = new AbortController();
  const read = source.read(abandoned.signal);
  await Promise.resolve();
  abandoned.abort();
  await expect(read).rejects.toHaveProperty("name", "AbortError");
  expect(transport.aborted).toBe(true);
});

test("invalidation retries live consumers together and fences a transport ignoring abort", async () => {
  const stale = Promise.withResolvers<ReturnType<typeof listing>>(), fresh = Promise.withResolvers<ReturnType<typeof listing>>();
  let calls = 0;
  const source = new ConversationListing(() => ++calls === 1 ? stale.promise : fresh.promise);
  const a = source.read(signal()), b = source.read(signal());
  await Promise.resolve(); source.invalidate();
  fresh.resolve(listing(false));
  expect((await a).value.availability.canSend).toBe(false);
  expect((await b).revision).toBe(source.revision);
  stale.resolve(listing(true)); await Promise.resolve();
  expect((await source.read(signal())).value.availability.canSend).toBe(false);
  expect(calls).toBe(2);
});

test("auth teardown cancels old consumers before invalidation, including late failures", async () => {
  const old = Promise.withResolvers<ReturnType<typeof listing>>();
  let calls = 0;
  const source = new ConversationListing(() => ++calls === 1 ? old.promise : Promise.resolve(listing(false)));
  const auth = new AbortController(), previous = source.read(auth.signal);
  await Promise.resolve(); auth.abort(); source.invalidate();
  await expect(previous).rejects.toHaveProperty("name", "AbortError");
  expect((await source.read(signal())).value.availability.canSend).toBe(false);
  old.reject(new Error("old auth failure"));
  await Promise.resolve(); await source.read(signal()); expect(calls).toBe(2);
});

test("failed and malformed reads are not cached; explicit invalidation bypasses fresh results", async () => {
  let calls = 0;
  const source = new ConversationListing(async () => {
    calls++;
    if (calls === 1) throw new Error("offline");
    if (calls === 2) return { ...listing(), conversations: null } as any;
    return listing(calls === 3);
  });
  await expect(source.read(signal())).rejects.toThrow("offline");
  await expect(source.read(signal())).rejects.toThrow("Invalid conversation listing");
  expect((await source.read(signal())).value.availability.canSend).toBe(true);
  source.invalidate();
  expect((await source.read(signal())).value.availability.canSend).toBe(false);
  expect(calls).toBe(4);
});
