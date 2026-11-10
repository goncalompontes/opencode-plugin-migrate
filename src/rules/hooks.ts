/**
 * The V1 -> V2 hook map. Typed as an exhaustive Record over `keyof Hooks`, so adding
 * a hook to the V1 package makes this file fail to compile until it is classified.
 */
import type { Hooks } from "@opencode-ai/plugin"
import type { AdapterKind, Classification, ClassifiedPluginIR, PluginIR } from "../ir/schema"

export interface HookRule {
  readonly classification: Classification
  readonly v2: string
  readonly adapter: AdapterKind
  readonly reason?: string
}

export const HOOK_RULES: Record<keyof Hooks, HookRule> = {
  dispose: {
    classification: "converted",
    v2: "cleanup returned from setup()",
    adapter: "dispose",
  },
  event: {
    classification: "converted",
    v2: "ctx.event.subscribe()",
    adapter: "event-subscribe",
  },
  config: {
    classification: "review",
    v2: "domain transforms (ctx.agent/provider/model/command/mcp/... transform)",
    adapter: "none",
    reason: "V2 has no single mutable global config object; each change moves to the domain that owns it.",
  },
  tool: {
    classification: "review",
    v2: "ctx.tool.transform() with JSON Schema",
    adapter: "none",
    reason: "V1 tools use the Zod tool() helper; V2 tools take JSON Schema and return structured content.",
  },
  auth: {
    classification: "review",
    v2: "ctx.integration.transform() and integration APIs",
    adapter: "none",
  },
  provider: {
    classification: "review",
    v2: "ctx.provider.transform() / ctx.model.transform()",
    adapter: "none",
  },
  "chat.message": {
    classification: "converted",
    v2: "ctx.session.hook('prompt')",
    adapter: "session-prompt",
    reason:
      "V1 message parts are bridged into the V2 prompt text; non-text parts are reported, not silently kept.",
  },
  "chat.params": {
    classification: "converted",
    v2: "ctx.session.hook('context') and event.options",
    adapter: "session-context",
    reason:
      "generation options map onto event.options; V1 provider/message inputs have no direct V2 field.",
  },
  "chat.headers": {
    classification: "converted",
    v2: "ctx.session.hook('model.request')",
    adapter: "model-request",
    reason: "V1 request headers map onto the model.request event headers.",
  },
  "permission.ask": {
    classification: "converted",
    v2: "ctx.permission.hook('evaluate')",
    adapter: "permission-evaluate",
    reason:
      "the status maps to event.effect; V1 Permission fields are mapped as type->action and pattern(s)->resources.",
  },
  "command.execute.before": {
    classification: "unsupported",
    v2: "ctx.command.transform() when the plugin owns the command, otherwise the prompt hook",
    adapter: "none",
    reason: "There is no one-to-one global pre-command hook in V2; the correct destination depends on intent.",
  },
  "tool.execute.before": {
    classification: "converted",
    v2: "ctx.tool.hook('execute.before')",
    adapter: "tool-execute-before",
  },
  "shell.env": {
    classification: "converted",
    v2: "ctx.shell.hook('create.before')",
    adapter: "shell-env",
  },
  "tool.execute.after": {
    classification: "converted",
    v2: "ctx.tool.hook('execute.after')",
    adapter: "tool-execute-after",
  },
  "experimental.chat.messages.transform": {
    classification: "review",
    v2: "ctx.session.hook('context') and edit event.messages",
    adapter: "none",
    reason: "Message parts are V2 schema values, so the body needs a typed port.",
  },
  "experimental.chat.system.transform": {
    classification: "converted",
    v2: "ctx.session.hook('context') and edit event.system",
    adapter: "system-transform",
    reason:
      "V1 string entries map to V2 SystemPart values; cache and metadata on existing parts are preserved by position.",
  },
  "experimental.provider.small_model": {
    classification: "unsupported",
    v2: "ctx.provider.transform() / ctx.model.transform()",
    adapter: "none",
    reason: "V2 has no small-model hook; model selection is a transform on the model domain.",
  },
  "experimental.session.compacting": {
    classification: "review",
    v2: "ctx.session.hook('compaction')",
    adapter: "none",
  },
  "experimental.compaction.autocontinue": {
    classification: "unsupported",
    v2: "none",
    adapter: "none",
    reason: "V2 has no corresponding auto-continue lifecycle hook.",
  },
  "experimental.text.complete": {
    classification: "unsupported",
    v2: "none",
    adapter: "none",
    reason: "V2 exposes completion through the session event stream, not a text mutation hook.",
  },
  "tool.definition": {
    classification: "converted",
    v2: "ctx.tool.transform() and editor.update()",
    adapter: "tool-transform",
  },
}

const FALLBACK: HookRule = {
  classification: "unsupported",
  v2: "unknown",
  adapter: "none",
  reason: "hook name is not part of the known V1 API; left untouched and reported.",
}

export function ruleFor(name: string): HookRule {
  return (HOOK_RULES as Record<string, HookRule>)[name] ?? FALLBACK
}

export function classify(ir: PluginIR): ClassifiedPluginIR {
  return {
    ...ir,
    hooks: ir.hooks.map((hook) => {
      const rule = ruleFor(hook.name)
      // `event: async ({ event }) => ...` maps cleanly onto ctx.event.subscribe().
      const eventShorthand =
        hook.name === "event" &&
        hook.usesPatternParams &&
        hook.params.length === 1 &&
        hook.params[0] === "event"
      // Other pattern parameters destructure input/output, which every shim misreads.
      if (hook.usesPatternParams && !eventShorthand && rule.classification === "converted") {
        return {
          ...hook,
          classification: "review" as const,
          adapter: "none" as const,
          v2: rule.v2,
          reason: "callback destructures its parameters; the shim needs a hand-written adapter.",
        }
      }
      return { ...hook, classification: rule.classification, adapter: rule.adapter, v2: rule.v2, ...(rule.reason ? { reason: rule.reason } : {}) }
    }),
  }
}
