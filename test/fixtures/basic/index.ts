import type { Plugin } from "@opencode-ai/plugin"

const GREETING = "hello"

export const BasicPlugin: Plugin = async ({ directory, client }) => {
  const seen = new Set<string>()
  void client

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && String(output.args.command).includes("rm -rf")) {
        throw new Error(`blocked in ${directory}`)
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") seen.add("idle")
    },
    "chat.message": async (_input, output) => {
      output.parts.length = 0
    },
    "permission.ask": async (input, output) => {
      if (input.type === "bash") output.status = "deny"
    },
    dispose: async () => {
      seen.clear()
    },
  }
}
