import { describe, expect, test } from "bun:test"
import path from "node:path"
import { analyzePlugin, convertPlugin } from "../src/api"
import { HOOK_RULES } from "../src/rules/hooks"
import { pipeline, stage } from "../src/core/pipeline"
import { z } from "zod"

const fixture = path.join(import.meta.dir, "fixtures", "basic")
const root = path.join(import.meta.dir, ".tmp")

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
    expect(report.counts).toEqual({ converted: 3, review: 1, unsupported: 0 })
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
    await expect(analyzePlugin(path.join(import.meta.dir, "fixtures", "already-v2"))).rejects.toThrow(
      /already targets the OpenCode V2 plugin API/,
    )
  })
})

describe("convert", () => {
  test("emits a compiling V2 module and keeps unconverted bodies", async () => {
    const result = await convertPlugin(fixture, { outDir: path.join(root, "out") })
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.module.emitted.sort()).toEqual(["dispose", "event", "tool.execute.before"])
    expect(result.module.skipped).toEqual(["chat.message"])
    expect(result.module.source).toContain("Plugin.define")
    expect(result.module.source).toContain("export default BasicPlugin")
    expect(result.module.source).toContain("#region carried-v1")
    expect(result.module.source).toContain("Not converted automatically")
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
