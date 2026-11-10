/**
 * Real V1 plugins used as the migration benchmark. Commits are pinned so results are
 * reproducible; `benchmarks/run.ts --fetch` clones them into benchmarks/corpus.
 */
export interface ExpectedCounts {
  readonly hooks?: number
  readonly converted?: number
  readonly review?: number
  readonly unsupported?: number
  readonly tools?: number
  readonly toolsConverted?: number
  readonly v1After?: number
  readonly runtime?: "ok" | "known-failure"
}

export interface CorpusEntry {
  readonly name: string
  /** Repository, or empty when `local` points inside this repository. */
  readonly repo: string
  readonly commit: string
  readonly license: string
  readonly note: string
  /** Local fixture directory, relative to the repository root. */
  readonly local?: string
  readonly expect?: ExpectedCounts
  /** Set when the upstream checkout cannot bundle for reasons unrelated to migration. */
  readonly knownRuntimeFailure?: string
}

export const CORPUS: readonly CorpusEntry[] = [
  {
    name: "openslimedit",
    repo: "ASidorenkoCode/openslimedit",
    commit: "d5014929d6f66729b887df74a65ed6d22c3b522b",
    license: "MIT",
    note: "tool.definition + tool.execute.before/after; pure V1",
    expect: { hooks: 3, converted: 3, review: 0, unsupported: 0, v1After: 0, runtime: "ok" },
  },
  {
    name: "opencode-smartsnip",
    repo: "carson2222/opencode-smartsnip",
    commit: "e08bbcc8edd1bed67d4ec5ed7a08a6d3aac9f140",
    license: "MIT",
    note: "shell rewriting plus an event consumer",
    expect: { hooks: 2, converted: 2, review: 0, unsupported: 0, v1After: 0, runtime: "ok" },
  },
  {
    name: "opencode-notify",
    repo: "kdcokenny/opencode-notify",
    commit: "6f430555495fa788347591c53c6770090a479211",
    license: "MIT",
    note: "single PluginInput parameter, long-lived intervals, event fan-out",
    knownRuntimeFailure:
      "upstream git checkout omits generated src/notify/status and src/notify/title modules, so it cannot bundle",
    expect: {
      hooks: 2,
      converted: 2,
      review: 0,
      unsupported: 0,
      v1After: 0,
      runtime: "known-failure",
    },
  },
  {
    name: "opencode-request-logger",
    repo: "Opencode-DCP/opencode-request-logger",
    commit: "ecb14d7215589aad5efbe811ad9327b53d35fef4",
    license: "MIT",
    note: "chat.params only; nothing mechanically convertible",
    expect: { hooks: 1, converted: 1, review: 0, unsupported: 0, v1After: 0, runtime: "ok" },
  },
  {
    name: "opencode-message-notify",
    repo: "Decade-qiu/opencode-message-notify",
    commit: "413b149a1db13630985ca2fbd6ccb3437b0826c6",
    license: "MIT",
    note: "event consumer plus permission.ask",
    expect: { hooks: 2, converted: 2, review: 0, unsupported: 0, v1After: 0, runtime: "ok" },
  },
  {
    name: "opencode-smart-voice-notify",
    repo: "MasuRii/opencode-smart-voice-notify",
    commit: "eb22712f18ecccb0bdf25ddb90c3d98615f88f30",
    license: "MIT",
    note: "one PluginInput parameter, conditional early return, dispose, intervals",
    expect: { hooks: 2, converted: 2, review: 0, unsupported: 0, v1After: 0, runtime: "ok" },
  },
  {
    name: "OpenCode-Image-Router-Plugin",
    repo: "adrivansoft/OpenCode-Image-Router-Plugin",
    commit: "0aec547ef3611540c2ddc31bec1196ad6719add0",
    license: "MIT",
    note: "JavaScript entry; chat.message mutates message.model and stays in review",
    expect: { hooks: 1, converted: 0, review: 1, unsupported: 0, v1After: 0, runtime: "ok" },
  },
  {
    name: "inline-tools",
    repo: "",
    commit: "",
    license: "MIT",
    note: "local fixture with one inline tool() and one referenced tool",
    local: "test/fixtures/tools",
    expect: {
      hooks: 0,
      converted: 0,
      review: 0,
      unsupported: 0,
      tools: 2,
      toolsConverted: 2,
      v1After: 0,
      runtime: "ok",
    },
  },
  {
    name: "opencode-auto-resume",
    repo: "Mte90/opencode-auto-resume",
    commit: "1a2ab4ab69da5754f29bcf15b9c33dea4d0687b7",
    license: "GPL-3.0-or-later",
    note: "dual-shape default export, multi-file tool package",
    expect: {
      hooks: 6,
      converted: 4,
      review: 1,
      unsupported: 1,
      tools: 1,
      toolsConverted: 1,
      v1After: 0,
      runtime: "ok",
    },
  },
  {
    name: "opencode-pty",
    repo: "shekohex/opencode-pty",
    commit: "b6c2067f1fb29d5fd3b2e744a7c05d7df1a6e7c1",
    license: "MIT",
    note: "Zod custom tools, command hook, config hook, event hook",
    expect: {
      hooks: 3,
      converted: 2,
      review: 0,
      unsupported: 1,
      tools: 5,
      toolsConverted: 5,
      v1After: 0,
      runtime: "ok",
    },
  },
]
