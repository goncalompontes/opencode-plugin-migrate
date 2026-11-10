import type { Plugin } from "@opencode-ai/plugin"

export const ReviewPlugin: Plugin = async () => ({
  "chat.message": async (_input, output) => {
    output.message.model = { providerID: "openrouter", modelID: "vision" }
  },
})
