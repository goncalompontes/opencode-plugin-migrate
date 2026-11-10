/**
 * Migrated from OpenCode V1 by opencode-plugin-migrate.
 * Source: benchmarks/corpus/opencode-smartsnip/src/index.ts
 * Review every "not converted automatically" block before shipping.
 */
import { Plugin } from "@opencode/plugin"
import { loadConfig } from "./config"
import { buildMatchTable } from "./filters"
import { rewrite } from "./router"
import { resolveSnip } from "./snip-cli"
import { formatTokens, nowUtcSnipFormat, savingsSince } from "./stats"

// #region carried-v1
interface ShellEvent {
  tool: string
  input: unknown
}
interface PluginContextV2 {
  location: { directory: string }
  tool: { hook: (name: "execute.before", callback: (event: ShellEvent) => void) => Promise<unknown> }
}
function init(directory: string) {
  // POSIX parser — PowerShell/native Windows is a non-goal for now
  if (process.platform === "win32") return null
  const config = loadConfig(directory)
  if (!config.enabled) return null

  if (!resolveSnip(config.snipPath)) {
    console.warn(
      `[smartsnip] '${config.snipPath}' not found in PATH — plugin disabled. ` +
        "Install: brew install edouard-claude/tap/snip, " +
        "or go install github.com/edouard-claude/snip@latest",
    )
    return null
  }
  return { config, table: buildMatchTable(config) }
}
// #endregion carried-v1

const plugin = Plugin.define({
  id: "opencode-smartsnip",
  async setup(__opencode) {
    // TODO(v2): the V1 client API moved onto ctx domains (ctx.session, ctx.tool, ...).
    const client: any = __opencode
    const directory = __opencode.location.directory
    // #region carried-v1
    const state = init(directory)
    if (!state) return;

    const { config, table } = state
    const startedAt = nowUtcSnipFormat()
    const toastedSessions = new Set<string>()
    let wrappedAnything = false
    let reportedSavedTokens = 0
    // #endregion carried-v1
  const __cleanups: Array<() => void | Promise<void>> = []
    await __opencode.tool.hook("execute.before", async (event) => {
      const input: any = { tool: event.tool, sessionID: event.sessionID, callID: event.id }
      const output: any = { args: event.input }
      try {
        // #region carried-v1
        if (input.tool !== "bash") return
        const command = output.args?.command
        if (!command || typeof command !== "string") return
        const rewritten = rewrite(command, table, config)
        if (rewritten !== command) wrappedAnything = true
        output.args.command = rewritten
        // #endregion carried-v1
      } finally {
        event.input = output.args
      }
    })
    const abort1 = new AbortController()
    __cleanups.push(() => abort1.abort())
    void (async () => {
      try {
        for await (const __event of __opencode.event.subscribe({ signal: abort1.signal })) {
          const event: any = __event
          try {
            // #region carried-v1
            if (!config.toast || event.type !== "session.idle") return
            if (!wrappedAnything) return
            const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
            if (!sessionID || toastedSessions.has(sessionID)) return
            const savings = await savingsSince(startedAt)
            if (!savings || savings.savedTokens <= reportedSavedTokens) return
            toastedSessions.add(sessionID)
            reportedSavedTokens = savings.savedTokens
            try {
              await client.tui.showToast({
                body: {
                  title: "smartsnip",
                  message: `snip saved ~${formatTokens(savings.savedTokens)} tokens across ${savings.commands} commands`,
                  variant: "success",
                  duration: 5000,
                },
              })
            } catch {
              // headless / no TUI — stats are a bonus, never a breakage
            }
            // #endregion carried-v1
          } catch (error) {
            console.error("[opencode-smartsnip] event handler failed", error)
          }
        }
      } catch (error) {
        console.error("[opencode-smartsnip] event subscription failed", error)
      }
    })()
  return async () => {
    for (const cleanup of __cleanups) await cleanup()
  }
  },
})

export default plugin
