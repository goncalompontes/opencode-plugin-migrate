#!/usr/bin/env bun
/** One benchmark conversion, executed by a worker process. Prints a JSON result. */
import path from "node:path"
import { convertPlugin } from "../src/api"
import { countV1ImportFiles } from "../src/env/imports"

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const dir = arg("--dir")
const out = arg("--out")
if (!dir || !out) {
  console.log(JSON.stringify({ ok: false, error: "worker requires --dir and --out" }))
  process.exit(0)
}

const started = performance.now()
let v1Before = 0
try {
  v1Before = countV1ImportFiles(dir)
  const { report } = await convertPlugin(dir, { outDir: out })
  const v1After = countV1ImportFiles(path.join(out, report.id))
  console.log(
    JSON.stringify({
      ok: true,
      v1Before,
      v1After,
      report,
      durationMs: performance.now() - started,
    }),
  )
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      v1Before,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - started,
    }),
  )
}
