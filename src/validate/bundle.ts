/**
 * Runtime validation, distinct from type checking.
 *
 * TypeScript proves shapes; it does not prove that the generated module can be resolved
 * and loaded. Bundle the emitted entry with Bun (package imports external) so relative
 * imports, the compatibility shim, and the V2 entry shape are exercised.
 */
import fs from "node:fs"
import type { Diagnostic } from "../core/diagnostics"

export interface BundleCheck {
  ok: boolean
  errors: string[]
}

export interface EntryCheck {
  ok: boolean
  message: string
}

export interface RuntimeCheck {
  bundle: BundleCheck
  entry: EntryCheck
  diagnostics: Diagnostic[]
}

function entryShape(file: string): EntryCheck {
  const source = fs.readFileSync(file, "utf8")
  const missing: string[] = []
  if (!/Plugin\s*\.\s*define\s*\(/.test(source)) missing.push("Plugin.define call")
  if (!/\bid\s*:\s*["'`]/.test(source)) missing.push("stable plugin id")
  if (!/\bsetup\s*\(/.test(source)) missing.push("setup function")
  if (missing.length) {
    return { ok: false, message: `entry is missing: ${missing.join(", ")}` }
  }
  return { ok: true, message: "default export is a Plugin.define({ id, setup }) module" }
}

export async function validateRuntime(file: string): Promise<RuntimeCheck> {
  const diagnostics: Diagnostic[] = []
  let bundle: BundleCheck = { ok: true, errors: [] }

  try {
    const result = await Bun.build({
      entrypoints: [file],
      target: "bun",
      format: "esm",
      packages: "external",
    })
    if (!result.success) {
      const errors = result.logs.map((log) => {
        const position = log.position
        const where = position ? `${position.file}:${position.line}:${position.column}` : "bundle"
        return `${where}: ${log.message}`
      })
      bundle = { ok: false, errors }
    }
  } catch (error) {
    bundle = { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }

  if (!bundle.ok) {
    diagnostics.push({
      code: "runtime/bundle",
      severity: "error",
      message: `bundle failed:\n${bundle.errors.join("\n")}`,
    })
  }

  const entry = entryShape(file)
  if (!entry.ok) {
    diagnostics.push({ code: "runtime/entry", severity: "error", message: entry.message })
  }

  return { bundle, entry, diagnostics }
}
