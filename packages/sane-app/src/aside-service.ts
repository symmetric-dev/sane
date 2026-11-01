import { parseAsideCreateRequest, parseAsideDraftRequest, parseAsideLifecycleRequest, type AsideRecord, type AsideSummary } from "../shared/aside-contract";
import { AsideError, type AsideStore } from "./aside-store";
import type { AsideSourceResolver } from "./aside-source";

export type AsideServiceSource = Pick<AsideSourceResolver, "authorizeRead" | "resolve">;

function parseInput<T>(parse: (input: unknown) => T, input: unknown): T {
  try { return parse(input); }
  catch (error) {
    if (error instanceof AsideError) throw error;
    throw new AsideError(400, "aside-input", error instanceof Error ? error.message : "Invalid aside request");
  }
}

/** Durable discussion drafts, not working/native sessions. Every operation is
 * authorized against its original App source; historical access is independent
 * of whether that source can still be captured or executed. */
export class AsideService {
  constructor(private store: AsideStore, private source: AsideServiceSource) {}

  async create(sessionId: string, input: unknown): Promise<AsideRecord> {
    const request = parseInput(parseAsideCreateRequest, input);
    const assertRead = this.source.authorizeRead(sessionId);
    assertRead();
    // Retry the original operation without recapture, including after source
    // retirement. The store rejects request-ID reuse with different content.
    const replay = this.store.replayCreate(sessionId, request);
    if (replay) { assertRead(); return structuredClone(replay); }
    const resolved = await this.source.resolve(sessionId, request.target);
    const assertCurrent = () => { assertRead(); resolved.assertCurrent(); };
    assertCurrent();
    return structuredClone(this.store.create(sessionId, request, resolved.source, assertCurrent));
  }

  list(sessionId: string): AsideSummary[] {
    const assertCurrent = this.source.authorizeRead(sessionId);
    assertCurrent();
    const summaries = this.store.list(sessionId);
    assertCurrent();
    return structuredClone(summaries);
  }

  private owned(id: string): { record: AsideRecord; assertCurrent: () => void } {
    const record = this.store.get(id);
    if (!record) throw new AsideError(404, "aside-missing", "Aside does not exist");
    const assertCurrent = this.source.authorizeRead(record.source.sessionId);
    assertCurrent();
    return { record, assertCurrent };
  }

  get(id: string): AsideRecord {
    const { record, assertCurrent } = this.owned(id);
    assertCurrent();
    return structuredClone(record);
  }

  saveDraft(id: string, input: unknown): AsideRecord {
    const request = parseInput(parseAsideDraftRequest, input);
    const { assertCurrent } = this.owned(id);
    assertCurrent();
    return structuredClone(this.store.saveDraft(id, request, assertCurrent));
  }

  setLifecycle(id: string, input: unknown): AsideRecord {
    const request = parseInput(parseAsideLifecycleRequest, input);
    const { assertCurrent } = this.owned(id);
    assertCurrent();
    return structuredClone(this.store.setLifecycle(id, request, assertCurrent));
  }
}
