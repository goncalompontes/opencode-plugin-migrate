import type { MigrationReport } from "./schema"

const ICON: Record<string, string> = {
  converted: "converted",
  review: "review",
  unsupported: "unsupported",
}

export function renderMarkdown(report: MigrationReport): string {
  const lines: string[] = []
  lines.push(`# Migration report: ${report.id}`)
  lines.push("")
  lines.push(`- Source: \`${report.sourceDir}\``)
  lines.push(`- Entry: \`${report.entryFile}\``)
  if (report.generatedFile) lines.push(`- Generated: \`${report.generatedFile}\``)
  lines.push(
    `- Hooks: **${report.counts.converted} converted**, ${report.counts.review} need review, ${report.counts.unsupported} unsupported`,
  )
  if (report.typecheck) {
    lines.push(
      `- Typecheck: ${report.typecheck.clean ? "**clean**" : "**failed**"} (${report.typecheck.errors} errors, ${report.typecheck.warnings} warnings)`,
    )
  }
  lines.push("")
  lines.push("## Hooks")
  lines.push("")
  lines.push("| Hook | Status | V2 destination | Notes |")
  lines.push("| --- | --- | --- | --- |")
  for (const hook of report.hooks) {
    lines.push(
      `| \`${hook.name}\` | ${ICON[hook.classification] ?? hook.classification} | ${hook.v2} | ${hook.reason ?? ""}${report.mode === "convert" && !hook.emitted ? " _(left for manual porting)_" : ""} |`,
    )
  }
  if (report.tools.length) {
    lines.push("")
    lines.push("## Custom tools")
    lines.push("")
    for (const tool of report.tools) {
      lines.push(`- \`${tool.name}\` (line ${tool.line}): ${tool.description || "(no description)"}`)
    }
  }
  if (report.diagnostics.length) {
    lines.push("")
    lines.push("## Diagnostics")
    lines.push("")
    for (const item of report.diagnostics) {
      const where = item.range ? `${item.range.file}:${item.range.line}:${item.range.column}` : "project"
      lines.push(`- **${item.severity}** \`${item.code}\` (${where}): ${item.message}`)
      if (item.hint) lines.push(`  - hint: ${item.hint}`)
    }
  }
  if (report.leftovers.length) {
    lines.push("")
    lines.push("## Manual porting queue")
    lines.push("")
    for (const item of report.leftovers) {
      lines.push(`### \`${item.name}\` -> ${item.v2}`)
      if (item.reason) lines.push("")
      if (item.reason) lines.push(`> ${item.reason}`)
      lines.push("")
      lines.push("```ts")
      lines.push(item.body)
      lines.push("```")
      lines.push("")
    }
  }
  lines.push("")
  return lines.join("\n")
}
