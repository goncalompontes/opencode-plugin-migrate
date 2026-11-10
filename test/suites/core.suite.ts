import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { analyzePlugin, convertPlugin } from "../../src/api"
import { pipeline, stage } from "../../src/core/pipeline"
import { countV1ImportFiles } from "../../src/env/imports"
import { applyTarget, probeTarget } from "../../src/rules/compat"
import { HOOK_RULES } from "../../src/rules/hooks"
import { validateRuntime } from "../../src/validate/bundle"
import { runRepair } from "../../src/validate/repair"

const fixture = path.join(import.meta.dir, "..", "fixtures", "basic")
const root = path.join(import.meta.dir, "..", ".tmp")
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })

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
    expect(byName.event).toBe("converted")
    expect(byName.dispose).toBe("converted")
    expect(byName["chat.message"]).toBe("converted")
    expect(byName["chat.params"]).toBe("converted")
    expect(byName["chat.headers"]).toBe("converted")
    expect(report.counts).toEqual({ converted: 8, review: 0, unsupported: 0 })
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
    await expect(
      analyzePlugin(path.join(import.meta.dir, "..", "fixtures", "already-v2")),
    ).rejects.toThrow(/already targets the OpenCode V2 plugin API/)
  })
})

describe("convert", () => {
  test("emits a compiling V2 module and keeps unconverted bodies", async () => {
    const result = await convertPlugin(fixture, { outDir: path.join(root, "out") })
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.report.runtime?.bundle.ok).toBe(true)
    expect(result.report.runtime?.entry.ok).toBe(true)
    expect(result.module.emitted.sort()).toEqual([
      "chat.headers",
      "chat.message",
      "chat.params",
      "dispose",
      "event",
      "experimental.chat.system.transform",
      "permission.ask",
      "tool.execute.before",
    ])
    expect(result.module.skipped).toEqual([])
    expect(result.module.source).toContain("Plugin.define")
    expect(result.module.source).toContain("export default BasicPlugin")
    expect(result.module.source).toContain("#region carried-v1")
    expect(result.module.source).not.toContain("Not converted automatically")
    const manifest = await Bun.file(path.join(result.outDir, "package.json")).json()
    expect(manifest.dependencies["@opencode/plugin"]).toStartWith("^2")
    expect(manifest.dependencies["@opencode-ai/plugin"]).toBeUndefined()
    expect(result.report.leftovers).toHaveLength(0)
    expect(result.module.source).toContain('hook("prompt"')
    expect(result.module.source).toContain('hook("context"')
    expect(result.module.source).toContain('hook("model.request"')
    expect(result.module.source).toContain("__originalSystem")
    expect(result.module.source).toContain('type: "text"')
  })

  test("treats an already converted module as a no-op", async () => {
    const first = await convertPlugin(fixture, { outDir: path.join(root, "one") })
    const second = await convertPlugin(first.outDir, { outDir: path.join(root, "two") })
    expect(second.report.counts.converted).toBe(0)
    expect(second.report.diagnostics.map((item) => item.code)).toContain("already/converted")
  })
})

describe("whole package", () => {
  const mixed = path.join(import.meta.dir, "..", "fixtures", "mixed")

  test("rewrites every V1 import and generates a shim", async () => {
    const result = await convertPlugin(mixed, { outDir: path.join(root, "mixed") })
    expect(result.report.package?.remainingV1Imports).toEqual([])
    expect([...(result.report.package?.rewrittenFiles ?? [])].sort()).toEqual([
      "tools.ts",
      "types.ts",
    ])
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

describe("V1 client facade", () => {
  const clientFixture = path.join(import.meta.dir, "..", "fixtures", "client")

  test("routes V1 calls through a typed facade and reports adapted methods", async () => {
    const result = await convertPlugin(clientFixture, { outDir: path.join(root, "client") })
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.module.source).toContain("v1-client-facade")
    expect(result.module.source).toContain("__clientEnvelope")
    const codes = result.report.diagnostics.map((item) => item.code)
    expect(codes).toContain("client/facade")
    expect(codes).toContain("client/adapted")
  })
})

describe("runtime validation", () => {
  test("rejects a module with an unresolved relative import", async () => {
    const dir = path.join(root, "broken-bundle")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "entry.ts")
    await Bun.write(file, 'import "./missing"\nexport default 1\n')
    const result = await validateRuntime(file)
    expect(result.bundle.ok).toBe(false)
    expect(result.bundle.errors.length).toBeGreaterThan(0)
  })

  test("rejects a module without a V2 entry shape", async () => {
    const dir = path.join(root, "no-entry")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "entry.ts")
    await Bun.write(file, "export const value = 1\n")
    const result = await validateRuntime(file)
    expect(result.entry.ok).toBe(false)
  })
})

describe("config command transform", () => {
  const configFixture = path.join(import.meta.dir, "..", "fixtures", "config")

  test("converts a command-only config hook and reports template limits", async () => {
    const result = await convertPlugin(configFixture, { outDir: path.join(root, "config") })
    expect(result.report.counts.converted).toBe(1)
    expect(result.module.source).toContain("command.transform")
    expect(result.module.source).toContain("new Proxy")
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.report.diagnostics.some((item) => item.code === "config/command-template")).toBe(
      true,
    )
  })
})

describe("conditional hook maps", () => {
  const conditional = path.join(import.meta.dir, "..", "fixtures", "conditional")

  test("emits branch-aware registrations", async () => {
    const { report } = await analyzePlugin(conditional)
    expect(report.hooks.map((hook) => hook.name).sort()).toEqual(["event", "tool.execute.before"])
    const result = await convertPlugin(conditional, { outDir: path.join(root, "conditional") })
    expect(result.module.source).toContain("if (!enabled) {")
    expect(result.module.source).toContain("else {")
    expect(result.module.source).toContain('hook("execute.before"')
    expect(result.module.source).toContain("event.subscribe")
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.report.runtime?.bundle.ok).toBe(true)
  })
})

describe("incremental conversion", () => {
  test("is byte-identical when nothing changed", async () => {
    const outDir = path.join(root, "incremental")
    const first = await convertPlugin(fixture, { outDir })
    const file = path.join(first.outDir, "index.ts")
    const before = await Bun.file(file).text()
    await convertPlugin(fixture, { outDir })
    expect(await Bun.file(file).text()).toBe(before)
  })

  test("preserves manual edits and reports conflicts", async () => {
    const source = path.join(root, "incremental-source")
    fs.rmSync(source, { recursive: true, force: true })
    fs.cpSync(fixture, source, { recursive: true })
    const outDir = path.join(root, "incremental-edit")
    const first = await convertPlugin(source, { outDir })
    const file = path.join(first.outDir, "index.ts")
    const edited = (await Bun.file(file).text()).replace(
      "#region carried-v1 tool.execute.before",
      "#region carried-v1 tool.execute.before\n        // manual note",
    )
    await Bun.write(file, edited)

    const second = await convertPlugin(source, { outDir })
    expect(second.module.source).toContain("// manual note")
    expect(second.report.diagnostics.map((item) => item.code)).toContain("incremental/preserved")

    // Change the V1 source too: this becomes a conflict, and the manual body wins.
    const v1 = path.join(source, "index.ts")
    const text = await Bun.file(v1).text()
    await Bun.write(
      v1,
      text.replace("blocked in ${directory}", "blocked by policy in ${directory}"),
    )
    const third = await convertPlugin(source, { outDir })
    expect(third.report.diagnostics.map((item) => item.code)).toContain("incremental/conflict")
    expect(third.module.source).toContain("// manual note")
  })
})

describe("scaffolding", () => {
  const scaffold = path.join(import.meta.dir, "..", "fixtures", "scaffold")

  test("normalizes config, plans layout moves, and detects TUI plugins", async () => {
    const result = await convertPlugin(scaffold, { outDir: path.join(root, "scaffold") })
    const config = await Bun.file(path.join(result.outDir, "opencode.json")).json()
    expect(config.plugin).toBeUndefined()
    expect(config.plugins).toEqual(["pkg-a", { package: "./local", options: { enabled: true } }])
    const codes = result.report.diagnostics.map((item) => item.code)
    expect(codes).toContain("config/plugins")
    expect(codes).toContain("layout/plugin-directory")
    expect(codes).toContain("tui/detected")
    expect(result.report.scaffolding?.length).toBeGreaterThanOrEqual(3)
  })

  test("emits a dual V1/V2 entrypoint on request", async () => {
    const result = await convertPlugin(fixture, {
      outDir: path.join(root, "dual"),
      dual: true,
    })
    expect(result.module.source).toContain("const __v1")
    expect(result.module.source).toContain("server: __v1")
    expect(result.module.source).toContain("Plugin.define")
    expect(result.report.runtime?.bundle.ok).toBe(true)
    expect(result.report.typecheck?.clean).toBe(true)
  })
})

describe("JavaScript sources", () => {
  const jsFixture = path.join(import.meta.dir, "..", "fixtures", "js")

  test("converts a .mjs entry to a typechecking .ts module", async () => {
    const result = await convertPlugin(jsFixture, { outDir: path.join(root, "js") })
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.report.runtime?.bundle.ok).toBe(true)
    const codes = result.report.diagnostics.map((item) => item.code)
    expect(codes).toContain("js/entry")
    expect(codes).toContain("js/emitted")
    expect(fs.existsSync(path.join(result.outDir, "index.ts"))).toBe(true)
    expect(fs.existsSync(path.join(result.outDir, "index.mjs"))).toBe(false)
    const manifest = await Bun.file(path.join(result.outDir, "package.json")).json()
    expect(manifest.main).toBe("./index.ts")
  })
})

describe("auto-repair", () => {
  test("adds type annotations to carried parameters across passes", async () => {
    const result = await convertPlugin(path.join(import.meta.dir, "..", "fixtures", "repair"), {
      outDir: path.join(root, "repair"),
    })
    expect(result.report.repair?.passes).toBe(2)
    expect(result.report.repair?.fixes).toHaveLength(2)
    expect(result.report.repair?.stopped).toBe("clean")
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.module.source).toContain("value: any")
  })

  test("stops when a fixer cannot make progress", async () => {
    const dir = path.join(root, "repair-unit")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "entry.ts")
    await Bun.write(file, "const a = 1\n")
    const check = (): Array<{
      code: string
      severity: "error"
      message: string
      range: { file: string; start: number; end: number; line: number; column: number }
    }> => [
      {
        code: "ts/7006",
        severity: "error",
        message: "Parameter 'a' implicitly has an 'any' type.",
        range: { file, start: 6, end: 7, line: 1, column: 7 },
      },
    ]
    const outcome = runRepair({
      file,
      projectRoot: dir,
      owned: [file],
      check,
      fixers: [{ id: "noop", codes: ["ts/7006"], apply: () => null }],
    })
    expect(outcome.result.stopped).toBe("no-fix")
    expect(outcome.result.passes).toBe(0)
  })
})

describe("target compatibility", () => {
  test("probes the installed @opencode/plugin capabilities", async () => {
    const target = probeTarget(process.cwd())
    expect(target.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(target.capabilities).toContain("plugin.define")
    expect(target.capabilities).toContain("session.hook.prompt")
    expect(target.capabilities).toContain("tool.hook")
  })

  test("downgrades rules whose capability is missing", async () => {
    const { ir } = await analyzePlugin(fixture)
    expect(ir.target).toBeDefined()
    const fake = {
      ...ir.target!,
      capabilities: ir.target!.capabilities.filter((name) => name !== "session.hook.prompt"),
      missing: [...ir.target!.missing, "session.hook.prompt"],
    } as Parameters<typeof applyTarget>[1]
    const downgraded = applyTarget({ ...ir, target: fake }, fake)
    const chat = downgraded.hooks.find((hook) => hook.name === "chat.message")
    expect(chat?.classification).toBe("review")
    expect(chat?.reason).toContain("does not expose")
  })

  test("warns when --target differs from the installed version", async () => {
    const { report } = await analyzePlugin(fixture, { target: "9.9.9" })
    expect(report.target?.version).not.toBe("9.9.9")
    expect(report.diagnostics.some((item) => item.code === "target/override")).toBe(true)
  })
})

describe("provider and auth hooks", () => {
  const provider = path.join(import.meta.dir, "..", "fixtures", "provider")

  test("registers provider models and reports auth for manual porting", async () => {
    const result = await convertPlugin(provider, { outDir: path.join(root, "provider") })
    expect(result.module.providers).toEqual(["custom"])
    expect(result.module.source).toContain("provider.transform")
    expect(result.module.source).toContain("editor.models.set")
    expect(result.module.auths).toEqual(["custom"])
    expect(result.module.source).toContain("integration.transform")
    expect(result.report.diagnostics.map((item) => item.code)).toContain("provider/registration")
    expect(result.report.diagnostics.map((item) => item.code)).toContain("auth/registration")
    expect(result.report.typecheck?.clean).toBe(true)
    expect(result.report.runtime?.bundle.ok).toBe(true)
  })
})

describe("golden output", () => {
  const cases = [
    ["basic", path.join(import.meta.dir, "..", "fixtures", "basic")],
    ["tools", path.join(import.meta.dir, "..", "fixtures", "tools")],
    ["conditional", path.join(import.meta.dir, "..", "fixtures", "conditional")],
  ] as const
  for (const [name, dir] of cases) {
    test(`emits the ${name} module`, async () => {
      const result = await convertPlugin(dir, { outDir: path.join(root, `golden-${name}`) })
      expect(result.module.source).toMatchSnapshot(name)
    })
  }
})

describe("negative inputs", () => {
  test("rejects syntax errors", async () => {
    await expect(
      analyzePlugin(path.join(import.meta.dir, "..", "fixtures", "broken")),
    ).rejects.toThrow(/syntax errors/)
  })

  test("rejects a file with no plugin factory", async () => {
    await expect(
      analyzePlugin(path.join(import.meta.dir, "..", "fixtures", "no-factory")),
    ).rejects.toThrow(/no V1 plugin factory/)
  })

  test("warns when a package imports both plugin APIs", async () => {
    const { report } = await analyzePlugin(path.join(import.meta.dir, "..", "fixtures", "mixed-v2"))
    expect(report.diagnostics.map((item) => item.code)).toContain("entry/mixed")
  })

  test("reports hooks with no V2 destination as unsupported", async () => {
    const { report } = await analyzePlugin(
      path.join(import.meta.dir, "..", "fixtures", "unsupported"),
    )
    expect(report.counts.unsupported).toBe(2)
    expect(report.leftovers).toHaveLength(2)
    expect(report.leftovers.every((item) => item.v2 === "none" || item.v2.includes("prompt"))).toBe(
      true,
    )
  })
})

describe("OpenCode plugin entrypoint", () => {
  test("exports a V2 plugin definition and resolves the bundled skill", async () => {
    const plugin = (await import("../../src/plugin/index")).default
    expect(plugin.id).toBe("opencode-plugin-migrate")
    expect(typeof plugin.setup).toBe("function")
    const { findSkillSource } = await import("../../src/cli/skill")
    expect(findSkillSource()?.endsWith(path.join("skills", "opencode-plugin-migrate"))).toBe(true)
  })
})

describe("CLI", () => {
  const repo = path.join(import.meta.dir, "..", "..")
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", "src/cli/index.ts", ...args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    })

  test("help lists the conversion flags", () => {
    const result = run("convert", "--help")
    const output = result.stdout.toString()
    expect(output).toContain("--dry-run")
    expect(output).toContain("--check")
    expect(output).toContain("--format")
    expect(output).toContain("--quiet")
  })

  test("install-skill copies the bundled skill", () => {
    const skills = path.join(root, "skills-install")
    const result = run("install-skill", "--dir", skills, "--force")
    expect(result.exitCode).toBe(0)
    expect(fs.existsSync(path.join(skills, "opencode-plugin-migrate", "SKILL.md"))).toBe(true)
    expect(
      fs.existsSync(path.join(skills, "opencode-plugin-migrate", "references", "report-fields.md")),
    ).toBe(true)
  })

  test("--check exits 1 for review findings and 0 for a clean conversion", () => {
    const clean = run(
      "convert",
      path.join(import.meta.dir, "..", "fixtures", "basic"),
      "--check",
      "--quiet",
    )
    expect(clean.exitCode).toBe(0)
    const review = run(
      "convert",
      path.join(import.meta.dir, "..", "fixtures", "review"),
      "--check",
      "--quiet",
    )
    expect(review.exitCode).toBe(1)
  })

  test("--dry-run writes nothing", () => {
    const dryRunDir = path.join(repo, ".migrate", ".dry-run")
    fs.rmSync(dryRunDir, { recursive: true, force: true })
    const result = run(
      "convert",
      path.join(import.meta.dir, "..", "fixtures", "basic"),
      "--dry-run",
      "--format",
      "json",
    )
    expect(result.exitCode).toBe(0)
    expect(fs.existsSync(dryRunDir)).toBe(false)
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
