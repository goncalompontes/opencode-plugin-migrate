#!/usr/bin/env bun
/** Pack the package, install the tarball into a temp project, and run the CLI. */
import fs from "node:fs"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "..")
const work = fs.mkdtempSync(path.join(repo, ".pack-smoke-"))

function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    console.error(result.stdout.toString())
    console.error(result.stderr.toString())
    throw new Error(`${command.join(" ")} failed in ${cwd}`)
  }
  return result.stdout.toString()
}

console.log("building…")
run(["bun", "run", "build"], repo)

console.log("packing…")
const packDir = path.join(work, "pack")
fs.mkdirSync(packDir)
run(["bun", "pm", "pack", "--destination", packDir], repo)
const tarball = fs
  .readdirSync(packDir)
  .filter((name) => name.endsWith(".tgz"))
  .map((name) => path.join(packDir, name))[0]
if (!tarball) throw new Error("no tarball produced")

console.log("installing into a clean project…")
const project = path.join(work, "project")
fs.mkdirSync(project)
fs.writeFileSync(path.join(project, "package.json"), '{"name":"pack-smoke","private":true,"type":"module"}\n')
run(
  ["npm", "install", tarball, "@opencode/plugin@2.2.7", "--no-audit", "--no-fund", "--ignore-scripts"],
  project,
)

const bin = path.join(project, "node_modules", ".bin", "opencode-plugin-migrate")
const help = run([bin, "--help"], project)
if (!help.includes("convert")) throw new Error("CLI help did not list convert")

const analyze = run([bin, "analyze", path.join(repo, "test", "fixtures", "basic"), "--format", "json"], project)
const report = JSON.parse(analyze) as { counts?: { converted?: number } }
if (!report.counts || (report.counts.converted ?? 0) < 1) {
  throw new Error("installed CLI did not analyze the fixture")
}

console.log(`ok: installed tarball ${path.basename(tarball)} and analyzed a plugin`)
fs.rmSync(work, { recursive: true, force: true })
