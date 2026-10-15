import { equal, json } from "./bridge-http";

/** Unified native ingress guard. Replaces duplicated checks in nativeHandoff/nativeWorker. */
export function requireNativeBearer(req: Request, token: string): Response | undefined {
  if (req.method !== "POST" || req.headers.has("origin") || !equal(req.headers.get("authorization") ?? "", `Bearer ${token}`)) {
    return json({ error: "Native authorization required" }, 401);
  }
  return undefined;
}

export function requireStartupReady(startupReady: boolean): Response | undefined {
  if (!startupReady) return json({ error: "Startup execution classification is incomplete", code: "startup-classifying" }, 503);
  return undefined;
}
