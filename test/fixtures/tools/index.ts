import { type Plugin, tool } from "@opencode-ai/plugin"
import { referencedTool } from "./tools"

export const ToolsPlugin: Plugin = async () => ({
  tool: {
    inline: tool({
      description: "Inline tool",
      args: {
        query: tool.schema.string().describe("Query text"),
      },
      async execute(args) {
        return `inline:${args.query}`
      },
    }),
    referenced: referencedTool,
  },
})
