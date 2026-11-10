import * as v1 from "@opencode-ai/plugin"

export const legacy = v1.tool({
  description: "legacy",
  args: {},
  async execute() {
    return "legacy"
  },
})
