import fs from "node:fs"
import path from "node:path"
import { defineCommand, runMain } from "citty"
import { analyzePlugin, convertPlugin } from "../api"
import { renderMarkdown } from "../report/render"
import type { MigrationReport } from "../report/schema"

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`error: ${message}`)
  if (process.env.OC_MIGRATE_DEBUG && error instanceof Error && error.stack) {
    console.error(error.stack)
  }
  process.exit(EXIT_FAILED)
}

function usage(message: string): never {
  console.error(`error: ${message}`)
  process.exit(EXIT_USAGE)
}

function formatOf(args: { json?: boolean; format?: string }): "md" | "json" | "both" {
  const format = args.json ? "json" : (args.format ?? "md")
  if (format !== "md" && format !== "json" && format !== "both") {
    usage(`--format must be md, json, or both (received "${format}")`)
  }
  return format
}

function printReport(report: MigrationReport, format: "md" | "json" | "both", quiet: boolean) {
  if (quiet) return
  const markdown = renderMarkdown(report)
  if (format === "json") console.log(JSON.stringify(report, null, 2))
  else if (format === "both") {
    console.log(JSON.stringify(report, null, 2))
    console.log("\n---\n")
    console.log(markdown)
  } else console.log(markdown)
}

function hasFindings(report: MigrationReport): boolean {
  if (report.counts.review + report.counts.unsupported > 0) return true
  if (report.toolCounts.review > 0) return true
  if (report.package && report.package.remainingV1Imports.length > 0) return true
  if (report.typecheck && !report.typecheck.clean) return true
  if (report.runtime && (!report.runtime.bundle.ok || !report.runtime.entry.ok)) return true
  return false
}

const analyze = defineCommand({
  meta: {
    name: "analyze",
    description: "Report how a V1 plugin maps to the V2 plugin API. Writes nothing.",
  },
  args: {
    dir: { type: "positional", description: "Plugin directory", required: true },
    json: { type: "boolean", description: "Shorthand for --format json", default: false },
    format: { type: "string", description: "md, json, or both", default: "md" },
    target: { type: "string", description: "Expected @opencode/plugin version" },
    check: {
      type: "boolean",
      description: "Exit 1 when anything needs review or is unsupported",
      default: false,
    },
    quiet: { type: "boolean", description: "Suppress report output", default: false },
  },
  async run({ args }) {
    try {
      const format = formatOf(args)
      const { report } = await analyzePlugin(args.dir, {
        ...(args.target ? { target: args.target } : {}),
      })
      printReport(report, format, args.quiet)
      process.exitCode = args.check && hasFindings(report) ? EXIT_FAILED : EXIT_OK
    } catch (error) {
      fail(error)
    }
  },
})

const convert = defineCommand({
  meta: {
    name: "convert",
    description: "Generate a V2 module, then typecheck and bundle it against @opencode/plugin.",
  },
  args: {
    dir: { type: "positional", description: "Plugin directory", required: true },
    out: { type: "string", description: "Output root (default .migrate)" },
    json: { type: "boolean", description: "Shorthand for --format json", default: false },
    format: { type: "string", description: "md, json, or both", default: "md" },
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
    "dry-run": {
      type: "boolean",
      description: "Run the full pipeline and print the module without writing output",
      default: false,
    },
    check: {
      type: "boolean",
      description: "Exit 1 when anything needs review, is unsupported, or fails validation",
      default: false,
    },
    quiet: { type: "boolean", description: "Suppress report output", default: false },
    report: { type: "boolean", description: "Write MIGRATION.md into the output", default: true },
  },
  async run({ args }) {
    const dryRun = args["dry-run"] === true
    let result
    try {
      result = await convertPlugin(args.dir, {
        ...(args.out ? { outDir: path.resolve(args.out) } : {}),
        ...(args.dual ? { dual: true } : {}),
        ...(args.target ? { target: args.target } : {}),
        ...(args.force || dryRun ? { force: true } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      })
    } catch (error) {
      fail(error)
    }

    const format = formatOf(args)
    const report = result.report
    printReport(report, format, args.quiet)
    if (dryRun && !args.quiet && format !== "json") {
      console.log("```ts")
      console.log(result.module.source.trimEnd())
      console.log("```")
    }

    if (!dryRun && args.report) {
      fs.mkdirSync(result.outDir, { recursive: true })
      fs.writeFileSync(path.join(result.outDir, "MIGRATION.md"), renderMarkdown(report))
      fs.writeFileSync(
        path.join(result.outDir, "migration-report.json"),
        JSON.stringify(report, null, 2),
      )
    }

    const validationFailed =
      (report.typecheck && !report.typecheck.clean) ||
      (report.runtime && (!report.runtime.bundle.ok || !report.runtime.entry.ok))
    process.exitCode =
      validationFailed || (args.check && hasFindings(report)) ? EXIT_FAILED : EXIT_OK
  },
})

runMain(
  defineCommand({
    meta: { name: "opencode-plugin-migrate", description: "Migrate OpenCode V1 plugins to V2" },
    subCommands: { analyze, convert },
  }),
)
