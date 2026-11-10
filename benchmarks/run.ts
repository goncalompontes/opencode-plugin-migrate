#!/usr/bin/env bun
/**
 * Run the converter over real V1 plugins.
 *
 * Core entries (benchmarks/manifest.ts) are curated and strict: expected counts and
 * clean validation are required. Community entries are discovered from GitHub and
 * recorded in a baseline, so a real-world failure is visible without making every run
 * red; a clean baseline entry that regresses does fail the benchmark.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { convertPlugin } from "../src/api"
import { countV1ImportFiles } from "../src/env/imports"
import type { MigrationReport } from "../src/report/schema"
import { BenchCache, converterFingerprint, hashDirectory } from "./cache"
import { CORPUS, type ExpectedCounts } from "./manifest"

const here = import.meta.dir
const repoRoot = path.resolve(here, "..")
const corpusDir = path.join(here, "corpus")
const outRoot = path.join(here, ".out")
const baselineFile = path.join(here, "baseline.json")
const communityFile = path.join(here, "community.json")
const fetchMissing = process.argv.includes("--fetch")
const updateBaseline = process.argv.includes("--update-baseline")
const coreOnly = process.argv.includes("--core-only")
const noCache = process.argv.includes("--no-cache")

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdio: ["ignore", "ignore", "inherit"] })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
}

function ensure(checkout: string, repo: string, commit: string): void {
  if (fs.existsSync(checkout) && fs.readdirSync(checkout).length > 0) return
  if (!fetchMissing) return
  fs.mkdirSync(checkout, { recursive: true })
  git(["init", "-q"], checkout)
  git(["remote", "add", "origin", `https://github.com/${repo}.git`], checkout)
  git(["fetch", "-q", "--depth", "1", "origin", commit], checkout)
  git(["checkout", "-q", "FETCH_HEAD"], checkout)
}

interface CommunityEntry {
  name: string
  repo: string
  commit: string
  stars: number
  license: string
  note: string
}

interface BaselineEntry {
  status: "clean" | "issues" | "crashed" | "skipped"
  hooks: number
  converted: number
  review: number
  unsupported: number
  tools: number
  error?: string
}

interface Baseline {
  generatedAt: string
  entries: Record<string, BaselineEntry>
}

function cleanMessage(message: string, checkout: string): string {
  return message
    .split("\n")[0]!
    .replaceAll(checkout, "<repo>")
    .replaceAll(outRoot, "<out>")
    .replaceAll(repoRoot, "<repo>")
    // Diagnostics can reference paths outside the checkout (old clones, node_modules
    // resolved from another root). Keep generated docs machine-independent.
    .replace(/(?:\/home|\/Users)\/[^\s'")]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
}

function category(message: string): string {
  if (message.includes("only ships compiled output")) return "compiled-only package"
  if (message.includes("could not find a plugin entrypoint")) return "no entrypoint"
  if (message.includes("no V1 plugin factory")) return "no V1 factory"
  if (message.includes("syntax errors")) return "syntax errors"
  if (message.includes("could not load")) return "could not load entry"
  if (message.includes("does not typecheck") || message.includes("typecheck"))
    return "typecheck failed"
  if (message.includes("runtime")) return "runtime validation failed"
  if (message.includes("already targets")) return "already V2"
  return "other"
}

interface WorkerResult {
  ok: boolean
  v1Before: number
  v1After?: number
  report?: MigrationReport
  error?: string
  durationMs?: number
}

const workerPath = path.join(here, "worker.ts")
const concurrency = Math.max(
  2,
  Math.min(
    Number(process.env.BENCH_CONCURRENCY) || 8,
    os.availableParallelism?.() ?? os.cpus().length,
  ),
)

async function runWorker(checkout: string): Promise<WorkerResult> {
  const proc = Bun.spawn(["bun", workerPath, "--dir", checkout, "--out", outRoot], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const line = stdout.trim().split("\n").filter(Boolean).pop()
  if (!line) return { ok: false, v1Before: 0, error: stderr.trim() || `worker exited ${code}` }
  try {
    return JSON.parse(line) as WorkerResult
  } catch {
    return { ok: false, v1Before: 0, error: `${stderr.trim()} | ${line.slice(0, 200)}` }
  }
}

async function runPool(entries: CommunityEntry[]): Promise<Map<string, WorkerResult>> {
  const results = new Map<string, WorkerResult>()
  const pending: CommunityEntry[] = []
  for (const entry of entries) {
    const cached = noCache ? undefined : (cache.get(identityOf(entry)) as WorkerResult | undefined)
    if (cached && (cached.report || cached.ok === false)) results.set(entry.name, cached)
    else pending.push(entry)
  }
  let next = 0
  let done = 0
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      const entry = pending[index]
      if (!entry) return
      const checkout = path.join(corpusDir, entry.name)
      const result = await runWorker(checkout)
      results.set(entry.name, result)
      cache.set(identityOf(entry), result)
      done += 1
      if (done % 10 === 0 || done === pending.length) {
        console.error(
          `community: ${done}/${pending.length} (${results.size - pending.length + done} cached)`,
        )
      }
    }
  })
  await Promise.all(workers)
  return results
}

interface Row {
  name: string
  repo: string
  stars?: number
  community: boolean
  hooks: number
  converted: number
  review: number
  unsupported: number
  typecheck: string
  runtime: string
  v1Before: number
  v1After: number
  toolsTotal: number
  toolsConverted: number
  emitted: number
  skipped: number
  status: "clean" | "issues" | "crashed" | "skipped"
  error?: string
  durationMs?: number
  report?: MigrationReport
}

const community: CommunityEntry[] = fs.existsSync(communityFile)
  ? (JSON.parse(fs.readFileSync(communityFile, "utf8")) as CommunityEntry[])
  : []
const baseline: Baseline = fs.existsSync(baselineFile)
  ? (JSON.parse(fs.readFileSync(baselineFile, "utf8")) as Baseline)
  : { generatedAt: "", entries: {} }

const targetVersion = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "node_modules", "@opencode", "plugin", "package.json"),
    "utf8",
  ),
).version as string
const cache = new BenchCache(
  path.join(here, ".cache"),
  converterFingerprint(repoRoot, targetVersion),
)
const identityOf = (entry: { repo: string; commit: string; local?: string }): string =>
  entry.local
    ? `local:${entry.local}:${hashDirectory(path.join(repoRoot, entry.local))}`
    : `git:${entry.repo}@${entry.commit}`

const rows: Row[] = []
const failures: string[] = []
const nextBaseline: Record<string, BaselineEntry> = {}

for (const entry of CORPUS) {
  const checkout = entry.local ? path.join(repoRoot, entry.local) : path.join(corpusDir, entry.name)
  if (!entry.local) {
    try {
      ensure(checkout, entry.repo, entry.commit)
    } catch (error) {
      failures.push(`${entry.name}: could not fetch (${String(error)})`)
      continue
    }
  }
  if (!fs.existsSync(checkout)) {
    console.warn(`skip ${entry.name}: not checked out (run with --fetch)`)
    continue
  }

  const identity = identityOf(entry)
  let outcome = noCache ? undefined : (cache.get(identity) as WorkerResult | undefined)
  if (!outcome) {
    try {
      const v1Before = countV1ImportFiles(checkout)
      const { report } = await convertPlugin(checkout, { outDir: outRoot })
      outcome = {
        ok: true,
        v1Before,
        v1After: countV1ImportFiles(path.join(outRoot, report.id)),
        report,
      }
    } catch (error) {
      outcome = {
        ok: false,
        v1Before: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    cache.set(identity, outcome)
  }
  if (!outcome.ok || !outcome.report) {
    failures.push(`${entry.name}: ${outcome.error ?? "conversion failed"}`)
    continue
  }

  const report = outcome.report
  const v1Before = outcome.v1Before
  const v1After = outcome.v1After ?? v1Before
  const runtimeOk = Boolean(report.runtime?.bundle.ok && report.runtime?.entry.ok)
  rows.push({
    name: entry.name,
    repo: entry.repo,
    community: false,
    hooks: report.hooks.length,
    converted: report.counts.converted,
    review: report.counts.review,
    unsupported: report.counts.unsupported,
    typecheck: report.typecheck?.clean ? "clean" : `failed (${report.typecheck?.errors ?? "?"})`,
    runtime: runtimeOk ? "ok" : entry.knownRuntimeFailure ? "known upstream failure" : "failed",
    v1Before,
    v1After,
    toolsTotal: report.tools.length,
    toolsConverted: report.toolCounts.converted,
    emitted: report.hooks.filter((hook) => hook.emitted).length,
    skipped: report.hooks.filter((hook) => !hook.emitted).length,
    status:
      report.typecheck?.clean && (runtimeOk || entry.knownRuntimeFailure) ? "clean" : "issues",
    report,
  })
  if (!report.typecheck?.clean) {
    failures.push(`${entry.name}: emitted module does not typecheck`)
  }
  if (!runtimeOk && !entry.knownRuntimeFailure) {
    failures.push(`${entry.name}: emitted module failed runtime validation`)
  }
  if (v1After !== 0) {
    failures.push(`${entry.name}: ${v1After} file(s) still import @opencode-ai/plugin`)
  }
  const expectations: Array<[keyof ExpectedCounts, unknown, unknown]> = [
    ["hooks", entry.expect?.hooks, report.hooks.length],
    ["converted", entry.expect?.converted, report.counts.converted],
    ["review", entry.expect?.review, report.counts.review],
    ["unsupported", entry.expect?.unsupported, report.counts.unsupported],
    ["tools", entry.expect?.tools, report.tools.length],
    ["toolsConverted", entry.expect?.toolsConverted, report.toolCounts.converted],
    ["v1After", entry.expect?.v1After, v1After],
    ["runtime", entry.expect?.runtime, runtimeOk ? "ok" : "known-failure"],
  ]
  for (const [label, expected, actual] of expectations) {
    if (expected !== undefined && expected !== actual) {
      failures.push(`${entry.name}: expected ${label}=${expected}, got ${actual}`)
    }
  }
}

const communityEntries = (coreOnly ? [] : community).filter((entry) =>
  fs.existsSync(path.join(corpusDir, entry.name)),
)
const communityResults = await runPool(communityEntries)

for (const entry of communityEntries) {
  const result = communityResults.get(entry.name)
  if (!result) continue
  if (!result.ok || !result.report) {
    const message = cleanMessage(result.error ?? "worker failed", path.join(corpusDir, entry.name))
    const notApplicable = /compiled-only|no entrypoint|no V1 plugin factory|already targets/.test(
      message,
    )
    rows.push({
      name: entry.name,
      repo: entry.repo,
      stars: entry.stars,
      community: true,
      hooks: 0,
      converted: 0,
      review: 0,
      unsupported: 0,
      typecheck: "n/a",
      runtime: "n/a",
      v1Before: result.v1Before,
      v1After: result.v1Before,
      toolsTotal: 0,
      toolsConverted: 0,
      emitted: 0,
      skipped: 0,
      status: notApplicable ? "skipped" : "crashed",
      error: message,
      ...(result.durationMs ? { durationMs: result.durationMs } : {}),
    })
    nextBaseline[entry.repo] = {
      status: notApplicable ? "skipped" : "crashed",
      hooks: 0,
      converted: 0,
      review: 0,
      unsupported: 0,
      tools: 0,
      error: message,
    }
    if (baseline.entries[entry.repo]?.status === "clean") {
      failures.push(`${entry.repo}: regression from clean to crashed`)
    }
    continue
  }

  const report = result.report
  const v1Before = result.v1Before
  const v1After = result.v1After ?? v1Before
  const runtimeOk = Boolean(report.runtime?.bundle.ok && report.runtime?.entry.ok)
  const status: Row["status"] =
    report.typecheck?.clean && (runtimeOk || !report.runtime) ? "clean" : "issues"
  const detail =
    status === "clean"
      ? undefined
      : cleanMessage(
          report.diagnostics.find((item) => item.severity === "error")?.message ??
            report.runtime?.bundle.errors[0] ??
            "typecheck or runtime failed",
          path.join(corpusDir, entry.name),
        )
  rows.push({
    name: entry.name,
    repo: entry.repo,
    stars: entry.stars,
    community: true,
    hooks: report.hooks.length,
    converted: report.counts.converted,
    review: report.counts.review,
    unsupported: report.counts.unsupported,
    typecheck: report.typecheck?.clean ? "clean" : "failed",
    runtime: runtimeOk ? "ok" : "failed",
    v1Before,
    v1After,
    toolsTotal: report.tools.length,
    toolsConverted: report.toolCounts.converted,
    emitted: report.hooks.filter((hook) => hook.emitted).length,
    skipped: report.hooks.filter((hook) => !hook.emitted).length,
    status,
    ...(detail ? { error: detail } : {}),
    ...(result.durationMs ? { durationMs: result.durationMs } : {}),
    report,
  })
  nextBaseline[entry.repo] = {
    status,
    hooks: report.hooks.length,
    converted: report.counts.converted,
    review: report.counts.review,
    unsupported: report.counts.unsupported,
    tools: report.tools.length,
    ...(detail ? { error: detail } : {}),
  }
  if (baseline.entries[entry.repo]?.status === "clean" && status !== "clean") {
    failures.push(`${entry.repo}: regression from clean to ${status}`)
  }
}

function table(): string {
  const lines = [
    "| Plugin | Hooks | Converted | Review | Unsupported | Tools | Typecheck | Runtime | V1 imports |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |",
    ...rows
      .filter((row) => !row.community)
      .map(
        (row) =>
          `| ${row.repo ? `[${row.name}](https://github.com/${row.repo})` : row.name} | ${row.hooks} | ${row.converted} | ${row.review} | ${row.unsupported} | ${row.toolsConverted}/${row.toolsTotal} | ${row.typecheck} | ${row.runtime} | ${row.v1Before} -> ${row.v1After} |`,
      ),
  ]
  return lines.join("\n")
}

const communityRows = rows.filter((row) => row.community)
const communityStats = {
  total: communityRows.length,
  clean: communityRows.filter((row) => row.status === "clean").length,
  issues: communityRows.filter((row) => row.status === "issues").length,
  crashed: communityRows.filter((row) => row.status === "crashed").length,
  skipped: communityRows.filter((row) => row.status === "skipped").length,
  typecheck: communityRows.filter((row) => row.typecheck === "clean").length,
  hooks: communityRows.reduce((sum, row) => sum + row.hooks, 0),
  converted: communityRows.reduce((sum, row) => sum + row.converted, 0),
}
const errorCounts = new Map<string, number>()
for (const row of communityRows) {
  if (!row.error) continue
  const key = category(row.error)
  errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1)
}
const topErrors = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)

const totals = rows
  .filter((row) => !row.community)
  .reduce(
    (acc, row) => ({
      hooks: acc.hooks + row.hooks,
      converted: acc.converted + row.converted,
      review: acc.review + row.review,
      unsupported: acc.unsupported + row.unsupported,
    }),
    { hooks: 0, converted: 0, review: 0, unsupported: 0 },
  )

const communityTable = [
  "| Repository | Stars | Status | Hooks | Converted | Review | Unsupported | Tools | Error |",
  "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ...communityRows
    .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
    .map(
      (row) =>
        `| [${row.repo}](https://github.com/${row.repo}) | ${row.stars ?? 0} | ${row.status} | ${row.hooks} | ${row.converted} | ${row.review} | ${row.unsupported} | ${row.toolsConverted}/${row.toolsTotal} | ${row.error ?? ""} |`,
    ),
].join("\n")

console.error(`cache: ${cache.hits} hits, ${cache.misses} misses`)
const markdown = `# Benchmark: real OpenCode V1 plugins

Generated by \`bun benchmarks/run.ts\`.

## Curated corpus

${table()}

**Totals:** ${totals.hooks} hooks, ${totals.converted} converted (${Math.round((totals.converted / Math.max(totals.hooks, 1)) * 100)}%), ${totals.review} need review, ${totals.unsupported} unsupported.

A hook is converted only when a deterministic adapter exists. Its body is copied
verbatim into the V2 registration and the result is typechecked. Everything else is
reported with the closest V2 API and the original body.

## Community corpus (${coreOnly ? "skipped (--core-only)" : communityStats.total})

Discovered from GitHub code search for \`@opencode-ai/plugin\`, pinned to specific
commits. These are real-world packages, not fixtures. Run without \`--core-only\` for
the full set.

- Applicable packages: **${communityStats.total - communityStats.skipped}** (${communityStats.skipped} skipped: compiled-only, no entrypoint, no V1 factory, already V2)
- Clean (typecheck + bundle): **${communityStats.clean}**
- Typecheck clean: **${communityStats.typecheck}**
- Issues (typecheck or bundle): **${communityStats.issues}**
- Crashed before emit: **${communityStats.crashed}**
- Hooks seen: **${communityStats.hooks}**, converted: **${communityStats.converted}** (${Math.round((communityStats.converted / Math.max(communityStats.hooks, 1)) * 100)}%)

${
  topErrors.length
    ? `### Most common blockers\n\n${topErrors.map(([message, count]) => `- ${count}× ${message}`).join("\n")}`
    : ""
}

Full per-repository table: [benchmarks/COMMUNITY.md](COMMUNITY.md).

## What "converted" means

A deterministic adapter exists, the V1 body is copied verbatim, and the emitted module
passes the type and runtime gates. Everything else stays in the report with its original
body and the closest V2 API.
${failures.length ? `\n## Failures\n\n${failures.map((failure) => `- ${failure}`).join("\n")}\n` : ""}
`

fs.mkdirSync(here, { recursive: true })
fs.writeFileSync(path.join(here, "RESULTS.md"), markdown)
fs.writeFileSync(path.join(here, "COMMUNITY.md"), `# Community corpus\n\n${communityTable}\n`)
if (updateBaseline) {
  fs.writeFileSync(
    baselineFile,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), entries: nextBaseline }, null, 2)}\n`,
  )
  console.log(`updated ${path.relative(repoRoot, baselineFile)}`)
}
console.log(markdown)

if (rows.filter((row) => !row.community).length < 3) failures.push("fewer than 3 core plugins ran")
if (totals.converted === 0) failures.push("no hooks were converted")
if (failures.length) {
  console.error(`\nbenchmark failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`)
  process.exit(1)
}
