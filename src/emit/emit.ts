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
import { clientDiagnostics, renderClientFacade, scanClientCalls } from "../env/client"
import type { ClassifiedHook, ClassifiedPluginIR, EmittedModule, ToolSite } from "../ir/schema"

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

function carried(text: string, level: number, origin?: string): string {
  const pad = INDENT.repeat(level)
  const label = origin ? ` ${origin}` : ""
  return [
    `${pad}// #region carried-v1${label}`,
    reindent(text, level),
    `${pad}// #endregion carried-v1`,
  ].join("\n")
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
  const bodies = [ir.factory.init, ...ir.hooks.map((hook) => hook.body)]
  const clientCalls = scanClientCalls(bodies)
  const usesClient = uses(ir, "client")
  if (ir.factory.inputParam) {
    // The V1 factory took the whole PluginInput object. Rebuild the parts plugins read.
    if (usesClient) {
      lines.push(...renderClientFacade("__v1client"))
      diagnostics.push(...clientDiagnostics(clientCalls))
    }
    lines.push(`// TODO(v2): the V1 PluginInput is reconstructed from ctx.`)
    lines.push(
      `const ${ir.factory.inputParam}: any = { ...__opencode, client: ${usesClient ? "__v1client" : "__opencode"}, directory: __opencode.location.directory, project: __opencode.location.project, worktree: __opencode.location.directory }`,
    )
    diagnostics.push({
      code: "context/input-object",
      severity: "warning",
      message:
        "the V1 factory received the whole PluginInput; it is reconstructed from ctx, and client calls go through the generated facade.",
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
        lines.push(...renderClientFacade("client"))
        diagnostics.push(...clientDiagnostics(clientCalls))
        break
      case "$":
        lines.push(
          "// TODO(v2): V2 does not pass the Bun $ helper; fall back to the host global and review.",
        )
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

function dedentExpression(text: string): string {
  const lines = text.split("\n")
  const tail = lines.slice(1).filter((line) => line.trim().length > 0)
  const common = tail.length
    ? Math.min(...tail.map((line) => line.length - line.trimStart().length))
    : 0
  return lines.map((line, index) => (index === 0 ? line : line.slice(common))).join("\n")
}

function renderLegacy(ir: ClassifiedPluginIR): string[] {
  const lines = [
    "// V1 entrypoint retained for hosts on OpenCode >= 1.18.29.",
    `const __v1: any = async (${ir.factory.paramsTyped.join(", ")}) => {`,
  ]
  if (ir.factory.init.trim()) lines.push(reindent(ir.factory.init, 1))
  if (ir.tools.some((tool) => tool.kind === "inline")) {
    lines.push(
      `  const tool = Object.assign(`,
      `    (definition: { description: string; args: any; execute: (args: any, context: any) => any }) => definition,`,
      `    { schema: __z },`,
      `  )`,
    )
  }
  lines.push("  return {")
  for (const hook of ir.hooks) {
    lines.push(`    ${JSON.stringify(hook.name)}: async (${hook.paramsTyped.join(", ")}) => {`)
    if (hook.body.trim()) lines.push(reindent(hook.body, 3))
    lines.push("    },")
  }
  if (ir.tools.length) {
    lines.push("    tool: {")
    for (const tool of ir.tools)
      lines.push(`      ${JSON.stringify(tool.name)}: ${tool.reference},`)
    lines.push("    },")
  }
  lines.push("  }", "}", "")
  return lines
}

function renderToolRegistration(tool: ToolSite, index: number, level: number): string {
  const pad = INDENT.repeat(level)
  const inner = (depth: number) => pad + INDENT.repeat(depth)
  return [
    `${pad}await __opencode.tool.transform((editor) => {`,
    `${inner(1)}editor.add({`,
    `${inner(2)}name: ${JSON.stringify(tool.name)},`,
    `${inner(2)}description: __tool${index}.description,`,
    `${inner(2)}input: __z.toJSONSchema(__z.object(__tool${index}.args)) as any,`,
    `${inner(2)}async execute(input: any, context: any) {`,
    `${inner(3)}const args: any = input`,
    `${inner(3)}const ctx: any = {`,
    `${inner(4)}...context,`,
    `${inner(4)}abort: context.signal,`,
    `${inner(4)}directory: __opencode.location.directory,`,
    `${inner(4)}worktree: __opencode.location.directory,`,
    `${inner(4)}metadata: (_update: any) => {},`,
    `${inner(4)}ask: async (_input: any) => {},`,
    `${inner(3)}}`,
    `${inner(3)}const result: any = await __tool${index}.execute(args, ctx)`,
    `${inner(3)}if (typeof result === "string") return { content: result }`,
    `${inner(3)}if (result && typeof result === "object") {`,
    `${inner(4)}return { content: result.output, metadata: result.metadata }`,
    `${inner(3)}}`,
    `${inner(3)}return {}`,
    `${inner(2)}},`,
    `${inner(1)}})`,
    `${pad}})`,
  ].join("\n")
}

function adapterBody(hook: ClassifiedHook, id: string, index: number, level: number): string {
  const body = hook.body.trim()
  const pad = INDENT.repeat(level)
  const inner = carried(body, level + 1, hook.name)
  const inner2 = carried(body, level + 2, hook.name)
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
        carried(body, level + 4, hook.name),
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
        carried(body, level + 3, hook.name),
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

    case "session-prompt":
      return [
        `${pad}await __opencode.session.hook("prompt", async (event: any) => {`,
        `${pad}${INDENT}const input: any = { sessionID: event.sessionID, messageID: event.messageID, agent: undefined, model: undefined }`,
        `${pad}${INDENT}const output: any = {`,
        `${pad}${INDENT}${INDENT}message: { id: event.messageID, sessionID: event.sessionID },`,
        `${pad}${INDENT}${INDENT}parts: [{ type: "text", id: event.messageID, sessionID: event.sessionID, messageID: event.messageID, text: event.prompt?.text ?? "" }],`,
        `${pad}${INDENT}}`,
        `${pad}${INDENT}try {`,
        inner2,
        `${pad}${INDENT}} finally {`,
        `${pad}${INDENT}${INDENT}const text = output.parts`,
        `${pad}${INDENT}${INDENT}  .filter((part: any) => part?.type === "text")`,
        `${pad}${INDENT}${INDENT}  .map((part: any) => part.text)`,
        `${pad}${INDENT}${INDENT}  .join("")`,
        `${pad}${INDENT}${INDENT}event.prompt.text = text`,
        `${pad}${INDENT}}`,
        `${pad}})`,
      ].join("\n")

    case "session-context":
      return [
        `${pad}await __opencode.session.hook("context", async (event: any) => {`,
        `${pad}${INDENT}const input: any = {`,
        `${pad}${INDENT}${INDENT}sessionID: event.sessionID,`,
        `${pad}${INDENT}${INDENT}agent: event.agent,`,
        `${pad}${INDENT}${INDENT}model: { ...event.model, id: event.model?.modelID },`,
        `${pad}${INDENT}${INDENT}provider: {},`,
        `${pad}${INDENT}${INDENT}message: undefined,`,
        `${pad}${INDENT}}`,
        `${pad}${INDENT}const output: any = {`,
        `${pad}${INDENT}${INDENT}temperature: event.options?.temperature,`,
        `${pad}${INDENT}${INDENT}topP: event.options?.topP,`,
        `${pad}${INDENT}${INDENT}topK: event.options?.topK,`,
        `${pad}${INDENT}${INDENT}maxOutputTokens: event.options?.maxTokens,`,
        `${pad}${INDENT}${INDENT}options: event.options ?? {},`,
        `${pad}${INDENT}}`,
        `${pad}${INDENT}try {`,
        inner2,
        `${pad}${INDENT}} finally {`,
        `${pad}${INDENT}${INDENT}event.options = output.options ?? event.options`,
        `${pad}${INDENT}${INDENT}event.options.temperature = output.temperature`,
        `${pad}${INDENT}${INDENT}event.options.topP = output.topP`,
        `${pad}${INDENT}${INDENT}event.options.topK = output.topK`,
        `${pad}${INDENT}${INDENT}event.options.maxTokens = output.maxOutputTokens`,
        `${pad}${INDENT}}`,
        `${pad}})`,
      ].join("\n")

    case "model-request":
      return [
        `${pad}await __opencode.session.hook("model.request", async (event: any) => {`,
        `${pad}${INDENT}const input: any = { sessionID: event.sessionID, agent: event.agent, model: event.model, provider: {}, message: undefined }`,
        `${pad}${INDENT}const output: any = { headers: event.headers }`,
        `${pad}${INDENT}try {`,
        inner2,
        `${pad}${INDENT}} finally {`,
        `${pad}${INDENT}${INDENT}event.headers = output.headers`,
        `${pad}${INDENT}}`,
        `${pad}})`,
      ].join("\n")

    case "system-transform":
      return [
        `${pad}await __opencode.session.hook("context", async (event: any) => {`,
        `${pad}${INDENT}const __originalSystem = event.system`,
        `${pad}${INDENT}const input: any = { sessionID: event.sessionID, model: event.model }`,
        `${pad}${INDENT}const output: any = { system: __originalSystem.map((part: any) => part.text) }`,
        `${pad}${INDENT}try {`,
        inner2,
        `${pad}${INDENT}} finally {`,
        `${pad}${INDENT}${INDENT}event.system = output.system.map((text: any, index: number) => ({`,
        `${pad}${INDENT}${INDENT}  ...(__originalSystem[index] ?? {}),`,
        `${pad}${INDENT}${INDENT}  type: "text",`,
        `${pad}${INDENT}${INDENT}  text,`,
        `${pad}${INDENT}${INDENT}}))`,
        `${pad}${INDENT}}`,
        `${pad}})`,
      ].join("\n")

    case "config-command":
      return [
        `${pad}await __opencode.command.transform((editor) => {`,
        `${pad}${INDENT}const input: any = {`,
        `${pad}${INDENT}${INDENT}command: new Proxy({}, {`,
        `${pad}${INDENT}${INDENT}  set: (_target, name, value: any) => {`,
        `${pad}${INDENT}${INDENT}    editor.add({`,
        `${pad}${INDENT}${INDENT}      name: String(name),`,
        `${pad}${INDENT}${INDENT}      description: value?.description,`,
        `${pad}${INDENT}${INDENT}      execute: async (invocation: any) => {`,
        `${pad}${INDENT}${INDENT}        const text = String(value?.template ?? "")`,
        `${pad}${INDENT}${INDENT}        if (!text) return`,
        `${pad}${INDENT}${INDENT}        await __opencode.session.prompt({ sessionID: invocation.sessionID, text })`,
        `${pad}${INDENT}${INDENT}      },`,
        `${pad}${INDENT}${INDENT}    })`,
        `${pad}${INDENT}${INDENT}    return true`,
        `${pad}${INDENT}${INDENT}  },`,
        `${pad}${INDENT}${INDENT}}),`,
        `${pad}${INDENT}}`,
        `${pad}${INDENT}try {`,
        inner2,
        `${pad}${INDENT}} catch (error) {`,
        `${pad}${INDENT}${INDENT}console.error("[opencode-plugin-migrate] config command registration failed", error)`,
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

export function emitModule(
  ir: ClassifiedPluginIR,
  outFile: string,
  options: { dual?: boolean } = {},
): EmittedModule {
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
  if (init.text.trim()) blocks.push(carried(init.text, 2, "setup.init"))
  if (needsCleanups) blocks.push(`  const __cleanups: Array<() => void | Promise<void>> = []`)

  if (emittedHooks.some((hook) => hook.adapter === "config-command")) {
    diagnostics.push({
      code: "config/command-template",
      severity: "warning",
      message:
        "config.command maps to ctx.command.transform(); V1 template text is sent as prompt text, and $ARGUMENTS placeholders are not substituted.",
    })
  }

  const groups = new Map<string, ClassifiedHook[]>()
  const unconditional: ClassifiedHook[] = []
  for (const hook of emittedHooks) {
    if (hook.condition) {
      const group = groups.get(hook.condition) ?? []
      group.push(hook)
      groups.set(hook.condition, group)
    } else {
      unconditional.push(hook)
    }
  }
  const renderHooks = (hooks: ClassifiedHook[], level: number) => {
    for (const hook of hooks) {
      const rendered = adapterBody(hook, ir.id, emittedHooks.indexOf(hook), level)
      if (rendered) blocks.push(rendered)
    }
  }

  const conditionOrder = [...new Set([...ir.conditions, ...groups.keys()])]
  if (conditionOrder.length) {
    let first = true
    for (const condition of conditionOrder) {
      const hooks = groups.get(condition) ?? []
      blocks.push(`  ${first ? "if" : "else if"} (${condition}) {`)
      if (hooks.length === 0) blocks.push(`    return`)
      else renderHooks(hooks, 3)
      blocks.push(`  }`)
      first = false
    }
    if (unconditional.length) {
      blocks.push(`  else {`)
      renderHooks(unconditional, 3)
      blocks.push(`  }`)
    }
  } else {
    renderHooks(unconditional, 2)
  }

  if (ir.tools.length) {
    const inline = ir.tools.some((tool) => tool.kind === "inline")
    if (inline) {
      // The declared parameter types give the carried inline config contextual typing,
      // so `execute(args)` does not become an implicit-any error.
      blocks.push(
        [
          `  const tool = Object.assign(`,
          `    (definition: {`,
          `      description: string`,
          `      args: any`,
          `      execute: (args: any, context: any) => any`,
          `    }) => definition,`,
          `    { schema: __z },`,
          `  )`,
        ].join("\n"),
      )
    }
    ir.tools.forEach((tool, index) => {
      const expression = dedentExpression(tool.reference)
        .split("\n")
        .map((line, lineIndex) => (lineIndex === 0 ? line : `${INDENT.repeat(2)}${line}`))
        .join("\n")
      blocks.push(`  const __tool${index} = ${expression}`)
      blocks.push(renderToolRegistration(tool, index, 2))
    })
  }

  if (ir.providers.length) {
    ir.providers.forEach((provider, index) => {
      const expression = dedentExpression(provider.reference)
        .split("\n")
        .map((line, lineIndex) => (lineIndex === 0 ? line : `${INDENT.repeat(2)}${line}`))
        .join("\n")
      blocks.push(`  const __provider${index} = ${expression}`)
      blocks.push(
        `  const __providerModels${index}: any = __provider${index}.models ? await __provider${index}.models({} as any, {}) : {}`,
      )
      blocks.push(`  await __opencode.provider.transform((editor) => {`)
      blocks.push(
        `    const models = Object.entries(__providerModels${index} ?? {}).map(([id, model]) => ({`,
      )
      blocks.push(`      ...(model as any),`)
      blocks.push(`      id: (model as any)?.id ?? id,`)
      blocks.push(`      providerID: __provider${index}.id,`)
      blocks.push(`    }))`)
      blocks.push(`    editor.models.set(__provider${index}.id, models as any)`)
      blocks.push(`  })`)
    })
    diagnostics.push({
      code: "provider/registration",
      severity: "info",
      message: `${ir.providers.length} provider hook(s) registered through ctx.provider.transform; models are resolved once at setup.`,
    })
  }

  if (ir.auths.length) {
    ir.auths.forEach((auth, index) => {
      const expression = dedentExpression(auth.reference)
        .split("\n")
        .map((line, lineIndex) => (lineIndex === 0 ? line : `${INDENT.repeat(2)}${line}`))
        .join("\n")
      blocks.push(`  const __auth${index} = ${expression}`)
      blocks.push(`  await __opencode.integration.transform((editor) => {`)
      blocks.push(`    for (const method of __auth${index}.methods ?? []) {`)
      blocks.push(`      if (method?.type === "api") {`)
      blocks.push(
        `        editor.method.update({ integrationID: __auth${index}.provider, method: { type: "key", label: method.label } } as any)`,
      )
      blocks.push(`        continue`)
      blocks.push(`      }`)
      blocks.push(`      if (method?.type !== "oauth") continue`)
      blocks.push(`      const methodID = method.id ?? method.label ?? "oauth"`)
      blocks.push(`      const toCredential = (value: any) => {`)
      blocks.push(
        `        if (!value || value.type !== "success") throw new Error("opencode-plugin-migrate: OAuth authorize failed")`,
      )
      blocks.push(
        `        if (!value.refresh || !value.access) throw new Error("opencode-plugin-migrate: OAuth result without refresh/access needs manual porting")`,
      )
      blocks.push(`        return {`)
      blocks.push(`          type: "oauth" as const,`)
      blocks.push(`          methodID,`)
      blocks.push(`          refresh: value.refresh,`)
      blocks.push(`          access: value.access,`)
      blocks.push(`          expires: value.expires ?? Date.now() + 3_600_000,`)
      blocks.push(`          metadata: value.metadata,`)
      blocks.push(`        }`)
      blocks.push(`      }`)
      blocks.push(`      editor.method.update({`)
      blocks.push(`        integrationID: __auth${index}.provider,`)
      blocks.push(`        method: { id: methodID, type: "oauth", label: method.label },`)
      blocks.push(`        authorize: async (answer: any) => {`)
      blocks.push(`          const result = await method.authorize?.(answer)`)
      blocks.push(
        `          if (!result) throw new Error("opencode-plugin-migrate: OAuth authorize is missing")`,
      )
      blocks.push(`          if (result.method === "code") {`)
      blocks.push(`            return {`)
      blocks.push(`              url: result.url,`)
      blocks.push(`              instructions: result.instructions,`)
      blocks.push(`              mode: "code" as const,`)
      blocks.push(
        `              callback: async (code: string) => toCredential(await result.callback(code)),`,
      )
      blocks.push(`            }`)
      blocks.push(`          }`)
      blocks.push(`          return {`)
      blocks.push(`            url: result.url,`)
      blocks.push(`            instructions: result.instructions,`)
      blocks.push(`            mode: "auto" as const,`)
      blocks.push(`            callback: Promise.resolve(result.callback()).then(toCredential),`)
      blocks.push(`          }`)
      blocks.push(`        },`)
      blocks.push(`      } as any)`)
      blocks.push(`    }`)
      blocks.push(`  })`)
    })
    diagnostics.push({
      code: "auth/registration",
      severity: "info",
      message: `${ir.auths.length} auth hook(s) registered through ctx.integration.transform; API and OAuth methods are mapped, loader/prompts need review.`,
    })
  }

  if (skippedHooks.length) {
    const notes = skippedHooks.map((hook) => {
      const why = hook.reason ? `\n//   ${hook.reason}` : ""
      const when = hook.condition ? ` (when ${hook.condition})` : ""
      return `//\n// "${hook.name}"${when} -> ${hook.v2} [${hook.classification}]${why}\n//\n${comment(hook.body)}`
    })
    blocks.push(
      reindent(
        [
          "// --- Not converted automatically; original bodies kept for manual porting ---",
          ...notes,
        ].join("\n"),
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
    ...(ir.tools.length ? [`import { z as __z } from "zod"`] : []),
    ...ir.imports.map((item) => item.text),
  ]

  const legacy = options.dual ? ["", ...renderLegacy(ir), ""] : []
  if (options.dual && ir.conditions.length) {
    diagnostics.push({
      code: "dual/conditionals",
      severity: "warning",
      message:
        "conditional hook maps are emitted in the V2 setup, but the reconstructed V1 server() registers only unconditional hooks.",
    })
  }
  if (options.dual) {
    diagnostics.push({
      code: "dual/entrypoint",
      severity: "info",
      message: "emitted both a V2 setup() entrypoint and a V1 server() entrypoint.",
    })
  }
  const defineOpen = options.dual
    ? [`const __v2 = Plugin.define({`]
    : [
        `const ${ir.exportName && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ir.exportName) ? ir.exportName : "plugin"} = Plugin.define({`,
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
    ...(ir.moduleScope.trim() ? [carried(ir.moduleScope, 0, "module"), ``] : []),
    ...defineOpen,
    `  id: ${JSON.stringify(ir.id)},`,
    `  async setup(__opencode) {`,
    ...blocks,
    `  },`,
    `})`,
    ...legacy,
    ...(options.dual ? [`const ${localName} = { ...__v2, server: __v1 }`] : []),
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
    tools: ir.tools.map((tool) => tool.name),
    providers: ir.providers.map((provider) => provider.id.replace(/^["'`]|["'`]$/g, "")),
    auths: ir.auths.map((auth) => auth.provider.replace(/^["'`]|["'`]$/g, "")),
    rewrittenFiles: [],
    remainingV1Imports: [],
  }
}
