/** Package-level scaffolding: a converted module is only installable if its manifest agrees. */
import fs from "node:fs"
import path from "node:path"
import type { Diagnostic } from "../core/diagnostics"

const V1_PACKAGE = "@opencode-ai/plugin"
const V2_PACKAGE = "@opencode/plugin"

export function readTargetVersion(root: string): string {
  const candidates = [
    path.join(root, "node_modules", V2_PACKAGE, "package.json"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "node_modules", V2_PACKAGE, "package.json"),
  ]
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string }
      if (pkg.version) return pkg.version
    } catch {
      // try the next location
    }
  }
  return "2.2.7"
}

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

/**
 * Move the plugin package from the V1 authoring package to the V2 one, preserving the
 * section that already declared it. Does nothing when the manifest already targets V2.
 */
export function upgradePackageJson(dir: string, version: string): Diagnostic[] {
  const file = path.join(dir, "package.json")
  if (!fs.existsSync(file)) return []

  let manifest: Manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest
  } catch {
    return [
      {
        code: "package/invalid-json",
        severity: "warning",
        message: `could not parse ${file}; dependencies were left unchanged.`,
      },
    ]
  }

  const sections = ["dependencies", "devDependencies", "peerDependencies"] as const
  let changed = false
  for (const section of sections) {
    const deps = manifest[section]
    if (!deps || deps[V1_PACKAGE] === undefined) continue
    delete deps[V1_PACKAGE]
    if (deps[V2_PACKAGE] === undefined) deps[V2_PACKAGE] = `^${version}`
    changed = true
  }

  if (!changed) return []
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return [
    {
      code: "package/dependency-swap",
      severity: "info",
      message: `package.json now depends on ${V2_PACKAGE}@^${version} instead of ${V1_PACKAGE}.`,
    },
  ]
}
