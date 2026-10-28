import type { ModelChoice } from "./types";

/** Advisory discovery, never a saved profile or proof of model entitlement. */
export type ModelCatalog = {
  models: ModelChoice[];
  fetchedAt: string;
  stale: boolean;
  error?: string;
};
