/** Config, layout, and dual-mode scaffolding around a converted plugin package. */
import fs from "node:fs"
import path from "node:path"
import ts from "typescript"
import type { Diagnostic } from "../core/diagnostics"

const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"]

interface RawConfig {
  plugin?: unknown
  [key: string]: unknown
}

function configFiles(root: string): string[] {
  const found: string[] = []
  for (const name of CONFIG_NAMES) {
    for (const dir of [root, path.join(root, ".opencode")]) {
      const file = path.join(dir, name)
      if (fs.existsSync(file)) found.push(file)
    }
  }
  return found
}

function normalizeEntry(entry: unknown): unknown {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") {
    const [, options] = entry
    return options === undefined
      ? { package: entry[0] }
      : { package: entry[0], options }
  }
  return entry
}

/**
 * V2 config uses `plugins` with `{ package, options }` objects. V1 `plugin` tuples are
 * normalized in memory by OpenCode, but native V2 config is the documented target.
 */
export function upgradeConfigFiles(root: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const file of configFiles(root)) {
    const text = fs.readFileSync(file, "utf8")
    const parsed = ts.parseConfigFileTextToJson(file, text)
    if (parsed.error) {
      diagnostics.push({
        code: "config/parse",
        severity: "warning",
        message: `could not parse ${path.relative(root, file)}; left unchanged.`,
      })
      continue
    }
    const config = parsed.config as RawConfig
    if (!config || typeof config !== "object") continue
    const hadPlugin = config.plugin !== undefined
    if (!hadPlugin) continue

    const entries = Array.isArray(config.plugin) ? config.plugin : [config.plugin]
    const plugins = entries.map(normalizeEntry)
    delete config.plugin
    config.plugins = plugins
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
    diagnostics.push({
      code: "config/plugins",
      severity: "info",
      message: `${path.relative(root, file)}: converted \`plugin\` to \`plugins\` (${plugins.length} entr${plugins.length === 1 ? "y" : "ies"}).`,
    })
  }
  return diagnostics
}

/** Report layout and TUI changes instead of moving files that may break relative imports. */
export function detectLayout(root: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const singular = path.join(root, ".opencode", "plugin")
  if (fs.existsSync(singular) && fs.statSync(singular).isDirectory()) {
    for (const entry of fs.readdirSync(singular, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.[cm]?tsx?$/.test(entry.name)) continue
      diagnostics.push({
        code: "layout/plugin-directory",
        severity: "warning",
        message: `move .opencode/plugin/${entry.name} to .opencode/plugins/${entry.name.replace(/\.[cm]?tsx?$/, "")}/index.ts; configured local paths must name directories in V2.`,
      })
    }
  }

  const plural = path.join(root, ".opencode", "plugins")
  if (fs.existsSync(plural)) {
    for (const entry of fs.readdirSync(plural, { withFileTypes: true })) {
      if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) {
        diagnostics.push({
          code: "layout/plugin-file",
          severity: "warning",
          message: `move .opencode/plugins/${entry.name} to .opencode/plugins/${entry.name.replace(/\.[cm]?tsx?$/, "")}/index.ts; V2 skips configured file paths.`,
        })
      }
    }
  }

  for (const file of walk(root)) {
    const text = fs.readFileSync(file, "utf8")
    if (/@opencode-ai\/plugin\/tui/.test(text) || /export\s+(?:const|default)\s+tui\b/.test(text)) {
      diagnostics.push({
        code: "tui/detected",
        severity: "warning",
        message: `${path.relative(root, file)} looks like a V1 TUI plugin; port it to @opencode/plugin/tui separately instead of mixing it into the server plugin.`,
      })
    }
  }
  return diagnostics
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".git")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full)
  }
  return found
}
