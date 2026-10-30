import { parseMediaShareInput } from "../shared/media-share-contract";
import { createAppShareEvidence } from "./app-share-evidence";
import { MediaShareError } from "./media-share-store";

export const denyMediaShareIdentity = (): never => { throw new MediaShareError(409, "media-share-identity", "Media share requires the exact evidenced invocation in an App-owned turn"); };
const evidence = createAppShareEvidence({ toolName: "sane_share_media", parseInput: parseMediaShareInput, deny: denyMediaShareIdentity });
export const matchesMediaShareTool = evidence.matchesTool;
export const matchesMediaSharePart = evidence.matchesPart;
export const readMediaShareContinuation = evidence.readContinuation;
