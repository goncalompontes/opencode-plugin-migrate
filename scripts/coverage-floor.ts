#!/usr/bin/env bun
/**
 * Coverage floor for the parts that must stay well tested: hook classification and
 * emission. LCOV is parsed directly so the floor applies to those directories, not to
 * the whole repository.
 */
import fs from "node:fs"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "..")
const dir = path.join(repo, ".coverage")
const FLOOR = 0.75
const GROUPS = ["src/rules/", "src/emit/"]

fs.rmSync(dir, { recursive: true, force: true })
const result = Bun.spawnSync(
  ["bun", "test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`],
  { cwd: repo, stdio: ["ignore", "inherit", "inherit"] },
)
if (result.exitCode !== 0) process.exit(result.exitCode ?? 1)

const lcov = fs.readFileSync(path.join(dir, "lcov.info"), "utf8")
const totals = new Map<string, { hit: number; found: number }>()
for (const record of lcov.split("end_of_record")) {
  const file = /SF:(.+)/.exec(record)?.[1]?.trim()
  const hit = Number(/LH:(\d+)/.exec(record)?.[1] ?? 0)
  const found = Number(/LF:(\d+)/.exec(record)?.[1] ?? 0)
  if (!file || found === 0) continue
  for (const group of GROUPS) {
    if (!file.includes(group)) continue
    const current = totals.get(group) ?? { hit: 0, found: 0 }
    current.hit += hit
    current.found += found
    totals.set(group, current)
  }
}

let failed = false
for (const group of GROUPS) {
  const value = totals.get(group)
  if (!value) {
    console.error(`coverage: no records for ${group}`)
    failed = true
    continue
  }
  const ratio = value.hit / value.found
  const percent = (ratio * 100).toFixed(1)
  console.log(`${group} ${percent}% (${value.hit}/${value.found}) floor ${FLOOR * 100}%`)
  if (ratio < FLOOR) failed = true
}
if (failed) {
  console.error("coverage floor not met")
  process.exit(1)
}
