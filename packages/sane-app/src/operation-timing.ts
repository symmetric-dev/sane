/** Optional metadata-only instrumentation supplied by the caller. */
export type OperationTiming = {
  async: <T>(stage: string, work: () => Promise<T>) => Promise<T>;
  span: (stage: string) => (outcome?: string) => void;
  count: (stage: string) => void;
};
