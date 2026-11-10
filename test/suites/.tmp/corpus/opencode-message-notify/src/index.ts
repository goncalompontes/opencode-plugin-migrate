/**
 * Migrated from OpenCode V1 by opencode-plugin-migrate.
 * Source: benchmarks/corpus/opencode-message-notify/src/index.ts
 * Review every "not converted automatically" block before shipping.
 */
import { Plugin } from "@opencode/plugin"
import type { UsageStats, PluginEvent } from "./types.js"
import { loadConfig } from "./config.js"
import { sendBarkNotification, formatUsageStats } from "./bark.js"

const plugin = Plugin.define({
  id: "opencode-message-notify",
  async setup(__opencode) {
    const project = __opencode.location.project
    // #region carried-v1
    const config = loadConfig();
    const title = config.title
      ? `${config.title} ${project?.id || ""}`
      : `OpenCode ${project?.id || ""}`;
    let messageContents = "";
    let usage: UsageStats = {
      cost: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const send = async (body: string): Promise<void> => {
      await sendBarkNotification(config, title, body);
    };
    // #endregion carried-v1
  const __cleanups: Array<() => void | Promise<void>> = []
    const abort0 = new AbortController()
    __cleanups.push(() => abort0.abort())
    void (async () => {
      try {
        for await (const __event of __opencode.event.subscribe({ signal: abort0.signal })) {
          const event: any = __event
          try {
            // #region carried-v1
            if (event.type === "message.part.updated" && event.properties?.part) {
              const { part } = event.properties;

              // Capture text content from the agent
              if (part.type === "text" && part.messageID) {
                messageContents = part.text || "";
              }

              // Accumulate usage statistics from step completion
              if (part.type === "step-finish") {
                // Cost
                usage.cost += part.cost ?? 0;

                // Tokens
                if (part.tokens) {
                  usage.input += part.tokens.input ?? 0;
                  usage.output += part.tokens.output ?? 0;
                  usage.reasoning += part.tokens.reasoning ?? 0;

                  if (part.tokens.cache) {
                    usage.cacheRead += part.tokens.cache.read ?? 0;
                    usage.cacheWrite += part.tokens.cache.write ?? 0;
                  }
                }
              }
            }
            if (event.type === "message.part.updated" && config.notifyOnQuestion) {
              const { part } = event.properties || {};
              if (part?.type === "tool" && part.tool === "question" && part.state?.status === "running") {
                const questions = Array.isArray(part.state?.input?.questions)
                  ? part.state.input.questions
                  : [];
                const total = questions.length;
                const firstQuestion = questions[0]?.question;
                let message = "❓ Need your input";
                if (total > 0) {
                  message = `❓ ${total} question${total > 1 ? "s" : ""}`;
                  if (firstQuestion) {
                    message = `${message}: ${firstQuestion}`;
                  }
                }
                await send(message);
              }
            }
            if (event.type === "session.idle" && config.notifyOnComplete) {
              let summary = "";

              if (config.includeUsageStats) {
                const statsFormatted = formatUsageStats(usage, messageContents.trim());
                summary = statsFormatted;
              } else if (config.includeMessageContent && messageContents.trim()) {
                summary = messageContents.trim();
              }

              if (!summary.trim()) {
                summary = "✅ Session completed successfully";
              }

              await send(summary);
            }
            // #endregion carried-v1
          } catch (error) {
            console.error("[opencode-message-notify] event handler failed", error)
          }
        }
      } catch (error) {
        console.error("[opencode-message-notify] event subscription failed", error)
      }
    })()
    await __opencode.permission.hook("evaluate", async (event) => {
      const input: any = { ...event, type: event.action, pattern: event.resources, patterns: event.resources, title: event.action }
      const output: any = { status: event.effect }
      try {
        // #region carried-v1
        if (config.notifyOnPermission) {
          const message = input.type
            ? `🔐 Need Permission: ${input.type}`
            : "🔐 Need Permission";
          await send(message);
        }
        // #endregion carried-v1
      } finally {
        event.effect = output.status
      }
    })
  return async () => {
    for (const cleanup of __cleanups) await cleanup()
  }
  },
})

export default plugin
