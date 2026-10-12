import { isAbsolute, resolve } from "node:path";

/** Ordinary `bun test` must never spend provider credits or discover ambient harnesses. */
export function nativeLiveGate(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SANE_RUN_LIVE_NATIVE_TESTS !== "I_ACCEPT_REAL_MODEL_CALLS") return false;
  if (!env.NATIVE_EVIDENCE_DIR || !isAbsolute(env.NATIVE_EVIDENCE_DIR)) {
    throw new Error("Live native tests require an absolute NATIVE_EVIDENCE_DIR outside disposable fixtures");
  }
  if (env.NATIVE_CLEANUP !== "close-and-remove") {
    throw new Error("Live native tests require NATIVE_CLEANUP=close-and-remove");
  }
  if (env.NATIVE_KEEP_FIXTURES === "1" || resolve(env.NATIVE_EVIDENCE_DIR) === "/") {
    throw new Error("Live native tests require bounded evidence and disposable-fixture cleanup");
  }
  return true;
}
