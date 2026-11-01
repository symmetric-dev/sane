import { ASIDE_EXECUTION_AVAILABILITY, type AsideRecord } from "../shared/aside-contract";
import { parseAsideMessageRequest, type AsideContextProvider, type AsideExecutionReadiness } from "../shared/aside-execution-contract";
import { AsideError } from "./aside-store";

/** Instantiate per authenticated request. Neither port needs mutation authority
 * nor live source lookup: historical aside access uses the retained owner.
 * assertCurrent must pin/revalidate that request's startup/storage owner AND
 * permission to read this aside; an existence check alone is insufficient. */
export interface AsideExecutionPorts {
  getAside(id: string): AsideRecord | undefined | Promise<AsideRecord | undefined>;
  assertCurrent(id: string): void;
  /** Reserved contract seam, not execution registration. Even a provider with
   * structural ready metadata is NOT invoked or trusted by this boundary. */
  contextProvider?: AsideContextProvider;
}

function readiness(record: AsideRecord): AsideExecutionReadiness {
  if (record.lifecycle === "archived") return { available: false, code: "aside-archived" };
  if (record.lifecycle === "discarded") return { available: false, code: "aside-discarded" };
  return ASIDE_EXECUTION_AVAILABILITY;
}

/** Readiness/rejection only: no sessions, runs, admission, receipts, source
 * writes or native I/O. Preparation metadata must not unlock execution. Future
 * followups/cancellation/recovery require independently materialized identity
 * and real existing dispatch integration, not a local imitation of its journal. */
export class AsideExecutionService {
  constructor(private readonly ports: AsideExecutionPorts) {}

  private async owned<T>(id: string, read: (record: AsideRecord) => T): Promise<T> {
    this.ports.assertCurrent(id);
    try {
      const record = await this.ports.getAside(id);
      this.ports.assertCurrent(id);
      if (!record) throw new AsideError(404, "aside-missing", "Aside does not exist");
      return read(record);
    } catch (error) {
      // Revalidate rejected awaits too: do not disclose a stale owner's result
      // or error after revocation. No source recapture or write permission.
      this.ports.assertCurrent(id);
      throw error;
    }
  }

  inspect(id: string): Promise<AsideExecutionReadiness> {
    return this.owned(id, readiness);
  }

  /** Valid requests are deliberately refused BEFORE preparation/admission or
   * any submitted-message receipt. A rejected requestId is not consumed. */
  submit(id: string, input: unknown): Promise<never> {
    return this.owned(id, record => {
      let request;
      try { request = parseAsideMessageRequest(input); }
      catch { throw new AsideError(400, "aside-input", "Invalid aside message request"); }
      const execution = readiness(record);
      if (execution.code === "aside-archived") throw new AsideError(409, execution.code, "Archived asides cannot receive messages");
      if (execution.code === "aside-discarded") throw new AsideError(409, execution.code, "Discarded asides cannot receive messages");
      if (request.expectedRevision !== record.revision) throw new AsideError(409, "aside-conflict", "Aside revision has changed");
      this.ports.assertCurrent(id);
      throw new AsideError(409, "aside-context-unconfigured", "Aside execution context is not configured");
    });
  }
}
