const listeners = new Set<(sessionId?: string) => void>();

/** Omit the session ID to wake every subscribed poll. */
export function wakePolls(sessionId?: string): void {
  listeners.forEach(listener => listener(sessionId));
}

export function subscribeWake(listener: (sessionId?: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
