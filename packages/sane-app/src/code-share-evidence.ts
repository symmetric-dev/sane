import { parseCodeShareInput } from "../shared/code-share-contract";
import { createAppShareEvidence } from "./app-share-evidence";
import { CodeShareError } from "./code-share-store";

export const denyCodeShareIdentity = (): never => { throw new CodeShareError(409, "code-share-identity", "Code share requires the exact evidenced invocation in an App-owned turn"); };
const evidence = createAppShareEvidence({ toolName: "sane_share_code", parseInput: parseCodeShareInput, deny: denyCodeShareIdentity });
export const matchesCodeShareTool = evidence.matchesTool;
export const matchesCodeSharePart = evidence.matchesPart;
export const readCodeShareContinuation = evidence.readContinuation;
