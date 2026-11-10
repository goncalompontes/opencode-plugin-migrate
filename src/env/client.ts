/**
 * V1 server-client compatibility.
 *
 * V1 plugins call `client.<domain>.<method>({ path, body })` and read `{ data }`.
 * V2 exposes domain methods directly on the plugin context with flat inputs and no
 * envelope. A generated facade keeps the V1 call shape working while routing to the
 * V2 domain, and reports methods that have no V2 destination.
 */
import type { Diagnostic } from "../core/diagnostics"

export type ClientStatus = "mapped" | "adapted" | "unmapped"

export interface ClientCall {
  method: string
  status: ClientStatus
  note: string
}

const MAPPED: Record<string, { status: ClientStatus; note: string }> = {
  "session.get": { status: "mapped", note: "session.get({ sessionID }) with a { data } envelope" },
  "session.list": {
    status: "mapped",
    note: "session.list(input.query ?? input) with a { data } envelope",
  },
  "session.messages": {
    status: "mapped",
    note: "session.context({ sessionID }) with a { data } envelope",
  },
  "session.abort": {
    status: "mapped",
    note: "session.interrupt({ sessionID }) with a { data } envelope",
  },
  "session.summarize": {
    status: "mapped",
    note: "session.compact({ sessionID }) with a { data } envelope",
  },
  "app.log": { status: "mapped", note: "console.log(body.message)" },
  "tool.ids": {
    status: "mapped",
    note: "tool.list().map(tool => tool.id) with a { data } envelope",
  },
  "tui.showToast": {
    status: "adapted",
    note: "V2 server plugins have no TUI; the toast is logged instead of shown",
  },
  "session.prompt": {
    status: "unmapped",
    note: "V2 session.prompt takes flat text/files, not message parts",
  },
  "session.promptAsync": { status: "unmapped", note: "no async prompt variant in V2" },
  "session.command": {
    status: "unmapped",
    note: "V2 session.command takes flat text, not message parts",
  },
  "session.status": {
    status: "unmapped",
    note: "derive status from session.get() or the event stream",
  },
  "config.get": {
    status: "unmapped",
    note: "V2 has no global config domain; read the owning domain",
  },
}

const CALL = /\bclient\.([A-Za-z]+)\.([A-Za-z]+)\s*\(/g

export function scanClientCalls(bodies: readonly string[]): ClientCall[] {
  const seen = new Map<string, ClientCall>()
  for (const body of bodies) {
    for (const match of body.matchAll(CALL)) {
      const method = `${match[1]}.${match[2]}`
      if (seen.has(method)) continue
      const known = MAPPED[method]
      seen.set(method, {
        method,
        status: known?.status ?? "unmapped",
        note: known?.note ?? "no V2 destination is known for this call",
      })
    }
  }
  return [...seen.values()].sort((a, b) => a.method.localeCompare(b.method))
}

/** Lines for the generated facade, relative to the start of `setup`. */
export function renderClientFacade(binding = "client"): string[] {
  return [
    "// #region v1-client-facade",
    "// V1 call shape: { path, body } in, { data } out. Unmapped methods throw loudly.",
    "const __clientSessionID = (input: any): any =>",
    "  input?.path?.id ?? input?.sessionID ?? input?.id",
    "const __clientEnvelope = async (value: any): Promise<{ data: any }> => ({ data: value })",
    `const ${binding}: any = {`,
    "  ...__opencode,",
    "  session: {",
    "    ...__opencode.session,",
    "    get: async (input: any) =>",
    "      __clientEnvelope(await __opencode.session.get({ sessionID: __clientSessionID(input) })),",
    "    list: async (input: any = {}) =>",
    "      __clientEnvelope(await __opencode.session.list(input?.query ?? input)),",
    "    messages: async (input: any) =>",
    "      __clientEnvelope(await __opencode.session.context({ sessionID: __clientSessionID(input) })),",
    "    abort: async (input: any) =>",
    "      __clientEnvelope(await __opencode.session.interrupt({ sessionID: __clientSessionID(input) })),",
    "    summarize: async (input: any) =>",
    "      __clientEnvelope(await __opencode.session.compact({ sessionID: __clientSessionID(input) })),",
    "    prompt: async () => {",
    '      throw new Error("opencode-plugin-migrate: session.prompt needs manual porting to flat text/files")',
    "    },",
    "    promptAsync: async () => {",
    '      throw new Error("opencode-plugin-migrate: session.promptAsync has no V2 equivalent")',
    "    },",
    "    command: async () => {",
    '      throw new Error("opencode-plugin-migrate: session.command needs manual porting to flat text")',
    "    },",
    "    status: async () => {",
    '      throw new Error("opencode-plugin-migrate: session.status needs manual porting")',
    "    },",
    "  },",
    "  app: {",
    "    ...__opencode.app,",
    "    log: (input: any) => {",
    "      console.log(input?.body?.message ?? input)",
    "      return Promise.resolve({ data: true })",
    "    },",
    "  },",
    "  tool: {",
    "    ...__opencode.tool,",
    "    ids: async () =>",
    "      __clientEnvelope((await __opencode.tool.list()).map((tool: any) => tool.id)),",
    "  },",
    "  tui: {",
    "    showToast: async (input: any) => {",
    '      console.warn("[opencode-plugin-migrate] V2 server plugins cannot show TUI toasts:", input?.body?.message ?? input)',
    "      return { data: undefined }",
    "    },",
    "  },",
    "}",
    "// #endregion v1-client-facade",
  ]
}

export function clientDiagnostics(calls: readonly ClientCall[]): Diagnostic[] {
  if (calls.length === 0) return []
  const _mapped = calls.filter((call) => call.status === "mapped")
  const adapted = calls.filter((call) => call.status === "adapted")
  const unmapped = calls.filter((call) => call.status === "unmapped")
  const diagnostics: Diagnostic[] = [
    {
      code: "client/facade",
      severity: "info",
      message: `generated a V1 client facade for ${calls.length} call site(s): ${calls.map((call) => `${call.method} (${call.status})`).join(", ")}.`,
    },
  ]
  for (const call of adapted) {
    diagnostics.push({
      code: "client/adapted",
      severity: "warning",
      message: `client.${call.method}: ${call.note}.`,
    })
  }
  if (unmapped.length) {
    diagnostics.push({
      code: "client/unmapped",
      severity: "warning",
      message: `unmapped client calls need manual porting: ${unmapped.map((call) => `${call.method} (${call.note})`).join("; ")}.`,
    })
  }
  return diagnostics
}
