import type { Plugin } from "@opencode-ai/plugin"
import { greet } from "./tools"

export const MixedPlugin: Plugin = async ({ directory }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "greet") output.args.name = greet(String(output.args.name), directory)
    },
  }
}
