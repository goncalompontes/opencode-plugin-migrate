import type { Plugin } from "@opencode-ai/plugin"

export const ClientPlugin: Plugin = async ({ client }) => ({
  "tool.execute.before": async (input) => {
    const session = await client.session.get({ path: { id: input.sessionID } })
    if (!session.data) return
  },
  event: async ({ event }) => {
    if (event.type === "session.idle") {
      await client.tui.showToast({ body: { message: "idle", variant: "info" } })
    }
  },
})
