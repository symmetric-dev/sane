import type { Pointer } from "bun:ffi";
import { WorkspaceError } from "./workspace";

type DirectoryAclGuard = (fd: number) => void;
let loaded: Promise<DirectoryAclGuard> | undefined;
const unsupported = () => new WorkspaceError(403, "image-upload-acl", "The directory ACL cannot be safely used for image uploads; choose a destination without custom write grants");

/** Linux POSIX access ACLs are bounded by the group mode mask checked by the
 * directory policy. Darwin extended ACLs can grant writes independently of
 * mode bits, so inspect their native entries too. Deny-only home ACLs are safe. */
export function loadImageUploadAclGuard(): Promise<DirectoryAclGuard> { return loaded ??= load(); }
async function load(): Promise<DirectoryAclGuard> {
  if (process.platform === "linux") return () => {};
  if (process.platform !== "darwin") throw unsupported();
  try {
    const { dlopen, read, ptr } = await import("bun:ffi");
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      acl_get_fd_np: { args: ["i32", "i32"], returns: "ptr" },
      acl_valid: { args: ["ptr"], returns: "i32" },
      acl_get_entry: { args: ["ptr", "i32", "ptr"], returns: "i32" },
      acl_get_tag_type: { args: ["ptr", "ptr"], returns: "i32" },
      acl_get_permset_mask_np: { args: ["ptr", "ptr"], returns: "i32" },
      acl_free: { args: ["ptr"], returns: "i32" },
      __error: { args: [], returns: "ptr" },
    });
    // Values and signatures: Darwin SDK sys/acl.h. Its acl_get_entry returns
    // 0 on success, -1/EINVAL at the end (unlike Linux's 1/0 protocol).
    const extended = 0x100, allow = 1, deny = 2, first = 0, next = -1, enoent = 2;
    const mutable = BigInt((1 << 2) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 8) | (1 << 10) | (1 << 12) | (1 << 13));
    const known = BigInt(((1 << 14) - 1) & ~1 | (1 << 20));
    return fd => {
      const errno = library.symbols.__error();
      if (!errno) throw unsupported();
      const acl = library.symbols.acl_get_fd_np(fd, extended);
      if (!acl) {
        // Darwin reports ENOENT when this open directory has no extended ACL.
        // Only that absence is safe; unreadable/unsupported ACLs still fail closed.
        if (read.i32(errno) === enoent) return;
        throw unsupported();
      }
      try {
        if (library.symbols.acl_valid(acl) !== 0) throw unsupported();
        const entrySlot = Buffer.alloc(8), tag = Buffer.alloc(4), permissions = Buffer.alloc(8);
        for (let index = 0; index <= 128; index++) {
          const errno = library.symbols.__error();
          if (!errno) throw unsupported();
          const result = library.symbols.acl_get_entry(acl, index === 0 ? first : next, entrySlot);
          if (result === -1 && read.i32(errno) === 22) return;
          if (result !== 0 || index === 128) throw unsupported();
          const entry = read.ptr(ptr(entrySlot)) as Pointer;
          if (!entry || library.symbols.acl_get_tag_type(entry, tag) !== 0) throw unsupported();
          const kind = tag.readInt32LE();
          if (kind === deny) continue;
          if (kind !== allow || library.symbols.acl_get_permset_mask_np(entry, permissions) !== 0) throw unsupported();
          const mask = permissions.readBigUInt64LE();
          // Conservatively reject mutating allow entries even for trusted
          // principals or inherit-only flags; inherited staging must stay safe.
          if ((mask & mutable) !== 0n || (mask & ~known) !== 0n) throw unsupported();
        }
      } finally { library.symbols.acl_free(acl); }
    };
  } catch { throw unsupported(); }
}
