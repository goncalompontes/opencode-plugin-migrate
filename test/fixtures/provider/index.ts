import type { Plugin } from "@opencode-ai/plugin"

export const ProviderPlugin: Plugin = async () => ({
  provider: {
    id: "custom",
    models: async (_provider, _ctx) => ({
      "custom-model": {
        id: "custom-model",
        providerID: "custom",
        name: "Custom Model",
        capabilities: {},
      } as any,
    }),
  },
  auth: {
    provider: "custom",
    methods: [],
  },
})
