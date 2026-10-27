import { isAbsolute } from "node:path";

export class AppStoreError extends Error {
  constructor(public readonly code: "APP_STORE_UNINITIALIZED" | "APP_STORE_UNSUPPORTED" | "APP_STORE_CORRUPT" | "APP_SOURCE_MISMATCH", message: string) { super(message); }
}

export function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new AppStoreError("APP_STORE_CORRUPT", "Invalid fresh App record shape");
}

export const absolute = (v: unknown): v is string => typeof v === "string" && isAbsolute(v) && !v.includes("\0");
export const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
export function corrupt(message: string): never { throw new AppStoreError("APP_STORE_CORRUPT", message); }
