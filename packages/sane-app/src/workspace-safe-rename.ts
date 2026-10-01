/** Native exclusive rename only. Never emulate this with rename(), copy/unlink,
 * or link/unlink: those cannot provide the same no-overwrite rename protocol. */
export class ExclusiveRenameError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export type ExclusiveRename = (directoryFd: number, source: string, destination: string) => void;
const unsupported = () => new ExclusiveRenameError(501, "rename-unsupported", "Safe exclusive rename is not supported by this runtime or filesystem");
let native: Promise<ExclusiveRename> | undefined;

/** Lazy: normal workspace operations do not require FFI. Keep the loaded
 * library alive for the process lifetime, and resolve it before source fences. */
export function loadExclusiveRename(): Promise<ExclusiveRename> {
  return native ??= load();
}
async function load(): Promise<ExclusiveRename> {
  const darwin = process.platform === "darwin";
  if (!darwin && process.platform !== "linux") throw unsupported();
  try {
    const { dlopen, read } = await import("bun:ffi");
    // Darwin SDK usr/include/sys/stdio.h: RENAME_EXCL = 0x00000004.
    // Linux UAPI include/uapi/linux/fs.h: RENAME_NOREPLACE = (1 << 0).
    // Both APIs accept (int, const char *, int, const char *, unsigned int).
    // Use the *at variant to pin the same parent for both basename operands.
    const flags = darwin ? 0x00000004 : 1;
    const library = darwin
      ? dlopen("/usr/lib/libSystem.B.dylib", {
          renameatx_np: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
          __error: { args: [], returns: "ptr" },
        })
      : dlopen("libc.so.6", {
          renameat2: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
          __errno_location: { args: [], returns: "ptr" },
        });
    return (directoryFd, source, destination) => {
      if ([source, destination].some(name => !name || name === "." || name === ".." || /[/\\\0]/.test(name))) throw new ExclusiveRenameError(400, "invalid-path", "Rename requires exact basenames");
      const from = Buffer.from(`${source}\0`, "utf8"), to = Buffer.from(`${destination}\0`, "utf8");
      // Fetch the thread-local errno address BEFORE the syscall. No await or
      // additional native call may intervene between a failure and reading it.
      const errno = "__error" in library.symbols ? library.symbols.__error() : library.symbols.__errno_location();
      if (!errno) throw unsupported();
      // Pass the buffers directly as ptr operands so they stay live for the
      // whole native call, rather than retaining only numeric pointer values.
      const result = "renameatx_np" in library.symbols
        ? library.symbols.renameatx_np(directoryFd, from, directoryFd, to, flags)
        : library.symbols.renameat2(directoryFd, from, directoryFd, to, flags);
      if (result === 0) return;
      const code = read.i32(errno);
      if (code === 17 || code === 21 || code === (darwin ? 66 : 39)) throw new ExclusiveRenameError(409, "path-exists", "Destination already exists; choose a different path");
      if (code === 22 || code === (darwin ? 78 : 38) || code === (darwin ? 45 : 95)) throw unsupported();
      if (code === 1 || code === 13 || code === 30) throw new ExclusiveRenameError(403, "access-denied", "Filesystem access denied");
      if (code === 2 || code === 20) throw new ExclusiveRenameError(404, "path-missing", "Path no longer exists");
      throw new ExclusiveRenameError(503, "rename-unavailable", "Exclusive rename failed; refresh files before retrying");
    };
  } catch { throw unsupported(); }
}
