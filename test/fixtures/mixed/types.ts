import type { Plugin, PluginInput } from "@opencode-ai/plugin"

export type MixedInput = PluginInput
export type MixedHooks = Awaited<ReturnType<Plugin>>
