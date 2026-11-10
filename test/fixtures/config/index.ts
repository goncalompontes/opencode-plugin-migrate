import type { Plugin } from "@opencode-ai/plugin"

export const ConfigPlugin: Plugin = async () => ({
  config: async (input) => {
    input.command = input.command ?? {}
    input.command.hello = {
      template: "Say hello to $ARGUMENTS",
      description: "Greet someone",
    }
  },
})
