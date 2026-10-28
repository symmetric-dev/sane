import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import type { PinnedMessageContext } from "./context-message";

/** Only context-bearing preparation calls this; ordinary continuation has no
 * package capability. Retain independently loaded pinned bytes/descriptor pins
 * for a synchronous recheck after native discovery and before its first effect. */
export function captureContextMessageSources(context: PinnedMessageContext): () => void {
  const pins = context.bundle.assets.map(asset => {
    const path = context.paths[asset.id];
    const expectedBytes = Buffer.from(asset.text, "utf8");
    if (!path) throw new Error("Selected pinned context source has no private path");
    const read = () => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd), named = lstatSync(path);
        if (!before.isFile() || before.nlink !== 1 || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || realpathSync(path) !== path) throw new Error("Selected pinned context source identity changed");
        if (before.size !== expectedBytes.length) throw new Error("Selected pinned context source length changed");
        const bytes = Buffer.alloc(expectedBytes.length);
        let position = 0;
        while (position < bytes.length) {
          const count = readSync(fd, bytes, position, Math.min(64 * 1024, bytes.length - position), position);
          if (count <= 0) throw new Error("Selected pinned context source ended during read");
          position += count;
        }
        const after = fstatSync(fd), current = lstatSync(path);
        if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
          || current.dev !== before.dev || current.ino !== before.ino || !bytes.equals(expectedBytes)) throw new Error("Selected pinned context source bytes changed");
        return { dev: before.dev, ino: before.ino, size: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs };
      } finally { closeSync(fd); }
    };
    const expected = read();
    return () => { if (JSON.stringify(read()) !== JSON.stringify(expected)) throw new Error("Selected pinned context source pin changed"); };
  });
  return () => { pins.forEach(check => check()); };
}
