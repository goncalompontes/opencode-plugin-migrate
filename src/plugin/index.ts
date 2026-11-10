/**
 * OpenCode V2 server plugin.
 *
 * Installing this package as a plugin adds two tools to the server plus the
 * `opencode-plugin-migrate` skill. The tools call the same public API as the CLI,
 * so a migration started in a session leaves the same report artifacts behind.
 */
import fs from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { analyzePlugin, convertPlugin } from "../api"
import { renderMarkdown } from "../report/render"
import type { MigrationReport } from "../report/schema"

const SKILL_ID = "opencode-plugin-migrate"

const analyzeInput = z.object({
  directory: z
    .string()
    .min(1)
    .describe("Plugin directory to inspect, absolute or relative to the project root."),
  target: z
    .string()
    .optional()
    .describe("Expected @opencode/plugin version. Warns when the installed target differs."),
})

const convertInput = z.object({
  directory: z
    .string()
    .min(1)
    .describe("Plugin directory to convert, absolute or relative to the project root."),
  outDir: z
    .string()
    .optional()
    .describe("Output root, relative to the project root. Defaults to .migrate."),
  dual: z
    .boolean()
    .optional()
    .describe("Also emit a V1 server() entrypoint for hosts on OpenCode >= 1.18.29."),
  force: z
    .boolean()
    .optional()
    .describe("Regenerate from scratch and discard preserved manual edits."),
})

function summary(report: MigrationReport): string {
  const parts = [
    `${report.counts.converted}/${report.hooks.length} hooks converted`,
    `${report.counts.review} need review`,
    `${report.counts.unsupported} unsupported`,
  ]
  if (report.tools.length) {
    parts.push(`${report.toolCounts.converted}/${report.tools.length} tools registered`)
  }
  if (report.typecheck) parts.push(`typecheck ${report.typecheck.clean ? "clean" : "failed"}`)
  if (report.runtime) {
    parts.push(
      `runtime ${
        report.runtime.bundle.skipped
          ? "bundle skipped (Node)"
          : report.runtime.bundle.ok && report.runtime.entry.ok
            ? "ok"
            : "failed"
      }`,
    )
  }
  return parts.join(" · ")
}

/** Locate the packaged skill directory from source (`src/plugin`) or `dist`. */
function skillDirectory(): string | undefined {
  let current = path.dirname(new URL(import.meta.url).pathname)
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(current, "skills", SKILL_ID)
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate
    current = path.resolve(current, "..")
  }
  return undefined
}

export default Plugin.define({
  id: SKILL_ID,
  async setup(ctx) {
    const projectRoot = ctx.location.directory

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "migrate_analyze",
        description: "Report how an OpenCode V1 plugin maps to the V2 plugin API. Writes nothing.",
        input: analyzeInput,
        async execute(input) {
          const directory = path.resolve(projectRoot, input.directory)
          const { report } = await analyzePlugin(directory, {
            root: projectRoot,
            ...(input.target ? { target: input.target } : {}),
          })
          return {
            content: `${summary(report)}\n\n${renderMarkdown(report)}`,
            metadata: {
              id: report.id,
              mode: report.mode,
              counts: report.counts,
              typecheck: report.typecheck,
            },
          }
        },
      })

      editor.add({
        name: "migrate_convert",
        description:
          "Convert an OpenCode V1 plugin to V2, then typecheck and bundle the generated module.",
        input: convertInput,
        async execute(input) {
          const directory = path.resolve(projectRoot, input.directory)
          const reportPath = path.join(projectRoot, "MIGRATION.md")
          const result = await convertPlugin(directory, {
            root: projectRoot,
            ...(input.outDir ? { outDir: path.resolve(projectRoot, input.outDir) } : {}),
            ...(input.dual ? { dual: true } : {}),
            ...(input.force ? { force: true } : {}),
          })
          fs.mkdirSync(result.outDir, { recursive: true })
          const markdown = renderMarkdown(result.report)
          fs.writeFileSync(path.join(result.outDir, "MIGRATION.md"), markdown)
          fs.writeFileSync(
            path.join(result.outDir, "migration-report.json"),
            `${JSON.stringify(result.report, null, 2)}\n`,
          )
          return {
            content: `Converted into \`${result.outDir}\`.\n\n${summary(result.report)}\n\nReport: \`${path.join(result.outDir, "MIGRATION.md")}\``,
            metadata: {
              id: result.report.id,
              mode: result.report.mode,
              outDir: result.outDir,
              counts: result.report.counts,
              typecheck: result.report.typecheck,
              runtime: result.report.runtime,
              reportPath,
            },
          }
        },
      })
    })

    const skills = ctx.skill
    if (skills?.transform) {
      const directory = skillDirectory()
      const content = directory
        ? fs.readFileSync(path.join(directory, "SKILL.md"), "utf8")
        : undefined
      if (directory && content) {
        await skills.transform((editor) => {
          editor.add({
            id: SKILL_ID,
            name: "OpenCode plugin migration",
            description:
              "Convert OpenCode V1 plugins to V2 with opencode-plugin-migrate and review what still needs a human decision.",
            autoinvoke: true,
            path: directory,
            content,
          } as never)
        })
      }
    }
  },
})
