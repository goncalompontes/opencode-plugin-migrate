/**
 * Migrated from OpenCode V1 by opencode-plugin-migrate.
 * Source: test/fixtures/basic/index.ts
 * Review every "not converted automatically" block before shipping.
 */
import { Plugin } from "@opencode/plugin"

// #region carried-v1
const GREETING = "hello"
// #endregion carried-v1

const BasicPlugin = Plugin.define({
  id: "basic-v1-plugin",
  async setup(__opencode) {
    const directory = __opencode.location.directory
    // TODO(v2): the V1 client API moved onto ctx domains (ctx.session, ctx.tool, ...).
    const client: any = __opencode
    // #region carried-v1
    const seen = new Set<string>()
    void client
    // #endregion carried-v1
  const __cleanups: Array<() => void | Promise<void>> = []
    await __opencode.tool.hook("execute.before", async (event) => {
      const input: any = { tool: event.tool, sessionID: event.sessionID, callID: event.id }
      const output: any = { args: event.input }
      try {
        // #region carried-v1
        if (input.tool === "bash" && String(output.args.command).includes("rm -rf")) {
          throw new Error(`blocked in ${directory}`)
        }
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
            if (event.type === "session.idle") seen.add("idle")
            // #endregion carried-v1
          } catch (error) {
            console.error("[basic-v1-plugin] event handler failed", error)
          }
        }
      } catch (error) {
        console.error("[basic-v1-plugin] event subscription failed", error)
      }
    })()
    await __opencode.permission.hook("evaluate", async (event) => {
      const input: any = { ...event, type: event.action, pattern: event.resources, patterns: event.resources, title: event.action }
      const output: any = { status: event.effect }
      try {
        // #region carried-v1
        if (input.type === "bash") output.status = "deny"
        // #endregion carried-v1
      } finally {
        event.effect = output.status
      }
    })
    __cleanups.push(async () => {
      // #region carried-v1
      seen.clear()
      // #endregion carried-v1
    })
    // --- Not converted automatically; original bodies kept for manual porting ---
    //
    // "chat.message" -> ctx.session.hook('prompt') [review]
    //   The V2 prompt hook runs before durable prompt admission and exposes a different event shape.
    //
    // output.parts.length = 0
  return async () => {
    for (const cleanup of __cleanups) await cleanup()
  }
  },
})

export default BasicPlugin
