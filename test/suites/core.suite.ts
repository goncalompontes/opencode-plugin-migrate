import { describe, expect, test } from "bun:test"
import path from "node:path"
import { analyzePlugin, convertPlugin } from "../../src/api"
import { HOOK_RULES } from "../../src/rules/hooks"
import { pipeline, stage } from "../../src/core/pipeline"
import { countV1ImportFiles } from "../../src/env/imports"
import { z } from "zod"

const fixture = path.join(import.meta.dir, "..", "fixtures", "basic")
const root = path.join(import.meta.dir, "..", ".tmp")

describe("hook rule table", () => {
  test("covers every V1 hook with a V2 destination", () => {
    for (const name of [
      "event",
      "dispose",
      "tool.execute.before",
      "tool.execute.after",
      "tool.definition",
      "shell.env",
      "permission.ask",
      "chat.message",
      "chat.params",
      "chat.headers",
      "command.execute.before",
      "config",
      "auth",
      "provider",
      "tool",
      "experimental.chat.messages.transform",
      "experimental.chat.system.transform",
      "experimental.session.compacting",
      "experimental.compaction.autocontinue",
      "experimental.provider.small_model",
      "experimental.text.complete",
    ]) {
      expect(HOOK_RULES[name as keyof typeof HOOK_RULES]).toBeDefined()
    }
  })

  test("only claims conversion where an adapter exists", () => {
    for (const [name, rule] of Object.entries(HOOK_RULES)) {
      if (rule.classification === "converted") expect(rule.adapter).not.toBe("none")
      if (rule.classification !== "converted") expect(rule.adapter).toBe("none")
      expect(rule.v2.length).toBeGreaterThan(0)
      void name
    }
  })
})

describe("analyze", () => {
  test("classifies mechanical, review, and cleanup hooks", async () => {
    const { report } = await analyzePlugin(fixture)
    const byName = Object.fromEntries(report.hooks.map((hook) => [hook.name, hook.classification]))
    expect(byName["tool.execute.before"]).toBe("converted")
    expect(byName["event"]).toBe("converted")
    expect(byName["dispose"]).toBe("converted")
    expect(byName["chat.message"]).toBe("review")
    expect(report.counts).toEqual({ converted: 4, review: 1, unsupported: 0 })
  })

  test("writes nothing", async () => {
    const before = await Array.fromAsync(new Bun.Glob(".migrate/**").scan({ cwd: fixture }))
    await analyzePlugin(fixture)
    const after = await Array.fromAsync(new Bun.Glob(".migrate/**").scan({ cwd: fixture }))
    expect(after).toEqual(before)
  })
})

describe("already migrated", () => {
  test("recognizes a V2 module instead of guessing", async () => {
    await expect(analyzePlugin(path.join(import.meta.dir, "..", "fixtures", "already-v2"))).rejects.toThrow(
      /already targets the OpenCode V2 plugin API/,
    )
  })
})

describe("convert", () => {
  test("emits a compiling V2 module and keeps unconverted bodies", async () => {
    const result = await convertPlugin(fixture, { outDir: path.join(root, "out") })
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.module.emitted.sort()).toEqual([
      "dispose",
      "event",
      "permission.ask",
      "tool.execute.before",
    ])
    expect(result.module.skipped).toEqual(["chat.message"])
    expect(result.module.source).toContain("Plugin.define")
    expect(result.module.source).toContain("export default BasicPlugin")
    expect(result.module.source).toContain("#region carried-v1")
    expect(result.module.source).toContain("Not converted automatically")
    const manifest = await Bun.file(path.join(result.outDir, "package.json")).json()
    expect(manifest.dependencies["@opencode/plugin"]).toStartWith("^2")
    expect(manifest.dependencies["@opencode-ai/plugin"]).toBeUndefined()
    expect(result.report.leftovers).toHaveLength(1)
    expect(result.report.leftovers[0]?.v2).toContain("session.hook('prompt')")
  })

  test("refuses to re-convert an already converted module", async () => {
    const first = await convertPlugin(fixture, { outDir: path.join(root, "one") })
    await expect(convertPlugin(first.outDir, { outDir: path.join(root, "two") })).rejects.toThrow(
      /already targets the OpenCode V2 plugin API/,
    )
  })
})

describe("whole package", () => {
  const mixed = path.join(import.meta.dir, "..", "fixtures", "mixed")

  test("rewrites every V1 import and generates a shim", async () => {
    const result = await convertPlugin(mixed, { outDir: path.join(root, "mixed") })
    expect(result.report.package?.remainingV1Imports).toEqual([])
    expect([...(result.report.package?.rewrittenFiles ?? [])].sort()).toEqual(["tools.ts", "types.ts"])
    expect(result.report.package?.dependencySwapped).toBe(true)
    expect(result.report.package?.shim).toBe("__opencode_v1_shim.ts")
    const mixedManifest = await Bun.file(path.join(result.outDir, "package.json")).json()
    expect(mixedManifest.dependencies.zod).toStartWith("^4")
    expect(result.report.typecheck?.clean).toBe(true)
    expect(countV1ImportFiles(result.outDir)).toBe(0)

    const shim = await Bun.file(path.join(result.outDir, "__opencode_v1_shim.ts")).text()
    expect(shim).toContain("export const tool")
    expect(shim).toContain("export type ToolContext")
    expect(shim).toContain("export type Plugin")
  })

  test("keeps the V1 dependency when a file cannot be rewritten", async () => {
    const result = await convertPlugin(path.join(import.meta.dir, "..", "fixtures", "namespace"), {
      outDir: path.join(root, "namespace"),
    })
    expect(result.report.package?.remainingV1Imports).toEqual(["tools.ts"])
    expect(result.report.package?.dependencySwapped).toBe(false)
    const manifest = await Bun.file(path.join(result.outDir, "package.json")).json()
    expect(manifest.dependencies["@opencode-ai/plugin"]).toBe("^1.18.0")
    expect(manifest.dependencies["@opencode/plugin"]).toBeUndefined()
  })
})

describe("custom tools", () => {
  const toolsFixture = path.join(import.meta.dir, "..", "fixtures", "tools")

  test("classifies inline and referenced tools as convertible", async () => {
    const { report } = await analyzePlugin(toolsFixture)
    expect(report.tools.map((tool) => tool.name).sort()).toEqual(["inline", "referenced"])
    expect(report.toolCounts).toEqual({ converted: 2, review: 0 })
  })

  test("registers both through ctx.tool.transform with JSON Schema", async () => {
    const result = await convertPlugin(toolsFixture, { outDir: path.join(root, "tools") })
    expect(result.report.toolCounts).toEqual({ converted: 2, review: 0 })
    expect([...result.module.tools].sort()).toEqual(["inline", "referenced"])
    expect(result.module.source).toContain("__z.toJSONSchema")
    expect(result.module.source).toContain("editor.add({")
    expect(result.module.source).toContain("const tool = Object.assign")
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.report.package?.remainingV1Imports).toEqual([])
  })
})

describe("pipeline platform", () => {
  test("rejects a stage whose output violates its schema", async () => {
    const bad = pipeline<{ n: number }>()
      .pipe(
        stage({
          name: "bad",
          input: z.object({ n: z.number() }),
          output: z.object({ n: z.string() }),
          run: async () => ({ n: 1 }) as unknown as { n: string },
        }),
      )
      .build()
    await expect(
      bad.run({ n: 1 }, { root: process.cwd(), outDir: root, log: () => {} }),
    ).rejects.toThrow(/invalid output/)
  })
})
