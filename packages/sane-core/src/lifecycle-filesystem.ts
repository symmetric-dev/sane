import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import type { Stats } from "node:fs"

type Result<T> = T | Promise<T>
/** Policy port: ordinary CLI uses async I/O; candidate supplies guarded sync I/O. */
export interface LifecycleFileSystem {
  stat(path: string): Result<Stats>
  readBytes(path: string): Result<Buffer>
  readText(path: string): Result<string>
  listNames(path: string): Result<string[]>
  mkdir(path: string): Result<unknown>
  writeBytes(path: string, bytes: Buffer, exclusive: boolean): Result<unknown>
}
export const ordinaryLifecycleFileSystem: LifecycleFileSystem = {
  stat: lstat,
  readBytes: path => readFile(path),
  readText: path => readFile(path, "utf8"),
  listNames: path => readdir(path),
  mkdir: path => mkdir(path, { recursive: true }),
  writeBytes: (path, bytes, exclusive) => writeFile(path, bytes, { flag: exclusive ? "wx" : "w" }),
}
/** Must never be swallowed by policy's ordinary missing-file fallback. */
export class LifecycleAccessError extends Error {
  constructor(message: string) { super(message); this.name = "LifecycleAccessError" }
}
