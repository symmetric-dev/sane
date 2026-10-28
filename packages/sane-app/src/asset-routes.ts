import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { validateAssets } from "./asset-build";
import { json } from "./bridge-http";

export type AssetRoutePorts = Readonly<{
  assetsDir: string;
  assetManifest: ReturnType<typeof validateAssets>["manifest"];
}>;

/** Non-API fallback after the bridge's browser boundary and API routing. The
 * captured manifest is the one validated by the existing startup path. */
export function createAssetRoute({ assetsDir, assetManifest }: AssetRoutePorts) {
  return async function assetRoute(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (path.startsWith("/api/")) return null;
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
    let assetName: string;
    if (path === "/") assetName = "index.html";
    else if (path === "/push-worker.js") assetName = "push-worker.js";
    else {
      let assetPath: string;
      try { assetPath = decodeURIComponent(path); } catch { return json({ error: "Not found" }, 404); }
      if (!assetPath.startsWith("/assets/") || assetPath.includes("\\") || assetPath.includes("\0") || assetPath.split("/").slice(2).some(part => !part || part.startsWith("."))) return json({ error: "Not found" }, 404);
      assetName = assetPath.slice("/assets/".length);
      if (url.searchParams.has("v") && (url.searchParams.getAll("v").length !== 1 || url.searchParams.get("v") !== assetManifest.fingerprint)) return json({ error: "Not found" }, 404);
    }
    if (!Object.hasOwn(assetManifest.outputs, assetName) || /\.(?:gz|br)$/.test(assetName)) return json({ error: "Not found" }, 404);
    const accepted = new Map<string, number>();
    for (const part of (req.headers.get("accept-encoding") ?? "").toLowerCase().split(",")) {
      const [name, ...parameters] = part.trim().split(";").map(value => value.trim());
      if (!name) continue;
      const q = parameters.find(value => value.startsWith("q="))?.slice(2);
      accepted.set(name, q === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q) : 0);
    }
    const quality = (name: string) => accepted.get(name) ?? accepted.get("*") ?? 0;
    const encodings = [{ name: "br", suffix: ".br" }, { name: "gzip", suffix: ".gz" }].sort((a, b) => quality(b.name) - quality(a.name));
    const encoding = encodings.find(value => quality(value.name) > 0 && quality(value.name) >= (accepted.get("identity") ?? 0) && Object.hasOwn(assetManifest.outputs, assetName + value.suffix));
    if (!encoding && (accepted.get("identity") ?? (accepted.get("*") === 0 ? 0 : 1)) === 0) return new Response(null, { status: 406, headers: { "cache-control": "no-store", vary: "Accept-Encoding" } });
    let file = resolve(assetsDir, assetName + (encoding?.suffix ?? ""));
    if (!file.startsWith(assetsDir + "/")) return json({ error: "Not found" }, 404);
    try {
      const canonicalRoot = await realpath(assetsDir);
      file = await realpath(file);
      if (!file.startsWith(canonicalRoot + "/")) return json({ error: "Not found" }, 404);
    } catch { return json({ error: "Not found" }, 404); }
    try { if (!(await stat(file)).isFile()) return json({ error: "Not found" }, 404); }
    catch { return json({ error: "Not found" }, 404); }
    const asset = Bun.file(file);
    const immutable = assetName !== "index.html" && assetName !== "push-worker.js" && url.searchParams.get("v") === assetManifest.fingerprint;
    return new Response(req.method === "HEAD" ? null : asset, { headers: {
      "content-type": Bun.file(join(assetsDir, assetName)).type, "content-length": String(asset.size),
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store", "x-content-type-options": "nosniff", vary: "Accept-Encoding",
      ...(encoding ? { "content-encoding": encoding.name } : {}), ...(path === "/push-worker.js" ? { "service-worker-allowed": "/" } : {}),
    } });
  };
}
