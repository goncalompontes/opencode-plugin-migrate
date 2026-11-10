/**
 * Capability probe for the installed @opencode/plugin.
 *
 * Rule tables are only meaningful if the target package still exposes the shapes the
 * adapters emit. Probe the real declaration files before converting; if a capability
 * disappears, downgrade that rule to review instead of emitting code that cannot load.
 */
import fs from "node:fs"
import path from "node:path"
import type { AdapterKind, ClassifiedHook, ClassifiedPluginIR } from "../ir/schema"

export const CAPABILITIES = {
  "plugin.define": {
    file: "dist/promise/plugin.d.ts",
    pattern: /function define/,
    note: "Plugin.define({ id, setup })",
  },
  "session.hook.prompt": {
    file: "dist/promise/session.d.ts",
    pattern: /readonly prompt: SessionPrompt/,
    note: 'session.hook("prompt")',
  },
  "session.hook.context": {
    file: "dist/promise/session.d.ts",
    pattern: /readonly context: SessionContext/,
    note: 'session.hook("context")',
  },
  "session.hook.modelRequest": {
    file: "dist/promise/session.d.ts",
    pattern: /readonly "model\.request": SessionModelRequest/,
    note: 'session.hook("model.request")',
  },
  "tool.hook": {
    file: "dist/promise/tool.d.ts",
    pattern: /readonly hook: Hooks<ToolHooks>/,
    note: "tool.hook(execute.before/after)",
  },
  "tool.transform": {
    file: "dist/promise/tool.d.ts",
    pattern: /readonly transform: Transform<ToolEditor>/,
    note: "tool.transform()",
  },
  "command.transform": {
    file: "dist/promise/command.d.ts",
    pattern: /readonly transform: Transform<CommandEditor>/,
    note: "command.transform()",
  },
  "event.subscribe": {
    file: "dist/promise/event.d.ts",
    pattern: /readonly subscribe/,
    note: "event.subscribe()",
  },
  "permission.hook": {
    file: "dist/promise/permission.d.ts",
    pattern: /readonly hook: Hooks<PermissionHooks>/,
    note: 'permission.hook("evaluate")',
  },
  "shell.hook": {
    file: "dist/promise/shell.d.ts",
    pattern: /readonly hook: Hooks<ShellHooks>/,
    note: 'shell.hook("create.before")',
  },
} as const

export type Capability = keyof typeof CAPABILITIES

export interface TargetInfo {
  version: string
  packageRoot: string
  capabilities: Capability[]
  missing: Capability[]
  overrideMismatch?: string
}

const cache = new Map<string, TargetInfo>()

export function findTargetPackage(root: string): string | undefined {
  const candidates = [
    path.join(root, "node_modules", "@opencode", "plugin"),
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "node_modules",
      "@opencode",
      "plugin",
    ),
  ]
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json")))
}

export function probeTarget(root: string, override?: string): TargetInfo {
  const packageRoot = findTargetPackage(root)
  if (!packageRoot) {
    return {
      version: "unknown",
      packageRoot: "",
      capabilities: [],
      missing: Object.keys(CAPABILITIES) as Capability[],
    }
  }
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))
    .version as string
  const key = `${packageRoot}@${version}`
  const cached = cache.get(key)
  const info =
    cached ??
    (() => {
      const capabilities: Capability[] = []
      const missing: Capability[] = []
      for (const [name, check] of Object.entries(CAPABILITIES) as Array<
        [Capability, (typeof CAPABILITIES)[Capability]]
      >) {
        const file = path.join(packageRoot, check.file)
        const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
        ;(check.pattern.test(text) ? capabilities : missing).push(name)
      }
      const result: TargetInfo = {
        version,
        packageRoot,
        capabilities,
        missing,
        ...(override && override !== version
          ? {
              overrideMismatch: `requested ${override}, but the installed @opencode/plugin is ${version}`,
            }
          : {}),
      }
      cache.set(key, result)
      return result
    })()
  if (override && override !== info.version) {
    return {
      ...info,
      overrideMismatch: `requested ${override}, but the installed @opencode/plugin is ${info.version}`,
    }
  }
  return info
}

const ADAPTER_CAPABILITY: Partial<Record<AdapterKind, Capability>> = {
  "tool-execute-before": "tool.hook",
  "tool-execute-after": "tool.hook",
  "event-subscribe": "event.subscribe",
  "tool-transform": "tool.transform",
  "shell-env": "shell.hook",
  "permission-evaluate": "permission.hook",
  "config-command": "command.transform",
  "session-prompt": "session.hook.prompt",
  "session-context": "session.hook.context",
  "model-request": "session.hook.modelRequest",
  "system-transform": "session.hook.context",
  dispose: "plugin.define",
}

/** Downgrade rules whose adapter needs a capability the installed target does not expose. */
export function applyTarget(ir: ClassifiedPluginIR, target: TargetInfo): ClassifiedPluginIR {
  const hooks: ClassifiedHook[] = ir.hooks.map((hook) => {
    const capability = ADAPTER_CAPABILITY[hook.adapter]
    if (!capability || target.capabilities.includes(capability)) return hook
    return {
      ...hook,
      classification: "review",
      adapter: "none",
      reason: `target @opencode/plugin@${target.version} does not expose ${CAPABILITIES[capability].note}.`,
    }
  })
  return { ...ir, hooks, target }
}
