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
    methods: [
      { type: "api", label: "API key" },
      {
        type: "oauth",
        label: "OAuth",
        authorize: async () => ({
          url: "https://example.com/oauth",
          instructions: "Sign in",
          method: "auto",
          callback: async () => ({
            type: "success",
            refresh: "refresh",
            access: "access",
            expires: Date.now() + 3_600_000,
          }),
        }),
      },
    ] as any,
  },
})
