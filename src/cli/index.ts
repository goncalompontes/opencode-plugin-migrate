#!/usr/bin/env bun
import fs from "node:fs"
import path from "node:path"
import { defineCommand, runMain } from "citty"
import { analyzePlugin, convertPlugin } from "../api"
import { renderMarkdown } from "../report/render"

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`error: ${message}`)
  if (process.env.OC_MIGRATE_DEBUG && error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(1)
}

const analyze = defineCommand({
  meta: {
    name: "analyze",
    description: "Report how a V1 plugin maps to the V2 plugin API. Writes nothing.",
  },
  args: {
    dir: { type: "positional", description: "Plugin directory", required: true },
    json: { type: "boolean", description: "Print the report as JSON", default: false },
    target: { type: "string", description: "Expected @opencode/plugin version" },
  },
  async run({ args }) {
    try {
      const { report } = await analyzePlugin(args.dir, { ...(args.target ? { target: args.target } : {}) })
      if (args.json) console.log(JSON.stringify(report, null, 2))
      else console.log(renderMarkdown(report))
    } catch (error) {
      fail(error)
    }
  },
})

const convert = defineCommand({
  meta: {
    name: "convert",
    description: "Generate a V2 module, then typecheck it against @opencode/plugin.",
  },
  args: {
    dir: { type: "positional", description: "Plugin directory", required: true },
    out: { type: "string", description: "Output root (default .migrate)" },
    json: { type: "boolean", description: "Print the report as JSON", default: false },
    dual: {
      type: "boolean",
      description: "Also emit a V1 server() entrypoint for OpenCode >= 1.18.29",
      default: false,
    },
    target: { type: "string", description: "Expected @opencode/plugin version" },
    force: {
      type: "boolean",
      description: "Regenerate from scratch and discard preserved manual edits",
      default: false,
    },
    report: { type: "boolean", description: "Write MIGRATION.md into the output", default: true },
  },
  async run({ args }) {
    let result
    try {
      result = await convertPlugin(args.dir, {
        ...(args.out ? { outDir: path.resolve(args.out) } : {}),
        ...(args.dual ? { dual: true } : {}),
        ...(args.target ? { target: args.target } : {}),
        ...(args.force ? { force: true } : {}),
      })
    } catch (error) {
      fail(error)
    }
    if (args.json) console.log(JSON.stringify(result.report, null, 2))
    else console.log(renderMarkdown(result.report))

    if (args.report) {
      fs.mkdirSync(result.outDir, { recursive: true })
      fs.writeFileSync(path.join(result.outDir, "MIGRATION.md"), renderMarkdown(result.report))
      fs.writeFileSync(
        path.join(result.outDir, "migration-report.json"),
        JSON.stringify(result.report, null, 2),
      )
    }
    const runtimeOk = result.report.runtime ? result.report.runtime.bundle.ok && result.report.runtime.entry.ok : true
    if (!result.report.typecheck?.clean || !runtimeOk) process.exitCode = 1
  },
})

runMain(
  defineCommand({
    meta: { name: "opencode-plugin-migrate", description: "Migrate OpenCode V1 plugins to V2" },
    subCommands: { analyze, convert },
  }),
)
