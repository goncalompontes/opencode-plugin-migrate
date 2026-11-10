import { z } from "zod"
import { Diagnostic, SourceRange } from "../core/diagnostics"
import { Classification } from "../ir/schema"

export const HookReportRow = z.object({
  name: z.string(),
  classification: Classification,
  v2: z.string(),
  reason: z.string().optional(),
  line: z.number().int().positive(),
  /** True when the hook body made it into the generated module. */
  emitted: z.boolean(),
})
export type HookReportRow = z.infer<typeof HookReportRow>

export const ToolReportRow = z.object({
  name: z.string(),
  description: z.string(),
  line: z.number().int().positive(),
})
export type ToolReportRow = z.infer<typeof ToolReportRow>

export const TypecheckReport = z.object({
  clean: z.boolean(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
})
export type TypecheckReport = z.infer<typeof TypecheckReport>

export const PackageReport = z.object({
  /** Files whose V1 authoring imports were redirected to the generated shim. */
  rewrittenFiles: z.array(z.string()),
  /** Files that still import the V1 package; the dependency is kept when non-empty. */
  remainingV1Imports: z.array(z.string()),
  shim: z.string().optional(),
  dependencySwapped: z.boolean(),
  hasManifest: z.boolean(),
})
export type PackageReport = z.infer<typeof PackageReport>

export const MigrationReport = z.object({
  id: z.string(),
  packageName: z.string().optional(),
  sourceDir: z.string(),
  entryFile: z.string(),
  mode: z.enum(["analyze", "convert"]),
  generatedFile: z.string().optional(),
  hooks: z.array(HookReportRow),
  tools: z.array(ToolReportRow),
  diagnostics: z.array(Diagnostic),
  typecheck: TypecheckReport.optional(),
  package: PackageReport.optional(),
  /** Original source of every hook that was not emitted, for manual porting. */
  leftovers: z.array(
    z.object({
      name: z.string(),
      v2: z.string(),
      reason: z.string().optional(),
      body: z.string(),
      range: SourceRange,
    }),
  ),
  counts: z.object({
    converted: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
  }),
})
export type MigrationReport = z.infer<typeof MigrationReport>
