/** The intermediate representation every later stage consumes. */
import { z } from "zod"
import { Diagnostic, SourceRange } from "../core/diagnostics"

export const ImportIR = z.object({
  /** Original declaration text, e.g. `import * as fs from "fs"`. */
  text: z.string(),
  module: z.string(),
})
export type ImportIR = z.infer<typeof ImportIR>

export const FactoryIR = z.object({
  /** Names destructured from the V1 plugin input, e.g. directory, client, project, $. */
  params: z.array(z.string()),
  /** Set when the factory takes the whole PluginInput as one identifier, e.g. `async (ctx) => ...`. */
  inputParam: z.string().optional(),
  /** Statements executed before the hooks object is returned, verbatim. */
  init: z.string(),
  isAsync: z.boolean(),
  /** Set when the entry is a dual-shape V1/V2 object and this was its `server` branch. */
  dualShape: z.boolean(),
})
export type FactoryIR = z.infer<typeof FactoryIR>

export const HookSite = z.object({
  /** V1 hook key exactly as written, e.g. `tool.execute.before`. */
  name: z.string(),
  /** Declared parameter names of the callback. */
  params: z.array(z.string()),
  /** Callback body as statements (no outer braces), verbatim. */
  body: z.string(),
  isAsync: z.boolean(),
  usesAwait: z.boolean(),
  /** True when the callback uses a rest/destructured parameter instead of (input, output). */
  usesPatternParams: z.boolean(),
  range: SourceRange,
  /** Checker-rendered type of the callback, when available. */
  typeText: z.string().optional(),
})
export type HookSite = z.infer<typeof HookSite>

export const ToolSite = z.object({
  name: z.string(),
  description: z.string(),
  /** Expression that yields the V1 tool definition at runtime. */
  reference: z.string(),
  kind: z.enum(["inline", "reference"]),
  range: SourceRange,
})
export type ToolSite = z.infer<typeof ToolSite>

export const PluginIR = z.object({
  /** Stable V2 plugin id. */
  id: z.string(),
  packageName: z.string().optional(),
  sourceDir: z.string(),
  entryFile: z.string(),
  /** Named export of the V1 factory, preserved so re-exporting entrypoints keep working. */
  exportName: z.string().optional(),
  sourceFiles: z.array(z.string()),
  tsconfigPath: z.string().optional(),
  /** Module-scope statements carried over verbatim (constants, helper types, functions). */
  moduleScope: z.string(),
  factory: FactoryIR,
  imports: z.array(ImportIR),
  hooks: z.array(HookSite),
  tools: z.array(ToolSite),
  /** Findings produced during extraction (unsupported syntax, ambiguous entrypoints, ...). */
  diagnostics: z.array(Diagnostic),
})
export type PluginIR = z.infer<typeof PluginIR>

export const Classification = z.enum(["converted", "review", "unsupported"])
export type Classification = z.infer<typeof Classification>

export const AdapterKind = z.enum([
  "tool-execute-before",
  "tool-execute-after",
  "event-subscribe",
  "tool-transform",
  "shell-env",
  "permission-evaluate",
  "dispose",
  "none",
])
export type AdapterKind = z.infer<typeof AdapterKind>

export const ClassifiedHook = HookSite.extend({
  classification: Classification,
  /** How the emitter reproduces this hook, when it can. */
  adapter: AdapterKind,
  /** Closest V2 API. */
  v2: z.string(),
  reason: z.string().optional(),
})
export type ClassifiedHook = z.infer<typeof ClassifiedHook>

export const ClassifiedPluginIR = PluginIR.extend({
  hooks: z.array(ClassifiedHook),
})
export type ClassifiedPluginIR = z.infer<typeof ClassifiedPluginIR>

export const EmittedModule = z.object({
  /** Absolute path of the generated module. */
  file: z.string(),
  source: z.string(),
  /** Which hook names were emitted, in registration order. */
  emitted: z.array(z.string()),
  /** Hook names intentionally left out of the module. */
  skipped: z.array(z.string()),
  diagnostics: z.array(Diagnostic),
  /** Custom tool names registered through ctx.tool.transform. */
  tools: z.array(z.string()),
  /** Other package files whose V1 authoring imports were redirected to the shim. */
  rewrittenFiles: z.array(z.string()),
  /** Files that still import the V1 package (namespace/dynamic forms). */
  remainingV1Imports: z.array(z.string()),
  shim: z.string().optional(),
})
export type EmittedModule = z.infer<typeof EmittedModule>
