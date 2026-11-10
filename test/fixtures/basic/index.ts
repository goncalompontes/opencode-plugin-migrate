import type { Plugin } from "@opencode-ai/plugin"

const _GREETING = "hello"

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
    "chat.params": async (_input, output) => {
      output.temperature = 0.2
    },
    "chat.headers": async (_input, output) => {
      output.headers["x-test"] = "1"
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push("Focus on correctness.")
    },
    "permission.ask": async (input, output) => {
      if (input.type === "bash") output.status = "deny"
    },
    dispose: async () => {
      seen.clear()
    },
  }
}
