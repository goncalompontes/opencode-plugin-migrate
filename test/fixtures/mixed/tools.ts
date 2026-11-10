import { type ToolContext, tool } from "@opencode-ai/plugin"

export function greet(name: string, _directory: string): string {
  return `hello ${name}`
}

export const greetTool = tool({
  description: "Greet someone",
  args: {
    name: tool.schema.string().describe("Who to greet"),
  },
  async execute(args, _ctx: ToolContext) {
    return `hello ${args.name}`
  },
})
