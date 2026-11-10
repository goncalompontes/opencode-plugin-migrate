/**
 * Public API. The pipelines here are the platform: analyze is a prefix of convert,
 * and every stage is independently typed and validated.
 */
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { Diagnostic } from "./core/diagnostics"
import { pipeline, stage } from "./core/pipeline"
import { copyProject, resolveProject } from "./env/project"
import { readTargetVersion, upgradePackageJson } from "./env/package"
import { findV1Imports, rewriteV1Imports } from "./env/imports"
import { detectLayout, upgradeConfigFiles } from "./env/config"
import { extractPlugin } from "./ir/extract"
import {
  ClassifiedPluginIR,
  EmittedModule,
  PluginIR,
  type ClassifiedHook,
} from "./ir/schema"
import { emitModule } from "./emit/emit"
import { classify } from "./rules/hooks"
import { applyTarget, probeTarget } from "./rules/compat"
import { typecheck } from "./validate/typecheck"
import { validateRuntime } from "./validate/bundle"
import { implicitAnyParameter, runRepair } from "./validate/repair"
import { buildState, mergeManualEdits, type MergeState } from "./validate/merge"
import { MigrationReport } from "./report/schema"

export const PluginProjectSchema = z.object({
  dir: z.string(),
  entryFile: z.string(),
  packageName: z.string().optional(),
  tsconfigPath: z.string().optional(),
  sourceFiles: z.array(z.string()),
})

const AnalyzeInput = z.object({ dir: z.string() })
const ConvertInput = z.object({
  dir: z.string(),
  outDir: z.string(),
  dual: z.boolean().default(false),
  force: z.boolean().default(false),
})

const EmitOutput = z.object({ ir: ClassifiedPluginIR, module: EmittedModule })
const ValidateOutput = EmitOutput.extend({
  typecheck: z.object({ clean: z.boolean(), diagnostics: z.array(Diagnostic) }),
  runtime: z.object({
    bundle: z.object({ ok: z.boolean(), errors: z.array(z.string()) }),
    entry: z.object({ ok: z.boolean(), message: z.string() }),
    diagnostics: z.array(Diagnostic),
  }),
  repair: z.object({
    passes: z.number().int().nonnegative(),
    fixes: z.array(
      z.object({
        pass: z.number().int().positive(),
        code: z.string(),
        origin: z.string().optional(),
        detail: z.string(),
      }),
    ),
    stopped: z.enum(["clean", "no-fix", "no-progress", "max-passes"]),
  }),
})

const resolveStage = stage({
  name: "resolve-entry",
  input: AnalyzeInput,
  output: PluginProjectSchema,
  run: async ({ dir }) => resolveProject(dir),
})

const convertStage = stage({
  name: "convert-entry",
  input: ConvertInput,
  output: PluginProjectSchema,
  run: async ({ dir }) => resolveProject(dir),
})

const extractStage = stage({
  name: "extract-ir",
  input: PluginProjectSchema,
  output: PluginIR,
  run: async (project) => extractPlugin(project),
})

const classifyStage = stage({
  name: "classify-hooks",
  input: PluginIR,
  output: ClassifiedPluginIR,
  run: async (ir, ctx) => {
    const override = typeof ctx.options?.target === "string" ? ctx.options.target : undefined
    const target = probeTarget(ctx.root, override)
    const classified = applyTarget(classify(ir), target)
    const diagnostics = [...classified.diagnostics]
    diagnostics.push({
      code: "target/version",
      severity: "info",
      message: `targeting @opencode/plugin@${target.version} (${target.capabilities.length} capabilities probed).`,
    })
    if (target.overrideMismatch) {
      diagnostics.push({
        code: "target/override",
        severity: "warning",
        message: target.overrideMismatch,
      })
    }
    if (target.missing.length) {
      diagnostics.push({
        code: "target/missing",
        severity: "warning",
        message: `installed target is missing capabilities: ${target.missing.join(", ")}; affected hooks were downgraded to review.`,
      })
    }
    return { ...classified, diagnostics }
  },
})

const emitStage = stage({
  name: "emit-v2",
  input: ClassifiedPluginIR,
  output: EmitOutput,
  run: async (ir, ctx) => {
    const target = path.join(ctx.outDir, ir.id)
    const relativeRaw = path.relative(ir.sourceDir, ir.entryFile)
    const isJavaScript = !/\.[cm]?tsx?$/.test(relativeRaw)
    const relative = isJavaScript
      ? relativeRaw.replace(/\.[cm]?jsx?$/, relativeRaw.endsWith(".jsx") ? ".tsx" : ".ts")
      : relativeRaw
    const file = path.join(target, relative)
    const statePath = path.join(target, "migration-state.json")
    const force = ctx.options?.force === true
    const priorSource = !force && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined
    let priorState: MergeState | undefined
    if (!force && fs.existsSync(statePath)) {
      try {
        priorState = JSON.parse(fs.readFileSync(statePath, "utf8")) as MergeState
      } catch {
        priorState = undefined
      }
    }

    copyProject(
      {
        dir: ir.sourceDir,
        entryFile: ir.entryFile,
        sourceFiles: ir.sourceFiles,
        ...(ir.tsconfigPath ? { tsconfigPath: ir.tsconfigPath } : {}),
        ...(ir.packageName ? { packageName: ir.packageName } : {}),
      },
      target,
    )
    const module = emitModule(ir, file, { dual: ctx.options?.dual === true })
    if (!module.source.includes("Plugin.define")) {
      throw new Error("emitter produced no Plugin.define call")
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const generated = module.source
    if (priorSource) {
      const merged = mergeManualEdits(generated, priorSource, priorState, { force })
      module.source = merged.source
      if (merged.preserved.length) {
        module.diagnostics.push({
          code: "incremental/preserved",
          severity: "info",
          message: `preserved manual edits in ${merged.preserved.length} carried region(s): ${[...new Set(merged.preserved)].join(", ")}.`,
        })
      }
      for (const origin of merged.conflicts) {
        module.diagnostics.push({
          code: "incremental/conflict",
          severity: "warning",
          message: `manual edits and regenerated code both changed ${origin}; the manual body was kept. Review it against the V1 source.`,
        })
      }
    }
    fs.writeFileSync(file, module.source)
    fs.writeFileSync(statePath, `${JSON.stringify(buildState(generated), null, 2)}\n`)
    if (isJavaScript) {
      fs.rmSync(path.join(target, relativeRaw), { force: true })
      module.diagnostics.push({
        code: "js/emitted",
        severity: "info",
        message: `JavaScript entry ${relativeRaw} was converted to ${relative}.`,
      })
    }

    module.diagnostics.push(...upgradeConfigFiles(target), ...detectLayout(target))
    const rewrite = rewriteV1Imports(target, [file])
    module.diagnostics.push(...rewrite.diagnostics)
    module.rewrittenFiles = rewrite.rewritten
    module.remainingV1Imports = rewrite.remaining
    if (rewrite.shim) module.shim = rewrite.shim

    const version = readTargetVersion(ctx.root)
    module.diagnostics.push(
      ...upgradePackageJson(
        target,
        version,
        rewrite.remaining.length === 0,
        rewrite.rewritten.length > 0,
        isJavaScript ? { from: relativeRaw, to: relative } : undefined,
      ),
    )
    return { ir, module }
  },
})

const validateStage = stage({
  name: "typecheck-v2",
  input: EmitOutput,
  output: ValidateOutput,
  run: async ({ ir, module }, ctx) => {
    const owned = [module.file, ...module.rewrittenFiles]
    if (module.shim) owned.push(module.shim)
    const projectRoot = path.join(ctx.outDir, ir.id)
    let result = typecheck(projectRoot, module.file, owned)
    let repair: ReturnType<typeof runRepair>["result"] = {
      passes: 0,
      fixes: [],
      stopped: "clean",
    }
    const fixable = result.diagnostics.some(
      (item) =>
        item.code === "ts/7006" &&
        item.range !== undefined &&
        path.resolve(item.range.file) === path.resolve(module.file),
    )
    if (fixable) {
      const outcome = runRepair({
        file: module.file,
        projectRoot,
        owned,
        fixers: [implicitAnyParameter()],
        maxPasses: 4,
        initialDiagnostics: result.diagnostics,
      })
      repair = outcome.result
      if (repair.fixes.length) {
        module.source = fs.readFileSync(module.file, "utf8")
        module.diagnostics.push({
          code: "repair/applied",
          severity: "info",
          message: `auto-repaired ${repair.fixes.length} issue(s) in ${repair.passes} pass(es): ${repair.fixes.map((fix) => `${fix.code}${fix.origin ? ` (${fix.origin})` : ""}`).join(", ")}.`,
        })
      }
      result = typecheck(projectRoot, module.file, owned)
    }
    const runtime = await validateRuntime(module.file)
    return {
      ir,
      module,
      typecheck: { clean: result.clean, diagnostics: result.diagnostics },
      runtime,
      repair,
    }
  },
})

function hookRows(ir: ClassifiedPluginIR, module?: EmittedModule) {
  return ir.hooks.map((hook: ClassifiedHook) => ({
    name: hook.name,
    classification: hook.classification,
    v2: hook.v2,
    ...(hook.reason ? { reason: hook.reason } : {}),
    line: hook.range.line,
    emitted: module?.emitted.includes(hook.name) ?? false,
  }))
}

function toolRows(ir: ClassifiedPluginIR, module?: EmittedModule) {
  return ir.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    line: tool.range.line,
    classification: "converted" as const,
    emitted: module?.tools.includes(tool.name) ?? false,
  }))
}

function counts(hooks: ClassifiedHook[]) {
  return {
    converted: hooks.filter((hook) => hook.classification === "converted").length,
    review: hooks.filter((hook) => hook.classification === "review").length,
    unsupported: hooks.filter((hook) => hook.classification === "unsupported").length,
  }
}

function baseReport(ir: ClassifiedPluginIR, mode: "analyze" | "convert"): MigrationReport {
  return {
    id: ir.id,
    ...(ir.packageName ? { packageName: ir.packageName } : {}),
    sourceDir: ir.sourceDir,
    entryFile: ir.entryFile,
    mode,
    hooks: hookRows(ir),
    tools: toolRows(ir),
    diagnostics: ir.diagnostics,
    leftovers: ir.hooks
      .filter((hook) => hook.classification !== "converted")
      .map((hook) => ({
        name: hook.name,
        v2: hook.v2,
        ...(hook.reason ? { reason: hook.reason } : {}),
        body: hook.body,
        range: hook.range,
      })),
    ...(ir.target ? { target: { version: ir.target.version, missing: ir.target.missing } } : {}),
    counts: counts(ir.hooks),
    toolCounts: {
      converted: ir.tools.length,
      review: 0,
    },
  }
}

const analyzePipeline = pipeline<{ dir: string }>()
  .pipe(resolveStage)
  .pipe(extractStage)
  .pipe(classifyStage)
  .build()

const convertPipeline = pipeline<{ dir: string; outDir: string; dual: boolean; force: boolean }>()
  .onStage((event) => {
    if (process.env.OC_MIGRATE_DEBUG && event.type !== "start") {
      console.error(`[pipeline] ${event.stage} ${event.type}`)
    }
  })
  .pipe(convertStage)
  .pipe(extractStage)
  .pipe(classifyStage)
  .pipe(emitStage)
  .pipe(validateStage)
  .build()

export interface AnalyzeResult {
  readonly report: MigrationReport
  readonly ir: ClassifiedPluginIR
}

export interface ConvertResult extends AnalyzeResult {
  readonly outDir: string
  readonly module: EmittedModule
}

export async function analyzePlugin(
  dir: string,
  options: { root?: string; target?: string } | string = {},
): Promise<AnalyzeResult> {
  const settings = typeof options === "string" ? { root: options } : options
  const root = settings.root ?? process.cwd()
  const ctx = {
    root,
    outDir: path.join(root, ".migrate"),
    log: () => {},
    options: { ...(settings.target ? { target: settings.target } : {}) },
  }
  const ir = await analyzePipeline.run({ dir }, ctx)
  return { report: baseReport(ir, "analyze"), ir }
}

export async function convertPlugin(
  dir: string,
  options: { outDir?: string; root?: string; dual?: boolean; target?: string; force?: boolean } = {},
): Promise<ConvertResult> {
  const root = options.root ?? process.cwd()
  const outRoot = options.outDir ?? path.join(root, ".migrate")

  // Re-running against an already converted package is a no-op, not an error.
  const preview = resolveProject(dir)
  const entryText = fs.readFileSync(preview.entryFile, "utf8")
  if (/Plugin\.define\s*\(/.test(entryText) && findV1Imports(dir).length === 0) {
    const id = (preview.packageName ?? path.basename(preview.dir)).replace(/^@[^/]+\//, "")
    const module: EmittedModule = {
      file: preview.entryFile,
      source: entryText,
      emitted: [],
      skipped: [],
      diagnostics: [],
      tools: [],
      rewrittenFiles: [],
      remainingV1Imports: [],
    }
    const report: MigrationReport = {
      id,
      mode: "convert",
      sourceDir: preview.dir,
      entryFile: preview.entryFile,
      hooks: [],
      tools: [],
      diagnostics: [
        {
          code: "already/converted",
          severity: "info",
          message: "this package already targets the V2 plugin API; nothing was regenerated.",
        },
      ],
      leftovers: [],
      counts: { converted: 0, review: 0, unsupported: 0 },
      toolCounts: { converted: 0, review: 0 },
      ...(preview.packageName ? { packageName: preview.packageName } : {}),
    }
    return { report, ir: undefined as unknown as ClassifiedPluginIR, outDir: preview.dir, module }
  }

  const dual = options.dual === true
  const ctx = { root, outDir: outRoot, log: () => {}, options: { dual } }
  const { ir, module, typecheck: check, runtime, repair } = await convertPipeline.run(
    { dir, outDir: outRoot, dual, force: options.force === true },
    ctx,
  )
  const target = module.file
  // Keep diagnostics that are about the generated module or the project as a whole.
  // Type errors in untouched sibling files (Bun scripts, CLIs) are not migration findings.
  const relevant = check.diagnostics.filter(
    (item) => !item.range || path.resolve(item.range.file) === path.resolve(target),
  )

  const report: MigrationReport = {
    ...baseReport(ir, "convert"),
    generatedFile: module.file,
    hooks: hookRows(ir, module),
    tools: toolRows(ir, module),
    toolCounts: {
      converted: module.tools.length,
      review: ir.tools.length - module.tools.length,
    },
    diagnostics: [...ir.diagnostics, ...module.diagnostics, ...relevant, ...runtime.diagnostics],
    package: {
      rewrittenFiles: module.rewrittenFiles.map((file) =>
        path.relative(path.join(outRoot, ir.id), file),
      ),
      remainingV1Imports: module.remainingV1Imports.map((file) =>
        path.relative(path.join(outRoot, ir.id), file),
      ),
      ...(module.shim ? { shim: path.relative(path.join(outRoot, ir.id), module.shim) } : {}),
      dependencySwapped: module.diagnostics.some((item) => item.code === "package/dependency-swap"),
      hasManifest: !module.diagnostics.some((item) => item.code === "package/missing"),
    },
    typecheck: {
      clean: check.clean,
      errors: relevant.filter((item) => item.severity === "error").length,
      warnings: relevant.filter((item) => item.severity === "warning").length,
    },
    runtime: { bundle: runtime.bundle, entry: runtime.entry },
    repair,
    scaffolding: module.diagnostics
      .filter((item) => /^(config|layout|tui|dual)\//.test(item.code))
      .map((item) => ({ kind: item.code, detail: item.message })),
  }

  return { report, ir, outDir: path.join(outRoot, ir.id), module }
}
