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
import { rewriteV1Imports } from "./env/imports"
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
import { typecheck } from "./validate/typecheck"
import { validateRuntime } from "./validate/bundle"
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
})

const EmitOutput = z.object({ ir: ClassifiedPluginIR, module: EmittedModule })
const ValidateOutput = EmitOutput.extend({
  typecheck: z.object({ clean: z.boolean(), diagnostics: z.array(Diagnostic) }),
  runtime: z.object({
    bundle: z.object({ ok: z.boolean(), errors: z.array(z.string()) }),
    entry: z.object({ ok: z.boolean(), message: z.string() }),
    diagnostics: z.array(Diagnostic),
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
  run: async (ir) => classify(ir),
})

const emitStage = stage({
  name: "emit-v2",
  input: ClassifiedPluginIR,
  output: EmitOutput,
  run: async (ir, ctx) => {
    const target = path.join(ctx.outDir, ir.id)
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
    const relative = path.relative(ir.sourceDir, ir.entryFile)
    const file = path.join(target, relative)
    const module = emitModule(ir, file, { dual: ctx.options?.dual === true })
    if (!module.source.includes("Plugin.define")) {
      throw new Error("emitter produced no Plugin.define call")
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, module.source)

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
    const result = typecheck(projectRoot, module.file, owned)
    const runtime = await validateRuntime(module.file)
    return {
      ir,
      module,
      typecheck: { clean: result.clean, diagnostics: result.diagnostics },
      runtime,
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

const convertPipeline = pipeline<{ dir: string; outDir: string; dual: boolean }>()
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

export async function analyzePlugin(dir: string, root = process.cwd()): Promise<AnalyzeResult> {
  const ctx = { root, outDir: path.join(root, ".migrate"), log: () => {} }
  const ir = await analyzePipeline.run({ dir }, ctx)
  return { report: baseReport(ir, "analyze"), ir }
}

export async function convertPlugin(
  dir: string,
  options: { outDir?: string; root?: string; dual?: boolean } = {},
): Promise<ConvertResult> {
  const root = options.root ?? process.cwd()
  const outRoot = options.outDir ?? path.join(root, ".migrate")
  const dual = options.dual === true
  const ctx = { root, outDir: outRoot, log: () => {}, options: { dual } }
  const { ir, module, typecheck: check, runtime } = await convertPipeline.run(
    { dir, outDir: outRoot, dual },
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
    scaffolding: module.diagnostics
      .filter((item) => /^(config|layout|tui|dual)\//.test(item.code))
      .map((item) => ({ kind: item.code, detail: item.message })),
  }

  return { report, ir, outDir: path.join(outRoot, ir.id), module }
}
