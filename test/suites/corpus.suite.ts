/**
 * The benchmark is a test too: real public V1 plugins must convert to modules that
 * typecheck against @opencode/plugin. Skipped when benchmarks/corpus is absent
 * (it is gitignored; `bun benchmarks/run.ts --fetch` populates it).
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { analyzePlugin, convertPlugin } from "../../src/api"
import { CORPUS } from "../../benchmarks/manifest"

const corpus = path.join(import.meta.dir, "..", "..", "benchmarks", "corpus")
const available = CORPUS.filter((entry) => fs.existsSync(path.join(corpus, entry.name)))

describe.skipIf(available.length === 0)("real plugins", () => {
  for (const entry of available) {
    test(`${entry.name}: converts to a typechecking V2 module`, async () => {
      const { report } = await convertPlugin(path.join(corpus, entry.name), {
        outDir: path.join(import.meta.dir, ".tmp", "corpus"),
      })
      expect(report.hooks.length).toBeGreaterThan(0)
      expect(report.typecheck?.clean).toBe(true)
    })
  }

  test("the corpus covers mechanical and judgement-call hooks", async () => {
    const reports = await Promise.all(
      available.map((entry) => analyzePlugin(path.join(corpus, entry.name))),
    )
    const names = new Set(reports.flatMap(({ report }) => report.hooks.map((hook) => hook.name)))
    expect(names.has("tool.execute.before")).toBe(true)
    expect(names.has("event")).toBe(true)
    expect(names.has("chat.params") || names.has("config") || names.has("tool")).toBe(true)
  })
})
