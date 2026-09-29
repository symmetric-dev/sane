import { join } from "node:path";

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "frontend/main.tsx")],
  outdir: join(import.meta.dir, "public/assets"),
  target: "browser",
  format: "esm",
  naming: "app.[ext]",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
