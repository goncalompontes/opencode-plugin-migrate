/**
 * Migrated from OpenCode V1 by opencode-plugin-migrate.
 * Source: benchmarks/corpus/openslimedit/src/index.ts
 * Review every "not converted automatically" block before shipping.
 */
import { Plugin } from "@opencode/plugin"
import * as fs from "fs"
import * as path from "path"

// #region carried-v1
const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/
// #endregion carried-v1

const plugin = Plugin.define({
  id: "openslimedit",
  async setup(__opencode) {
    const directory = __opencode.location.directory
    // #region carried-v1
    function resolvePath(filePath: string): string {
      if (path.isAbsolute(filePath)) return path.normalize(filePath)
      return path.resolve(directory, filePath)
    }
    // #endregion carried-v1
    await __opencode.tool.transform((editor) => {
      for (const current of editor.list()) {
        const input: any = { toolID: current.id }
        const output: any = { description: current.description, parameters: current.input }
        try {
          // #region carried-v1
          const SLIM: Record<string, string> = {
            read: "Read file content.",
            edit: "Edit file. oldString can be line range '55-64'.",
            apply_patch: "Apply a patch to files.",
            write: "Write file.",
            bash: "Run shell command.",
            glob: "Find files.",
            grep: "Search in files.",
            list: "List directory.",
            fetch: "Fetch URL.",
          }
          if (SLIM[input.toolID]) {
            output.description = SLIM[input.toolID]
          }
          // #endregion carried-v1
        } finally {
          editor.update(current.id, (tool) => {
            tool.description = output.description
            tool.input = output.parameters
          })
        }
      }
    })
    await __opencode.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      const input: any = { tool: event.tool, sessionID: event.sessionID, callID: event.id, args: event.input }
      const result: any = event.result ?? {}
      const output: any = {
        title: typeof result.title === "string" ? result.title : "",
        output: typeof result.content === "string" ? result.content : typeof result.output === "string" ? result.output : "",
        metadata: result.metadata,
      }
      try {
        // #region carried-v1
        if (input.tool === "edit") {
          if (output.output.startsWith("Edit applied successfully.")) {
            output.output = "OK"
          }
          return
        }
        if (input.tool !== "read") return
        if (output.output.includes("<type>directory</type>")) return
        const pathMatch = output.output.match(/<path>(.+?)<\/path>/)
        if (!pathMatch) return
        const absPath = path.normalize(pathMatch[1])
        const relPath = path.relative(directory, absPath)
        output.output = output.output.replace(
          `<path>${pathMatch[1]}</path>`,
          `<path>${relPath}</path>`,
        )
        output.output = output.output.replace("<type>file</type>\n", "")
        output.output = output.output.replace(
          /\n\n\(End of file - total \d+ lines\)\n/,
          "\n",
        )
        // #endregion carried-v1
      } finally {
        event.result = { ...result, content: output.output, metadata: output.metadata }
      }
    })
    await __opencode.tool.hook("execute.before", async (event) => {
      const input: any = { tool: event.tool, sessionID: event.sessionID, callID: event.id }
      const output: any = { args: event.input }
      try {
        // #region carried-v1
        if (input.tool !== "edit") return
        const args = output.args
        if (!args.oldString || !args.filePath) return
        const filePath = resolvePath(args.filePath)
        let content: string
        try {
          content = fs.readFileSync(filePath, "utf-8")
        } catch {
          return
        }
        if (content.includes(args.oldString)) return
        const match = args.oldString.trim().match(LINE_RANGE_RE)
        if (!match) return
        const lines = content.split("\n")
        const startLine = parseInt(match[1], 10)
        const endLine = match[2] ? parseInt(match[2], 10) : startLine
        if (startLine >= 1 && endLine <= lines.length && startLine <= endLine) {
          args.oldString = lines.slice(startLine - 1, endLine).join("\n")
        }
        // #endregion carried-v1
      } finally {
        event.input = output.args
      }
    })
  },
})

export default plugin
