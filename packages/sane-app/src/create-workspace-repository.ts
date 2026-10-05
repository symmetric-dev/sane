import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverRepository, initializeRepository, inspectRepositoryStore } from "sane-core/server";

// Supervised helper: synchronous core Git discovery/SQLite initialization must
// not block the bridge event loop. Always initialize at the final pinned path.
const [root, device, inode] = process.argv.slice(2);
if (!root) throw new Error("Missing repository destination");
const check = () => {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root || stat.dev !== Number(device) || stat.ino !== Number(inode)) throw new Error("New workspace directory changed during creation");
};
check();
execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "--template=", "--initial-branch=main", "."], {
  cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  stdio: ["ignore", "pipe", "pipe"], timeout: 8000, maxBuffer: 65536,
});
check();
writeFileSync(join(root, ".gitignore"), "/.sane/\n", { flag: "wx", mode: 0o644 });
const discovery = discoverRepository(root);
if (discovery.primaryCheckout !== root || discovery.invocationCheckout.path !== root || discovery.commonDir !== join(root, ".git")) throw new Error("Git did not initialize the intended standalone repository");
initializeRepository(discovery);
check();
if (inspectRepositoryStore(discovery).state !== "ready") throw new Error("SANE initialization did not complete");
