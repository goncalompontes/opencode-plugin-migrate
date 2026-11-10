import type { Plugin } from "@opencode-ai/plugin"

export const NamespacePlugin: Plugin = async () => ({
  event: async ({ event }) => {
    if (event.type === "session.idle") console.log("idle")
  },
})
