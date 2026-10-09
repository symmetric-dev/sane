import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { discoverRepository, initializeRepository } from "../../sane-core/src/repository.ts"

// Deliberately never derives the destination from the invocation checkout.
export const verificationRoot = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode"

export function isolatedWorkspace() {
  const root = realpathSync(mkdtempSync(join(verificationRoot, "science-verification-")))
  try {
    execFileSync("git", ["init", "--quiet", root], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    })
    const workspace = initializeRepository(discoverRepository(root))
    return { root, workspace, dispose: () => rmSync(root, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
