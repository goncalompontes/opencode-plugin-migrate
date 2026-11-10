/**
 * Migrated from OpenCode V1 by opencode-plugin-migrate.
 * Source: benchmarks/corpus/opencode-pty/src/plugin.ts
 * Review every "not converted automatically" block before shipping.
 */
import { Plugin } from "@opencode/plugin"
import type { PluginContext, PluginResult } from './plugin/types.ts'
import { createV1Adapter, installHostAdapter } from './adapters/index.ts'
import { ptySpawn } from './plugin/pty/tools/spawn.ts'
import { ptyWrite } from './plugin/pty/tools/write.ts'
import { ptyRead } from './plugin/pty/tools/read.ts'
import { ptyList } from './plugin/pty/tools/list.ts'
import { ptyKill } from './plugin/pty/tools/kill.ts'
import { PTYServer } from './web/server/server.ts'
import open from 'open'

// #region carried-v1
const ptyOpenClientCommand = 'pty-open-background-spy'
const ptyShowServerUrlCommand = 'pty-show-server-url'
// #endregion carried-v1

const PTYPlugin = Plugin.define({
  id: "opencode-pty",
  async setup(__opencode) {
    // TODO(v2): the V1 PluginInput is reconstructed from ctx; port client calls to ctx domains.
    const context: any = { ...__opencode, client: __opencode, directory: __opencode.location.directory, project: __opencode.location.project, worktree: __opencode.location.directory }
    // #region carried-v1
    const { client } = context
    const adapter = createV1Adapter(context)
    installHostAdapter(adapter)
    let ptyServer: PTYServer | undefined
    // #endregion carried-v1
  const __cleanups: Array<() => void | Promise<void>> = []
    const abort0 = new AbortController()
    __cleanups.push(() => abort0.abort())
    void (async () => {
      try {
        for await (const __event of __opencode.event.subscribe({ signal: abort0.signal })) {
          const event: any = __event
          try {
            // #region carried-v1
            if (event.type === 'session.deleted') {
              adapter.onSessionDeleted?.(event.properties.info.id)
            }
            // #endregion carried-v1
          } catch (error) {
            console.error("[opencode-pty] event handler failed", error)
          }
        }
      } catch (error) {
        console.error("[opencode-pty] event subscription failed", error)
      }
    })()
    // --- Not converted automatically; original bodies kept for manual porting ---
    //
    // "command.execute.before" -> ctx.command.transform() when the plugin owns the command, otherwise the prompt hook [unsupported]
    //   There is no one-to-one global pre-command hook in V2; the correct destination depends on intent.
    //
    // if (input.command !== ptyOpenClientCommand && input.command !== ptyShowServerUrlCommand) {
    //   return
    // }
    // if (ptyServer === undefined) {
    //   ptyServer = await PTYServer.createServer({
    //     directory: context.directory,
    //     worktree: context.worktree,
    //   })
    // }
    // if (input.command === ptyOpenClientCommand) {
    //   open(ptyServer.server.url.origin)
    // } else if (input.command === ptyShowServerUrlCommand) {
    //   const message = `PTY Sessions Web Interface URL: ${ptyServer.server.url.origin}`
    //   await client.session.prompt({
    //     path: { id: input.sessionID },
    //     body: {
    //       noReply: true,
    //       parts: [
    //         {
    //           type: 'text',
    //           text: message,
    //         },
    //       ],
    //     },
    //   })
    // }
    // throw new Error('Command handled by PTY plugin')
    //
    // "config" -> domain transforms (ctx.agent/provider/model/command/mcp/... transform) [review]
    //   V2 has no single mutable global config object; each change moves to the domain that owns it.
    //
    // if (!input.command) {
    //   input.command = {}
    // }
    // input.command[ptyOpenClientCommand] = {
    //   template: `This command will start the PTY Sessions Web Interface in your default browser.`,
    //   description: 'Open PTY Sessions Web Interface',
    // }
    // input.command[ptyShowServerUrlCommand] = {
    //   template: `This command will show the PTY Sessions Web Interface URL.`,
    //   description: 'Show PTY Sessions Web Interface URL',
    // }
  return async () => {
    for (const cleanup of __cleanups) await cleanup()
  }
  },
})

export default PTYPlugin
