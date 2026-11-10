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
  if (report.target) lines.push(`- Target: \`@opencode/plugin@${report.target.version}\``)
  if (report.generatedFile) lines.push(`- Generated: \`${report.generatedFile}\``)
  lines.push(
    `- Hooks: **${report.counts.converted} converted**, ${report.counts.review} need review, ${report.counts.unsupported} unsupported`,
  )
  if (report.tools.length) {
    lines.push(
      `- Tools: **${report.toolCounts.converted} converted**, ${report.toolCounts.review} need review`,
    )
  }
  if (report.typecheck) {
    lines.push(
      `- Typecheck: ${report.typecheck.clean ? "**clean**" : "**failed**"} (${report.typecheck.errors} errors, ${report.typecheck.warnings} warnings)`,
    )
  }
  if (report.repair && report.repair.passes > 0) {
    lines.push(`- Repair: **${report.repair.passes} fix(es)** (${report.repair.stopped})`)
  }
  if (report.runtime) {
    lines.push(
      `- Runtime: ${report.runtime.bundle.ok && report.runtime.entry.ok ? "**bundle + entry ok**" : "**failed**"}`,
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
  if (report.runtime && (!report.runtime.bundle.ok || !report.runtime.entry.ok)) {
    lines.push("")
    lines.push("## Runtime")
    lines.push("")
    lines.push(`- Bundle: ${report.runtime.bundle.ok ? "ok" : report.runtime.bundle.errors.join("; ")}`)
    lines.push(`- Entry: ${report.runtime.entry.message}`)
  }
  if (report.repair && report.repair.fixes.length) {
    lines.push("")
    lines.push("## Auto-repair")
    lines.push("")
    for (const fix of report.repair.fixes) {
      lines.push(
        `- pass ${fix.pass}: \`${fix.code}\`${fix.origin ? ` in \`${fix.origin}\`` : ""} — ${fix.detail}`,
      )
    }
  }
  if (report.scaffolding && report.scaffolding.length) {
    lines.push("")
    lines.push("## Scaffolding")
    lines.push("")
    for (const item of report.scaffolding) lines.push(`- \`${item.kind}\`: ${item.detail}`)
  }
  if (report.package) {
    lines.push("")
    lines.push("## Package")
    lines.push("")
    lines.push(
      `- Rewritten files: ${report.package.rewrittenFiles.length}${report.package.shim ? ` (shim: \`${report.package.shim}\`)` : ""}`,
    )
    lines.push(
      `- package.json dependency: ${
        !report.package.hasManifest
          ? "no manifest in this tree"
          : report.package.dependencySwapped
            ? "moved to `@opencode/plugin`"
            : "kept on `@opencode-ai/plugin`"
      }`,
    )
    if (report.package.remainingV1Imports.length) {
      lines.push("- Remaining V1 imports:")
      for (const file of report.package.remainingV1Imports) lines.push(`  - \`${file}\``)
    }
  }
  if (report.tools.length) {
    lines.push("")
    lines.push("## Custom tools")
    lines.push("")
    for (const tool of report.tools) {
      lines.push(
        `- \`${tool.name}\` (line ${tool.line}): ${tool.description || "(no description)"} — ${tool.classification}${report.mode === "convert" && !tool.emitted ? " _(left for manual porting)_" : ""}`,
      )
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
