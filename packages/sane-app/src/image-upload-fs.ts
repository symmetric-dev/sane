import { WorkspaceError } from "./workspace";

/** The *at syscalls pin parent directories. Never replace these with pathname
 * mkdir/open/unlink: an ancestor could become a symlink between checks. */
export interface ImageUploadFs {
  openAt(fd: number, name: string, flags: number, mode?: number): number;
  mkdirAt(fd: number, name: string, mode: number): void;
  unlinkAt(fd: number, name: string): void;
  unlinkDirectoryAt(fd: number, name: string): void;
}
let loaded: Promise<ImageUploadFs> | undefined;
export function loadImageUploadFs(): Promise<ImageUploadFs> { return loaded ??= load(); }
async function load(): Promise<ImageUploadFs> {
  if (!["darwin", "linux"].includes(process.platform)) throw new WorkspaceError(501, "image-upload-unsupported", "Safe image uploads are unsupported on this platform");
  try {
    const { dlopen, read } = await import("bun:ffi");
    const darwin = process.platform === "darwin";
    // Apple's public openat is variadic: on arm64 its mode is passed on the
    // stack, not in the fourth argument register used by Bun's fixed-arity FFI.
    // Use its fixed-arity syscall entry (xnu/libsyscall/wrappers/open-base.c).
    // Missing native support must fail closed, never use the variadic fallback.
    const library = darwin ? dlopen("/usr/lib/libSystem.B.dylib", {
      __openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i32" },
      mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
      unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    }) : dlopen("libc.so.6", {
      openat: { args: ["i32", "ptr", "i32", "u32"], returns: "i32" },
      mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
      unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    });
    const errors = darwin ? dlopen("/usr/lib/libSystem.B.dylib", { __error: { args: [], returns: "ptr" } })
      : dlopen("libc.so.6", { __errno_location: { args: [], returns: "ptr" } });
    const call = (operation: "openat" | "mkdirat" | "unlinkat", fd: number, name: string, flags: number, mode = 0) => {
      if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw new WorkspaceError(400, "invalid-path", "Use an exact basename");
      const bytes = Buffer.from(`${name}\0`);
      const errno = "__error" in errors.symbols ? errors.symbols.__error() : errors.symbols.__errno_location();
      if (!errno) throw new Error("Missing errno");
      const result = operation === "openat" ? ("__openat" in library.symbols
        ? library.symbols.__openat(fd, bytes, flags, mode) : library.symbols.openat(fd, bytes, flags, mode))
        : operation === "mkdirat" ? library.symbols.mkdirat(fd, bytes, flags) : library.symbols.unlinkat(fd, bytes, flags);
      if (result >= 0) return result;
      const n = read.i32(errno);
      const code = n === 2 ? "ENOENT" : n === 17 ? "EEXIST" : n === 20 ? "ENOTDIR" : n === (darwin ? 62 : 40) ? "ELOOP" : n === 13 || n === 1 ? "EACCES" : "EIO";
      throw Object.assign(new Error("Descriptor-relative filesystem operation failed"), { code });
    };
    // Darwin SDK sys/fcntl.h: AT_REMOVEDIR = 0x0080.
    // Linux include/uapi/linux/fcntl.h: AT_REMOVEDIR = 0x200.
    const removeDirectory = darwin ? 0x80 : 0x200;
    return {
      openAt: (fd, name, flags, mode) => call("openat", fd, name, flags, mode),
      mkdirAt: (fd, name, mode) => { call("mkdirat", fd, name, mode); },
      unlinkAt: (fd, name) => { call("unlinkat", fd, name, 0); },
      unlinkDirectoryAt: (fd, name) => { call("unlinkat", fd, name, removeDirectory); },
    };
  } catch { throw new WorkspaceError(501, "image-upload-unsupported", "Safe image uploads require native descriptor-relative filesystem support"); }
}
