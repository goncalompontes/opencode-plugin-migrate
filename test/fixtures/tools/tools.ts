import { tool } from "@opencode-ai/plugin"

export const referencedTool = tool({
  description: "Referenced tool",
  args: {
    count: tool.schema.number().optional(),
  },
  async execute(args) {
    return { title: "count", output: String(args.count ?? 0), metadata: { count: args.count } }
  },
})
