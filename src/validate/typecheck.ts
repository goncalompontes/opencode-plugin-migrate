/**
 * Validate generated code with the real TypeScript checker, against the real
 * @opencode/plugin types. This is the gate that makes the output trustworthy:
 * a conversion is only "converted" if the emitted file has zero type errors.
 */
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"
import type { Diagnostic } from "../core/diagnostics"

/**
 * Parsed standard-library and @types declarations never change during a process run,
 * so parse each one once and share it across every program.
 */
const declarationCache = new Map<string, ts.SourceFile>()

function isImmutableDeclaration(fileName: string): boolean {
  return (
    fileName.includes("/node_modules/typescript/lib/") ||
    fileName.includes("/node_modules/@types/")
  )
}

function createCachedHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (isImmutableDeclaration(fileName) && !shouldCreateNewSourceFile) {
      const cached = declarationCache.get(fileName)
      if (cached) return cached
    }
    const source = original(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    if (source && isImmutableDeclaration(fileName)) declarationCache.set(fileName, source)
    return source
  }
  return host
}

export interface TypecheckResult {
  readonly diagnostics: Diagnostic[]
  /** No errors in the generated file (errors in untouched sibling files are reported, not fatal). */
  readonly clean: boolean
  readonly checkedFiles: readonly string[]
}

function toDiagnostic(diagnostic: ts.Diagnostic): Diagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
  const code = `ts/${diagnostic.code}`
  if (diagnostic.file && diagnostic.start !== undefined) {
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return {
      code,
      severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      message,
      range: {
        file: diagnostic.file.fileName,
        start: diagnostic.start,
        end: diagnostic.start + (diagnostic.length ?? 0),
        line: line + 1,
        column: character + 1,
      },
    }
  }
  return {
    code,
    severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
    message,
  }
}

export function typecheck(_dir: string, emittedFile: string): TypecheckResult {
  // Start from the generated module; TypeScript pulls in only the files it imports.
  // Unrelated Bun scripts and CLI entrypoints in the plugin repository are not our gate.
  const rootNames = [emittedFile]
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    allowJs: false,
    types: ["node", "bun"],
    lib: ["lib.esnext.d.ts"],
  }

  const program = ts.createProgram({ rootNames, options, host: createCachedHost(options) })
  const target = path.resolve(emittedFile)

  // Regions emitted verbatim from V1: compile errors there are findings about the old
  // body, not about the generated V2 scaffolding, so they are reported for review.
  const carried = new Set<number>()
  if (fs.existsSync(target)) {
    let inside = false
    fs.readFileSync(target, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (line.includes("#region carried-v1")) inside = true
        else if (line.includes("#endregion carried-v1")) inside = false
        else if (inside) carried.add(index + 1)
      })
  }

  const suggestions: Record<string, string> = {
    "ts/2304": "the identifier disappeared during migration; check whether it came from the V1 package import or module scope.",
    "ts/2339": "this member does not exist on the V2 type; the event or payload shape changed in V2.",
    "ts/2322": "V2 expects a different value shape here.",
    "ts/2345": "the V2 callback or API takes a different argument shape.",
    "ts/2554": "the V2 callback signature differs from V1; check the event object.",
    "ts/2741": "the value is missing fields required by the V2 or runtime type.",
  }

  const diagnostics = ts.getPreEmitDiagnostics(program).map(toDiagnostic).map((item) => {
    // A missing third-party package is an environment problem, not a migration defect.
    const missing = /Cannot find module '([^']+)'/.exec(item.message)
    if (item.code === "ts/2307" && missing) {
      return {
        ...item,
        severity: "warning" as const,
        hint: missing[1]?.startsWith(".")
          ? "pre-existing missing module in the plugin source tree; relative imports are copied unchanged."
          : "third-party package is not installed in the migration sandbox.",
      }
    }
    return item.hint ? item : { ...item, ...(suggestions[item.code] ? { hint: suggestions[item.code] } : {}) }
  }).map((item) => {
    const inCarried =
      item.range !== undefined &&
      path.resolve(item.range.file) === target &&
      carried.has(item.range.line) &&
      !item.code.startsWith("ts/1")
    if (!inCarried) return item
    return {
      ...item,
      severity: "warning" as const,
      hint: "this error is inside code carried over from V1; fix the body while porting it.",
    }
  })
  const errors = diagnostics.filter(
    (item) => item.severity === "error" && (!item.range || path.resolve(item.range.file) === target),
  )
  return { diagnostics, clean: errors.length === 0, checkedFiles: rootNames }
}
