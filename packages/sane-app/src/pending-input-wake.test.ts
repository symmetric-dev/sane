import { expect, test } from "bun:test";
import { createPendingInputWake, PENDING_INPUT_WAKE_BACKSTOP_MS, type PendingInputWake, type PendingInputWakeClock, type PendingInputWakeDependencies, type PendingInputWakeTimer } from "./pending-input-wake";

function testClock(backstopMs?: number) {
  const microtasks: Array<() => void> = [];
  const timers = new Map<PendingInputWakeTimer, () => void>();
  const delays: number[] = [];
  let unrefs = 0, cleared = 0;
  const clock: PendingInputWakeClock = {
    backstopMs,
    queueMicrotask: callback => { microtasks.push(callback); },
    setInterval: (callback, delayMs) => {
      delays.push(delayMs);
      const timer = { unref: () => { unrefs++; } };
      timers.set(timer, callback);
      return timer;
    },
    clearInterval: timer => { cleared++; timers.delete(timer); },
  };
  return {
    clock, microtasks, timers, delays,
    get unrefs() { return unrefs; },
    get cleared() { return cleared; },
    flush: () => { for (const callback of microtasks.splice(0)) callback(); },
    tick: () => { for (const callback of [...timers.values()]) callback(); },
  };
}

test("explicit healthy start, coalesced hints/backstop, no dirty spin, synchronous terminal close", () => {
  const time = testClock();
  let healthy = false, work = false, polls = 0;
  const errors: unknown[] = [];
  const wake = createPendingInputWake({
    canRun: () => healthy, hasWork: () => work,
    poll: () => { polls++; wake.notify("domain"); },
    onError: error => { errors.push(error); },
  }, time.clock);
  wake.notify("enqueue"); time.tick(); time.flush(); wake.start();
  expect(wake.isStarted()).toBe(false);
  expect(time.timers.size).toBe(0);
  healthy = true; work = true;
  wake.notify("lifecycle"); time.flush();
  expect(polls).toBe(0); // Becoming healthy cannot implicitly start it.
  work = false; wake.start(); wake.start(); time.flush();
  expect(wake.isStarted()).toBe(true);
  expect(polls).toBe(0);
  expect(time.delays).toEqual([PENDING_INPUT_WAKE_BACKSTOP_MS]);
  expect(time.delays[0]).toBe(15_000);
  expect(time.unrefs).toBe(1);
  time.tick(); time.flush(); expect(polls).toBe(0);
  work = true;
  wake.notify("enqueue"); wake.notify("remove"); wake.notify("resume");
  wake.notify("domain"); wake.notify("capacity"); wake.notify("lifecycle");
  expect(time.microtasks.length).toBe(1);
  time.flush(); expect(polls).toBe(1);
  expect(time.microtasks.length).toBe(0);
  time.flush(); expect(polls).toBe(1); // Hint from inside poll does not self-spin.
  time.tick(); time.flush(); expect(polls).toBe(2);
  healthy = false;
  wake.notify("capacity"); time.tick(); time.flush(); expect(polls).toBe(2);
  healthy = true;
  wake.notify("capacity"); time.flush(); expect(polls).toBe(3);
  healthy = false; time.tick(); time.flush();
  healthy = true; time.tick(); time.flush(); expect(polls).toBe(4);
  work = false;
  wake.notify("remove"); time.tick(); time.flush(); expect(polls).toBe(4);
  work = true;
  const alreadyQueuedTick = [...time.timers.values()][0]!;
  wake.notify("enqueue");
  wake.close(); wake.close(); wake.start();
  expect(wake.isStarted()).toBe(false);
  expect(time.timers.size).toBe(0);
  expect(time.cleared).toBe(1);
  alreadyQueuedTick(); time.flush(); time.tick(); wake.notify("resume"); time.flush();
  expect(polls).toBe(4);
  expect(time.delays).toEqual([15_000]);
  expect(errors).toEqual([]);

  const initial = testClock(5_000);
  let initialPolls = 0;
  const initiallyReady = createPendingInputWake({ canRun: () => true, hasWork: () => true,
    poll: () => { initialPolls++; }, onError: () => {} }, initial.clock);
  initiallyReady.start(); initiallyReady.start(); initial.flush();
  expect(initialPolls).toBe(1);
  expect(initial.delays).toEqual([5_000]);
  initiallyReady.close();
});

test("unsafe predicate values close before timer/poll, inspect once and consume rejection", async () => {
  const fault = new Error("unsafe predicate");
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const factories = [
      () => ({ value: Promise.resolve(true), error: "must be synchronous" }),
      () => ({ value: Promise.reject(fault), error: "must be synchronous" }),
      () => {
        let reads = 0;
        return { value: Object.defineProperty({}, "then", { get: () => { reads++; throw fault; } }),
          error: fault, reads: () => reads };
      },
      () => {
        let reads = 0;
        return { value: Object.defineProperty({}, "then", { get: () => {
          reads++;
          if (reads > 1) throw new Error("then getter reread");
          return (_resolve: unknown, reject: (error: unknown) => void) => reject(fault);
        } }), error: "must be synchronous", reads: () => reads };
      },
      ...[1, undefined, null, {}].map(value => () => ({ value, error: "must return a boolean" })),
    ];
    for (const phase of ["start", "flush"] as const) {
      for (const predicate of ["canRun", "hasWork"] as const) {
        for (const factory of factories) {
          const unsafe = factory(); // Fresh promises/getter counters for every failure boundary.
          const time = testClock();
          const errors: unknown[] = [];
          let inject = phase === "start", polls = 0, predicateCalls = 0;
          let wake!: PendingInputWake;
          const deps: PendingInputWakeDependencies = {
            canRun: () => true, hasWork: () => true,
            poll: () => { polls++; },
            onError: error => {
              expect(wake.isStarted()).toBe(false);
              expect(time.timers.size).toBe(0);
              errors.push(error);
              wake.start(); wake.notify("resume");
            },
          };
          wake = createPendingInputWake({ ...deps, [predicate]: () => {
            predicateCalls++;
            return inject ? unsafe.value as boolean : true;
          } }, time.clock);
          wake.start();
          if (phase === "flush") {
            expect(wake.isStarted()).toBe(true);
            expect(time.microtasks.length).toBe(1);
            inject = true;
            time.flush();
          }
          expect(errors.length).toBe(1);
          if (typeof unsafe.error === "string") {
            expect(errors[0]).toBeInstanceOf(Error);
            expect((errors[0] as Error).message).toContain(unsafe.error);
          } else expect(errors[0]).toBe(unsafe.error);
          if ("reads" in unsafe) expect(unsafe.reads()).toBe(1);
          expect(predicateCalls).toBe(phase === "start" ? 1 : 2);
          expect(polls).toBe(0);
          expect(time.delays).toEqual(phase === "start" ? [] : [15_000]);
          expect(time.cleared).toBe(phase === "start" ? 0 : 1);
          wake.start(); wake.notify("enqueue"); time.tick(); time.flush(); wake.close();
          expect(wake.isStarted()).toBe(false);
          expect(time.timers.size).toBe(0);
          expect(time.microtasks.length).toBe(0);
          expect(errors.length).toBe(1);
          expect(polls).toBe(0);
        }
      }
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("getter/poll/thenable invariants close before one error hook and consume late rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const fault = new Error("invariant");
    const runFault = (configure: (deps: PendingInputWakeDependencies) => PendingInputWakeDependencies, onErrorThrows = false) => {
      const time = testClock();
      const errors: unknown[] = [];
      let wake!: PendingInputWake;
      const deps = configure({ canRun: () => true, hasWork: () => true, poll: () => {},
        onError: error => {
          expect(wake.isStarted()).toBe(false);
          expect(time.timers.size).toBe(0);
          wake.start(); wake.notify("resume");
          errors.push(error);
          if (onErrorThrows) throw new Error("broken failure hook");
        },
      });
      wake = createPendingInputWake(deps, time.clock);
      wake.start(); time.flush();
      wake.notify("enqueue"); time.tick(); time.flush(); wake.close(); wake.start();
      expect(errors.length).toBe(1);
      expect(wake.isStarted()).toBe(false);
      expect(time.timers.size).toBe(0);
      expect(time.microtasks.length).toBe(0);
      return errors[0];
    };
    expect(runFault(deps => Object.defineProperty(deps, "canRun", { get: () => { throw fault; } }))).toBe(fault);
    expect(runFault(deps => ({ ...deps, hasWork: () => { throw fault; } }))).toBe(fault);
    expect(runFault(deps => Object.defineProperty(deps, "poll", { get: () => { throw fault; } }))).toBe(fault);
    expect(runFault(deps => ({ ...deps, poll: () => { throw fault; } }))).toBe(fault);
    const asyncError = runFault(deps => ({ ...deps, poll: () => Promise.reject(fault) as unknown as void }), true);
    expect(asyncError).toBeInstanceOf(Error);
    expect((asyncError as Error).message).toContain("must be synchronous");
    expect(runFault(deps => ({ ...deps, poll: () => Object.defineProperty({}, "then", { get: () => { throw fault; } }) as unknown as void }))).toBe(fault);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally { process.off("unhandledRejection", onUnhandled); }
});
