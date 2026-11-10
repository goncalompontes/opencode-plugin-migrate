/**
 * Emit a V2 module from the classified IR.
 *
 * Two properties matter more than idiomatic output here:
 *  - every converted hook keeps its original body verbatim, so behavior survives;
 *  - the emitted module is a *complete* module with the unconverted hooks moved into
 *    a report block, so a partial migration still parses and typechecks.
 */
import path from "node:path"
import type { Diagnostic } from "../core/diagnostics"
import type { ClassifiedHook, ClassifiedPluginIR, EmittedModule } from "../ir/schema"

const INDENT = "  "

function reindent(text: string, level: number): string {
  const pad = INDENT.repeat(level)
  const lines = text.split("\n")
  const tail = lines.slice(1).filter((line) => line.trim().length > 0)
  const common = tail.length
    ? Math.min(...tail.map((line) => line.length - line.trimStart().length))
    : 0
  return lines
    .map((line, index) => {
      if (line.trim().length === 0) return ""
      const content = index === 0 ? line.trimStart() : line.slice(common)
      return pad + content
    })
    .join("\n")
}

function carried(text: string, level: number): string {
  const pad = INDENT.repeat(level)
  return [`${pad}// #region carried-v1`, reindent(text, level), `${pad}// #endregion carried-v1`].join("\n")
}

function comment(text: string): string {
  return text
    .split("\n")
    .map((line) => `// ${line}`.trimEnd())
    .join("\n")
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function uses(ir: ClassifiedPluginIR, name: string): boolean {
  // `$` is not a word character, so \b does not work for the Bun shell helper.
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(name)}([^A-Za-z0-9_$]|$)`)
  const bodies = [ir.factory.init, ...ir.hooks.map((hook) => hook.body)]
  return bodies.some((body) => pattern.test(body))
}

function factoryLocals(ir: ClassifiedPluginIR): { lines: string[]; diagnostics: Diagnostic[] } {
  const lines: string[] = []
  const diagnostics: Diagnostic[] = []
  if (ir.factory.inputParam) {
    // The V1 factory took the whole PluginInput object. Rebuild the parts plugins read,
    // and expose the V2 context as `client` for code that still calls the old client API.
    lines.push(`// TODO(v2): the V1 PluginInput is reconstructed from ctx; port client calls to ctx domains.`)
    lines.push(
      `const ${ir.factory.inputParam}: any = { ...__opencode, client: __opencode, directory: __opencode.location.directory, project: __opencode.location.project, worktree: __opencode.location.directory }`,
    )
    diagnostics.push({
      code: "context/input-object",
      severity: "warning",
      message:
        "the V1 factory received the whole PluginInput; it is reconstructed from ctx, and `client` calls must be ported to ctx domains.",
    })
    return { lines, diagnostics }
  }
  for (const param of ir.factory.params) {
    if (!uses(ir, param)) continue
    switch (param) {
      case "directory":
        lines.push("const directory = __opencode.location.directory")
        break
      case "project":
        lines.push("const project = __opencode.location.project")
        break
      case "worktree":
        lines.push("const worktree = __opencode.location.directory")
        diagnostics.push({
          code: "context/worktree",
          severity: "warning",
          message:
            "V2 has no separate worktree value on the plugin context; `worktree` was mapped to ctx.location.directory and needs confirmation.",
        })
        break
      case "client":
        lines.push("// TODO(v2): the V1 client API moved onto ctx domains (ctx.session, ctx.tool, ...).")
        lines.push("const client: any = __opencode")
        diagnostics.push({
          code: "context/client",
          severity: "warning",
          message:
            "plugin uses the V1 `client`; it is bound to the V2 context as `any` so the module compiles, but calls must be ported to ctx domains.",
        })
        break
      case "$":
        lines.push("// TODO(v2): V2 does not pass the Bun $ helper; fall back to the host global and review.")
        lines.push("const $: any = (globalThis as any).Bun?.$")
        diagnostics.push({
          code: "context/bun-shell",
          severity: "warning",
          message:
            "plugin uses the V1 `$` shell helper; V2 does not provide it, so it is bound to globalThis.Bun.$ when the host exposes Bun.",
        })
        break
      default:
        lines.push(`// TODO(v2): V1 input "${param}" has no direct V2 context equivalent.`)
        lines.push(`const ${param}: any = undefined`)
        diagnostics.push({
          code: "context/param",
          severity: "warning",
          message: `V1 plugin input "${param}" has no direct V2 context equivalent and was stubbed.`,
        })
    }
  }
  return { lines, diagnostics }
}

function adapterBody(hook: ClassifiedHook, id: string, index: number, level: number): string {
  const body = hook.body.trim()
  const pad = INDENT.repeat(level)
  const inner = carried(body, level + 1)
  const inner2 = carried(body, level + 2)
  switch (hook.adapter) {
    case "tool-execute-before":
      return [
        `${pad}await __opencode.tool.hook("execute.before", async (event) => {`,
        `${pad}${INDENT}const input: any = { tool: event.tool, sessionID: event.sessionID, callID: event.id }`,
        `${pad}${INDENT}const output: any = { args: event.input }`,
        `${pad}${INDENT}try {`,
        inner2,
        `${pad}${INDENT}} finally {`,
        `${pad}${INDENT}${INDENT}event.input = output.args`,
        `${pad}${INDENT}}`,
        `${pad}})`,
      ].join("\n")

    case "tool-execute-after":
      return [
        `${pad}await __opencode.tool.hook("execute.after", async (event) => {`,
        `${pad}${INDENT}if (event.status !== "completed") return`,
        `${pad}${INDENT}const input: any = { tool: event.tool, sessionID: event.sessionID, callID: event.id, args: event.input }`,
        `${pad}${INDENT}const result: any = event.result ?? {}`,
        `${pad}${INDENT}const output: any = {`,
        `${pad}${INDENT}${INDENT}title: typeof result.title === "string" ? result.title : "",`,
        `${pad}${INDENT}${INDENT}output: typeof result.content === "string" ? result.content : typeof result.output === "string" ? result.output : "",`,
        `${pad}${INDENT}${INDENT}metadata: result.metadata,`,
        `${pad}${INDENT}}`,
        `${pad}${INDENT}try {`,
        inner2,
        `${pad}${INDENT}} finally {`,
        `${pad}${INDENT}${INDENT}event.result = { ...result, content: output.output, metadata: output.metadata }`,
        `${pad}${INDENT}}`,
        `${pad}})`,
      ].join("\n")

    case "event-subscribe":
      return [
        `${pad}const abort${index} = new AbortController()`,
        `${pad}__cleanups.push(() => abort${index}.abort())`,
        `${pad}void (async () => {`,
        `${pad}${INDENT}try {`,
        `${pad}${INDENT}${INDENT}for await (const __event of __opencode.event.subscribe({ signal: abort${index}.signal })) {`,
        `${pad}${INDENT}${INDENT}${INDENT}const event: any = __event`,
        `${pad}${INDENT}${INDENT}${INDENT}try {`,
        carried(body, level + 4),
        `${pad}${INDENT}${INDENT}${INDENT}} catch (error) {`,
        `${pad}${INDENT}${INDENT}${INDENT}${INDENT}console.error(${JSON.stringify(`[${id}] event handler failed`)}, error)`,
        `${pad}${INDENT}${INDENT}${INDENT}}`,
        `${pad}${INDENT}${INDENT}}`,
        `${pad}${INDENT}} catch (error) {`,
        `${pad}${INDENT}${INDENT}console.error(${JSON.stringify(`[${id}] event subscription failed`)}, error)`,
        `${pad}${INDENT}}`,
        `${pad}})()`,
      ].join("\n")

    case "tool-transform":
      return [
        `${pad}await __opencode.tool.transform((editor) => {`,
        `${pad}${INDENT}for (const current of editor.list()) {`,
        `${pad}${INDENT}${INDENT}const input: any = { toolID: current.id }`,
        `${pad}${INDENT}${INDENT}const output: any = { description: current.description, parameters: current.input }`,
        `${pad}${INDENT}${INDENT}try {`,
        carried(body, level + 3),
        `${pad}${INDENT}${INDENT}} finally {`,
        `${pad}${INDENT}${INDENT}${INDENT}editor.update(current.id, (tool) => {`,
        `${pad}${INDENT}${INDENT}${INDENT}${INDENT}tool.description = output.description`,
        `${pad}${INDENT}${INDENT}${INDENT}${INDENT}tool.input = output.parameters`,
        `${pad}${INDENT}${INDENT}${INDENT}})`,
        `${pad}${INDENT}${INDENT}}`,
        `${pad}${INDENT}}`,
        `${pad}})`,
      ].join("\n")

    case "permission-evaluate":
      return [
        `${pad}await __opencode.permission.hook("evaluate", async (event) => {`,
        `${pad}${INDENT}const input: any = { ...event, type: event.action, pattern: event.resources, patterns: event.resources, title: event.action }`,
        `${pad}${INDENT}const output: any = { status: event.effect }`,
        `${pad}${INDENT}try {`,
        inner2,
        `${pad}${INDENT}} finally {`,
        `${pad}${INDENT}${INDENT}event.effect = output.status`,
        `${pad}${INDENT}}`,
        `${pad}})`,
      ].join("\n")

    case "shell-env":
      return [
        `${pad}await __opencode.shell.hook("create.before", async (event) => {`,
        `${pad}${INDENT}const input: any = { cwd: event.cwd }`,
        `${pad}${INDENT}const output: any = { env: event.env }`,
        `${pad}${INDENT}try {`,
        inner2,
        `${pad}${INDENT}} finally {`,
        `${pad}${INDENT}${INDENT}event.env = output.env`,
        `${pad}${INDENT}}`,
        `${pad}})`,
      ].join("\n")

    case "dispose":
      return [`${pad}__cleanups.push(async () => {`, inner, `${pad}})`].join("\n")

    case "none":
      return ""
    default:
      return ""
  }
}

function sanitizeInit(init: string): { text: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  // In a V1 factory `return {}` means "no hooks"; a V2 setup returns void instead.
  const text = init.replace(/return\s*\{\s*\};?/g, "return;\n")
  const remaining = text.match(/^\s*return\s+[^\s;]/gm)
  if (remaining && remaining.length > 0) {
    diagnostics.push({
      code: "factory/early-return",
      severity: "warning",
      message:
        "the factory returned before building hooks; conditional early returns need manual review because V2 setup() cannot return a hook map.",
    })
  }
  return { text, diagnostics }
}

export function emitModule(ir: ClassifiedPluginIR, outFile: string): EmittedModule {
  const diagnostics: Diagnostic[] = []
  const { lines: locals, diagnostics: localDiagnostics } = factoryLocals(ir)
  diagnostics.push(...localDiagnostics)
  const init = sanitizeInit(ir.factory.init)
  diagnostics.push(...init.diagnostics)

  const emittedHooks: ClassifiedHook[] = []
  const skippedHooks: ClassifiedHook[] = []
  for (const hook of ir.hooks) {
    const convert = hook.classification === "converted" && hook.adapter !== "none"
    if (convert && hook.adapter === "tool-transform" && hook.usesAwait) {
      diagnostics.push({
        code: "hook/tool-transform-async",
        severity: "warning",
        message: `"${hook.name}" is async, but V2 tool transforms are synchronous; it was left for manual porting.`,
        range: hook.range,
      })
      skippedHooks.push(hook)
      continue
    }
    if (convert) emittedHooks.push(hook)
    else skippedHooks.push(hook)
  }

  const needsCleanups = emittedHooks.some(
    (hook) => hook.adapter === "dispose" || hook.adapter === "event-subscribe",
  )

  const blocks: string[] = []
  if (locals.length) blocks.push(reindent(locals.join("\n"), 2))
  if (init.text.trim()) blocks.push(carried(init.text, 2))
  if (needsCleanups) blocks.push(`  const __cleanups: Array<() => void | Promise<void>> = []`)

  emittedHooks.forEach((hook, index) => {
    const rendered = adapterBody(hook, ir.id, index, 2)
    if (rendered) blocks.push(rendered)
  })

  if (skippedHooks.length) {
    const notes = skippedHooks.map((hook) => {
      const why = hook.reason ? `\n//   ${hook.reason}` : ""
      return `//\n// "${hook.name}" -> ${hook.v2} [${hook.classification}]${why}\n//\n${comment(hook.body)}`
    })
    blocks.push(
      reindent(
        ["// --- Not converted automatically; original bodies kept for manual porting ---", ...notes].join("\n"),
        2,
      ),
    )
  }

  if (needsCleanups) {
    blocks.push(`  return async () => {`)
    blocks.push(`    for (const cleanup of __cleanups) await cleanup()`)
    blocks.push(`  }`)
  }

  const importLines = [
    `import { Plugin } from "@opencode/plugin"`,
    ...ir.imports.map((item) => item.text),
  ]

  const exportBase = ir.exportName ?? "plugin"
  const localName = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportBase) ? exportBase : "plugin"

  const source = [
    `/**`,
    ` * Migrated from OpenCode V1 by opencode-plugin-migrate.`,
    ` * Source: ${path.relative(process.cwd(), ir.entryFile) || ir.entryFile}`,
    ` * Review every "not converted automatically" block before shipping.`,
    ` */`,
    ...importLines,
    ``,
    ...(ir.moduleScope.trim() ? [carried(ir.moduleScope, 0), ``] : []),
    `const ${localName} = Plugin.define({`,
    `  id: ${JSON.stringify(ir.id)},`,
    `  async setup(__opencode) {`,
    ...blocks,
    `  },`,
    `})`,
    ``,
    `export default ${localName}`,
    ...(ir.exportName && ir.exportName !== localName
      ? [`export { ${localName} as ${ir.exportName} }`]
      : ir.exportName
        ? []
        : []),
    ``,
  ].join("\n")

  return {
    file: outFile,
    source,
    emitted: emittedHooks.map((hook) => hook.name),
    skipped: skippedHooks.map((hook) => hook.name),
    diagnostics,
    rewrittenFiles: [],
    remainingV1Imports: [],
  }
}
