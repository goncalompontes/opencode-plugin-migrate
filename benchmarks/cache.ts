/** Conversion cache for the benchmark, keyed by source commit + converter fingerprint. */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".turbo"])

function walk(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) found.push(full)
  }
  return found.sort()
}

export function hashDirectory(dir: string): string {
  const hash = crypto.createHash("sha256")
  for (const file of walk(dir)) {
    hash.update(path.relative(dir, file))
    hash.update(fs.readFileSync(file))
  }
  return hash.digest("hex").slice(0, 16)
}

export function hashFiles(files: readonly string[]): string {
  const hash = crypto.createHash("sha256")
  for (const file of files) {
    hash.update(path.basename(file))
    hash.update(fs.readFileSync(file))
  }
  return hash.digest("hex").slice(0, 16)
}

export function converterFingerprint(repoRoot: string, targetVersion: string): string {
  const sources = walk(path.join(repoRoot, "src"))
  const extras = ["package.json", "bun.lock"]
    .map((name) => path.join(repoRoot, name))
    .filter((file) => fs.existsSync(file))
  const hash = crypto.createHash("sha256")
  for (const file of [...extras, ...sources]) {
    hash.update(path.relative(repoRoot, file))
    hash.update(fs.readFileSync(file))
  }
  hash.update(targetVersion)
  return hash.digest("hex").slice(0, 16)
}

export class BenchCache {
  readonly #dir: string
  readonly #fingerprint: string
  hits = 0
  misses = 0

  constructor(dir: string, fingerprint: string) {
    this.#dir = dir
    this.#fingerprint = fingerprint
    fs.mkdirSync(dir, { recursive: true })
  }

  #file(identity: string): string {
    const safe = identity.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120)
    return path.join(this.#dir, `${safe}.json`)
  }

  key(identity: string): string {
    return `${identity}@${this.#fingerprint}`
  }

  get(identity: string): { ok: boolean } | undefined {
    const file = this.#file(identity)
    if (!fs.existsSync(file)) {
      this.misses += 1
      return undefined
    }
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
        key: string
        result: { ok: boolean }
      }
      if (value.key !== this.key(identity)) {
        this.misses += 1
        return undefined
      }
      this.hits += 1
      return value.result
    } catch {
      this.misses += 1
      return undefined
    }
  }

  set(identity: string, result: unknown): void {
    fs.writeFileSync(this.#file(identity), JSON.stringify({ key: this.key(identity), result }))
  }
}
