import type { WorkspaceRecord } from "../src/catalog-contract";
import type { Workstream } from "sane-core/contracts";

/** A name/branch match is not enough: use the configured repository checkout. */
export function workstreamCheckout(workspace: WorkspaceRecord | undefined, workstream: Workstream | undefined) {
  const pin = workstream?.defaultCheckout;
  if (!workspace || !pin || workspace.commonDir !== pin.commonDir) return undefined;
  return workspace.worktrees.find(tree => tree.state === "available" && tree.root === pin.path && tree.gitDir === pin.gitDir);
}
