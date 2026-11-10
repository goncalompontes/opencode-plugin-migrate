import type { Plugin } from "@opencode-ai/plugin"

export const UnsupportedPlugin: Plugin = async () => ({
  "command.execute.before": async (input, output) => {
    output.parts.length = 0
    void input
  },
  "experimental.text.complete": async (input, output) => {
    output.text = String(input.partID)
  },
})
