/**
 * Real V1 plugins used as the migration benchmark. Commits are pinned so results are
 * reproducible; `benchmarks/run.ts --fetch` clones them into benchmarks/corpus.
 */
export interface CorpusEntry {
  readonly name: string
  readonly repo: string
  readonly commit: string
  readonly license: string
  readonly note: string
}

export const CORPUS: readonly CorpusEntry[] = [
  {
    name: "openslimedit",
    repo: "ASidorenkoCode/openslimedit",
    commit: "d5014929d6f66729b887df74a65ed6d22c3b522b",
    license: "MIT",
    note: "tool.definition + tool.execute.before/after; pure V1",
  },
  {
    name: "opencode-smartsnip",
    repo: "carson2222/opencode-smartsnip",
    commit: "e08bbcc8edd1bed67d4ec5ed7a08a6d3aac9f140",
    license: "MIT",
    note: "shell rewriting plus an event consumer",
  },
  {
    name: "opencode-notify",
    repo: "kdcokenny/opencode-notify",
    commit: "6f43055",
    license: "MIT",
    note: "single PluginInput parameter, long-lived intervals, event fan-out",
  },
  {
    name: "opencode-request-logger",
    repo: "Opencode-DCP/opencode-request-logger",
    commit: "ecb14d7",
    license: "MIT",
    note: "chat.params only; nothing mechanically convertible",
  },
  {
    name: "opencode-message-notify",
    repo: "Decade-qiu/opencode-message-notify",
    commit: "413b149a1db13630985ca2fbd6ccb3437b0826c6",
    license: "MIT",
    note: "event consumer plus permission.ask",
  },
  {
    name: "opencode-smart-voice-notify",
    repo: "MasuRii/opencode-smart-voice-notify",
    commit: "eb22712f18ecccb0bdf25ddb90c3d98615f88f30",
    license: "MIT",
    note: "one PluginInput parameter, conditional early return, dispose, intervals",
  },
  {
    name: "opencode-pty",
    repo: "shekohex/opencode-pty",
    commit: "b6c2067",
    license: "MIT",
    note: "Zod custom tools, command hook, config hook, event hook",
  },
]
