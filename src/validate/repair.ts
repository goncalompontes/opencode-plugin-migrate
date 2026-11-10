/**
 * Bounded, deterministic repair loop.
 *
 * Rule: a fixer may only add type annotations or otherwise preserve the carried code.
 * It never deletes statements or comments out code to make the checker happy. If no
 * fixer applies, the diagnostics stay in the report as review findings.
 */
import fs from "node:fs"
import path from "node:path"
import type { Diagnostic } from "../core/diagnostics"
import { typecheck } from "./typecheck"

export interface Fixer {
  readonly id: string
  readonly codes: readonly string[]
  /** Return the new source, or null when this diagnostic is not a safe fix. */
  apply(source: string, diagnostic: Diagnostic): string | null
}

export interface RepairFix {
  pass: number
  code: string
  origin?: string
  detail: string
}

export interface RepairResult {
  passes: number
  fixes: RepairFix[]
  stopped: "clean" | "no-fix" | "no-progress" | "max-passes"
}

export interface RepairOptions {
  file: string
  projectRoot: string
  owned: readonly string[]
  fixers?: readonly Fixer[]
  maxPasses?: number
  /** Test seam: replaces the TypeScript check. */
  check?: (source: string, file: string) => Diagnostic[]
  /** Diagnostics already computed for the current source, to avoid a duplicate check. */
  initialDiagnostics?: Diagnostic[]
}

/**
 * `function helper(value) {}` inside a carried body has no contextual type after the
 * V1 package leaves the graph. Adding `: any` preserves behaviour and the body.
 */
export function implicitAnyParameter(): Fixer {
  return {
    id: "implicit-any-parameter",
    codes: ["ts/7006"],
    apply(source, diagnostic) {
      if (!diagnostic.range) return null
      const name = /Parameter '([^']+)'/.exec(diagnostic.message)?.[1]
      if (!name) return null
      const start = diagnostic.range.start
      if (source.slice(start, start + name.length) !== name) return null
      const after = source.slice(start + name.length)
      // Do not annotate a parameter that already has a type.
      if (/^\s*:/.test(after)) return null
      return `${source.slice(0, start + name.length)}: any${after}`
    },
  }
}

function signature(diagnostics: readonly Diagnostic[], file: string): string {
  return diagnostics
    .filter((item) => item.range && path.resolve(item.range.file) === path.resolve(file))
    .map((item) => `${item.code}@${item.range?.line}:${item.range?.column}`)
    .sort()
    .join("|")
}

export function runRepair(options: RepairOptions): {
  result: RepairResult
  diagnostics: Diagnostic[]
} {
  const fixers = options.fixers ?? [implicitAnyParameter()]
  const maxPasses = options.maxPasses ?? 3
  const file = path.resolve(options.file)
  const check =
    options.check ??
    ((source: string, target: string) => {
      fs.writeFileSync(target, source)
      return typecheck(options.projectRoot, target, options.owned).diagnostics
    })

  let source = fs.readFileSync(file, "utf8")
  const fixes: RepairFix[] = []
  const seen = new Set<string>([source])
  let diagnostics = options.initialDiagnostics ?? check(source, file)
  let stopped: RepairResult["stopped"] = "clean"

  while (fixes.length < maxPasses) {
    const current = signature(diagnostics, file)
    const target = diagnostics.filter(
      (item) => item.range && path.resolve(item.range.file) === file,
    )
    const fixer = fixers.find((candidate) =>
      target.some((item) => candidate.codes.includes(item.code)),
    )
    if (!fixer) {
      stopped = target.length === 0 ? "clean" : "no-fix"
      break
    }

    const diagnostic = target.find((item) => fixer.codes.includes(item.code))
    if (!diagnostic) {
      stopped = "clean"
      break
    }
    const next = fixer.apply(source, diagnostic)
    if (next === null || next === source) {
      stopped = "no-fix"
      break
    }
    if (seen.has(next)) {
      stopped = "no-progress"
      break
    }
    seen.add(next)
    source = next
    fixes.push({
      pass: fixes.length + 1,
      code: diagnostic.code,
      ...(diagnostic.origin ? { origin: diagnostic.origin } : {}),
      detail: diagnostic.message.split("\n")[0] ?? diagnostic.message,
    })
    diagnostics = check(source, file)
    if (signature(diagnostics, file) === current) {
      stopped = "no-progress"
      break
    }
  }

  if (fixes.length >= maxPasses) stopped = "max-passes"
  fs.writeFileSync(file, source)
  return { result: { passes: fixes.length, fixes, stopped }, diagnostics }
}
