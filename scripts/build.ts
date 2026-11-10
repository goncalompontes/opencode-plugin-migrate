#!/usr/bin/env bun
/** Build the library and the Node-compatible CLI into dist/. */
import fs from "node:fs"

fs.rmSync("dist", { recursive: true, force: true })

const shared = {
  outdir: "dist",
  target: "node",
  format: "esm",
  packages: "external",
  sourcemap: "linked",
  minify: false,
} as const

const library = await Bun.build({ ...shared, entrypoints: ["src/index.ts"], naming: "index.js" })
const cli = await Bun.build({
  ...shared,
  entrypoints: ["src/cli/index.ts"],
  naming: "cli.js",
  banner: "#!/usr/bin/env node",
})

for (const [name, result] of [
  ["library", library],
  ["cli", cli],
] as const) {
  if (!result.success) {
    console.error(`${name} build failed:`, result.logs)
    process.exit(1)
  }
}

fs.chmodSync("dist/cli.js", 0o755)
console.log(`built ${library.outputs.length + cli.outputs.length} file(s) into dist/`)
