#!/usr/bin/env bun
/**
 * Discover real OpenCode V1 plugins on GitHub, pin their commits, and write
 * benchmarks/community.json. Clones live in benchmarks/corpus (gitignored).
 *
 * Usage: bun scripts/discover-corpus.ts [--limit 150] [--pages 3]
 */
import fs from "node:fs"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "..")
const corpus = path.join(repo, "benchmarks", "corpus")
const outFile = path.join(repo, "benchmarks", "community.json")

const args = process.argv.slice(2)
const readArg = (name: string, fallback: number): number => {
  const index = args.indexOf(name)
  return index >= 0 ? Number(args[index + 1]) : fallback
}
const limit = readArg("--limit", 150)
const pages = readArg("--pages", 3)

function gh(api: string): unknown {
  const result = Bun.spawnSync(["gh", "api", api], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${api} failed: ${result.stderr.toString()}`)
  }
  return JSON.parse(result.stdout.toString())
}

interface Candidate {
  full_name: string
  stars: number
  size: number
  license: string
  archived: boolean
  fork: boolean
  pushed_at: string
  description: string
}

const queries = [
  'filename:package.json "@opencode-ai/plugin"',
  '"@opencode-ai/plugin" language:TypeScript',
]

const names = new Set<string>()
for (const query of queries) {
  for (let page = 1; page <= pages; page += 1) {
    const api = `search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`
    try {
      const result = gh(api) as { items?: Array<{ repository: { full_name: string } }> }
      for (const item of result.items ?? []) names.add(item.repository.full_name)
    } catch (error) {
      console.warn(String(error))
      break
    }
  }
}

console.log(`candidates from code search: ${names.size}`)

const candidates: Candidate[] = []
for (const full of [...names].sort()) {
  try {
    const info = gh(`repos/${full}`) as {
      stargazers_count: number
      size: number
      archived: boolean
      fork: boolean
      pushed_at: string
      description: string | null
      license: { spdx_id: string | null } | null
    }
    // Large repos are usually apps that happen to import a plugin; keep packages.
    if (info.archived || info.fork || info.size > 20_000) continue
    candidates.push({
      full_name: full,
      stars: info.stargazers_count,
      size: info.size,
      license: info.license?.spdx_id ?? "NOASSERTION",
      archived: info.archived,
      fork: info.fork,
      pushed_at: info.pushed_at,
      description: info.description ?? "",
    })
  } catch {
    // repository disappeared or is inaccessible
  }
}

candidates.sort((a, b) => b.stars - a.stars)
console.log(`repositories with metadata: ${candidates.length}; selecting up to ${limit}`)

fs.mkdirSync(corpus, { recursive: true })

const selected: Array<{
  name: string
  repo: string
  commit: string
  stars: number
  license: string
  note: string
}> = []

for (const candidate of candidates) {
  if (selected.length >= limit) break
  const [owner, name] = candidate.full_name.split("/") as [string, string]
  const checkout = path.join(corpus, `${owner}__${name}`)
  if (!fs.existsSync(path.join(checkout, ".git"))) {
    const clone = Bun.spawnSync(
      ["git", "clone", "--depth", "1", `https://github.com/${candidate.full_name}.git`, checkout],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (clone.exitCode !== 0) {
      fs.rmSync(checkout, { recursive: true, force: true })
      continue
    }
  }

  const hasV1 = Bun.spawnSync(
    [
      "sh",
      "-c",
      "grep -rl '@opencode-ai/plugin' --include='*.ts' --include='*.js' --include='*.mjs' --include='*.tsx' --include='*.jsx' . | grep -v node_modules | head -1",
    ],
    { cwd: checkout, stdout: "pipe", stderr: "pipe" },
  )
    .stdout.toString()
    .trim()
  if (!hasV1) {
    fs.rmSync(checkout, { recursive: true, force: true })
    continue
  }

  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: checkout,
    stdout: "pipe",
    stderr: "pipe",
  })
    .stdout.toString()
    .trim()
  const hasV2 =
    Bun.spawnSync(
      [
        "sh",
        "-c",
        "grep -rl '@opencode/plugin' --include='*.ts' --include='*.js' --include='*.mjs' . | grep -v node_modules | head -1",
      ],
      { cwd: checkout, stdout: "pipe", stderr: "pipe" },
    )
      .stdout.toString()
      .trim().length > 0

  selected.push({
    name: `${owner}__${name}`,
    repo: candidate.full_name,
    commit: sha,
    stars: candidate.stars,
    license: candidate.license,
    note: `${hasV2 ? "dual V1/V2 package" : "V1 plugin"}; ${candidate.description.slice(0, 80)}`,
  })
  console.log(`${selected.length}/${limit} ${candidate.full_name} (${candidate.stars}★)`)
}

fs.writeFileSync(outFile, `${JSON.stringify(selected, null, 2)}\n`)
console.log(`wrote ${selected.length} entries to ${path.relative(repo, outFile)}`)
