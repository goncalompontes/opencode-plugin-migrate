/** Locate a plugin's entrypoint and describe the project around it. */
import fs from "node:fs"
import path from "node:path"

export interface PluginProject {
  /** Directory the user pointed us at. */
  readonly dir: string
  readonly entryFile: string
  readonly packageName?: string
  readonly tsconfigPath?: string
  readonly sourceFiles: readonly string[]
}

const ENTRY_CANDIDATES = [
  "src/index.ts",
  "index.ts",
  "plugin.ts",
  "src/plugin.ts",
  "src/server.ts",
  ".opencode/plugins/index.ts",
]

export function readPackage(dir: string): { name?: string; main?: string } {
  const file = path.join(dir, "package.json")
  if (!fs.existsSync(file)) return {}
  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as {
      name?: string
      main?: string
      exports?: Record<string, unknown> | string
    }
    const exported = pkg.exports
    const entry =
      typeof exported === "string"
        ? exported
        : exported && typeof exported === "object" && typeof exported["."] === "string"
          ? (exported["."] as string)
          : undefined
    return { name: pkg.name, main: entry ?? pkg.main }
  } catch {
    return {}
  }
}

function isSource(file: string): boolean {
  return /\.[cm]?tsx?$/.test(file) && !file.endsWith(".d.ts")
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else if (isSource(full)) found.push(full)
  }
  return found
}

/** Files that import the V1 plugin package are the best signal for a plugin entrypoint. */
function findV1Importers(files: readonly string[]): string[] {
  const hits: string[] = []
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8")
    if (text.includes('"@opencode-ai/plugin"') || text.includes("'@opencode-ai/plugin'")) {
      hits.push(file)
    }
  }
  // Prefer files that also default-export or export a Plugin-typed value.
  const scored = hits
    .map((file) => {
      const text = fs.readFileSync(file, "utf8")
      let score = 0
      if (/export\s+default/.test(text)) score += 2
      if (/\bPlugin\b/.test(text)) score += 1
      if (/tool\.execute|chat\.message|tool\.definition/.test(text)) score += 2
      return { file, score, size: text.length }
    })
    .sort((a, b) => b.score - a.score || a.size - b.size)
  return scored.map((item) => item.file)
}

export function resolveProject(dir: string): PluginProject {
  const absolute = path.resolve(dir)
  if (!fs.existsSync(absolute)) throw new Error(`no such directory: ${absolute}`)

  const files = walk(absolute)
  const pkg = readPackage(absolute)
  const tsconfigPath = ["tsconfig.json", "tsconfig.build.json"]
    .map((name) => path.join(absolute, name))
    .find((file) => fs.existsSync(file))

  const candidates: string[] = []
  if (pkg.main) {
    const raw = pkg.main.replace(/^\.\//, "").replace(/\.(js|mjs|cjs)$/, ".ts")
    for (const guess of [raw, path.join("src", path.basename(raw))]) {
      const full = path.join(absolute, guess)
      if (fs.existsSync(full) && isSource(full)) candidates.push(full)
    }
  }
  for (const name of ENTRY_CANDIDATES) {
    const full = path.join(absolute, name)
    if (fs.existsSync(full)) candidates.push(full)
  }
  candidates.push(...findV1Importers(files))

  const entryFile = candidates.find((file) => fs.existsSync(file) && isSource(file))
  if (!entryFile) {
    throw new Error(
      `could not find a plugin entrypoint in ${absolute}. Looked for package.json main/exports, ${ENTRY_CANDIDATES.join(", ")} and files importing @opencode-ai/plugin.`,
    )
  }

  return {
    dir: absolute,
    entryFile,
    packageName: pkg.name,
    tsconfigPath,
    sourceFiles: files,
  }
}

const COPY_IGNORE = new Set(["node_modules", "dist", ".git", "coverage", ".turbo", "test", "tests"])

/** Copy the plugin source tree so relative imports keep working in the output project. */
export function copyProject(project: PluginProject, target: string): void {
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(project.dir, target, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source)
      if (COPY_IGNORE.has(name)) return false
      if (name.endsWith(".lock") || name === "bun.lock" || name === "package-lock.json") return false
      return true
    },
  })
}
