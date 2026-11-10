import type { Plugin } from "@opencode-ai/plugin"

export const ConditionalPlugin: Plugin = async ({ directory }) => {
  const enabled = directory.length > 0

  if (!enabled) {
    return {
      event: async ({ event }) => {
        if (event.type === "session.idle") console.log("disabled")
      },
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") output.args.command = String(output.args.command)
    },
  }
}
