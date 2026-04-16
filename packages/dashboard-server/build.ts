#!/usr/bin/env bun

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative } from "node:path"

console.log("🔨 Building @agenv/workstream-dashboard...")

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(path)
    } else {
      yield path
    }
  }
}

async function transpileFile(srcPath: string, outPath: string): Promise<void> {
  const source = await readFile(srcPath, "utf8")
  const shebangMatch = source.match(/^#!.*\n/)
  const shebang = shebangMatch ? "#!/usr/bin/env bun\n" : ""
  const codeWithoutShebang = shebangMatch ? source.slice(shebangMatch[0].length) : source
  const isBinFile = srcPath.startsWith("bin/")

  const transpiler = new Bun.Transpiler({
    loader: "ts",
    target: "bun",
  })

  let jsCode = transpiler.transformSync(codeWithoutShebang)

  if (isBinFile) {
    jsCode = jsCode.replace(/if\s*\(\s*import\.meta\.main\s*\)/g, "if (true)")
  } else {
    jsCode = jsCode.replace(/if\s*\(\s*import\.meta\.main\s*\)\s*\{[^}]*\}/gs, "")
  }

  jsCode = jsCode.replace(/from\s+["'](.+?)\.ts["']/g, 'from "$1.js"')
  jsCode = jsCode.replace(/import\s+["'](.+?)\.ts["']/g, 'import "$1.js"')
  jsCode = jsCode.replace(/import\((["'])(.+?)\.ts\1\)/g, 'import("$2.js")')
  jsCode = jsCode.replace(/export\s+\*\s+from\s+["'](.+?)\.ts["']/g, 'export * from "$1.js"')
  jsCode = jsCode.replace(/from\s+["'](\.\.?\/[^"']+?)["']/g, (match, path) => {
    if (!path.endsWith(".js") && !path.endsWith(".json") && !path.endsWith(".yaml")) {
      return `from "${path}.js"`
    }
    return match
  })
  jsCode = jsCode.replace(/import\s+["'](\.\.?\/[^"']+?)["']/g, (match, path) => {
    if (!path.endsWith(".js") && !path.endsWith(".json") && !path.endsWith(".yaml")) {
      return `import "${path}.js"`
    }
    return match
  })
  jsCode = jsCode.replace(/export\s+\*\s+from\s+["'](\.\.?\/[^"']+?)["']/g, (match, path) => {
    if (!path.endsWith(".js") && !path.endsWith(".json") && !path.endsWith(".yaml")) {
      return `export * from "${path}.js"`
    }
    return match
  })

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, jsCode)

  const mapPath = `${outPath}.map`
  const relSource = relative(dirname(outPath), srcPath)
  await writeFile(
    mapPath,
    JSON.stringify({
      version: 3,
      file: outPath,
      sourceRoot: "",
      sources: [relSource],
      names: [],
      mappings: "",
    }),
  )

  await writeFile(outPath, shebang + jsCode + `\n//# sourceMappingURL=${outPath.split("/").pop()}.map\n`)
}

try {
  let fileCount = 0

  console.log("\n📦 Transpiling TypeScript files...")
  for await (const file of walk("src")) {
    if (file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".spec.ts")) {
      const outPath = file.replace(/^src/, "dist/src").replace(/\.ts$/, ".js")
      await transpileFile(file, outPath)
      fileCount += 1
    }
  }

  for await (const file of walk("bin")) {
    if (file.endsWith(".ts")) {
      const outPath = file.replace(/^bin/, "dist/bin").replace(/\.ts$/, ".js")
      await transpileFile(file, outPath)
      fileCount += 1
    }
  }

  console.log(`✅ Transpiled ${fileCount} files`)

  console.log("\n✨ Build complete!")
  console.log("📁 Output directory: ./dist")
} catch (error) {
  console.error("❌ Build error:", error)
  process.exit(1)
}
