# opencode-plugin-migrate

Convert OpenCode **V1** plugins (`@opencode-ai/plugin`) to **V2** plugins (`@opencode/plugin`) using a typed AST pass, then prove the result compiles.

V1 plugins do not load in V2: the entrypoint, context, hook signatures, and tool schema all changed. This tool does the mechanical part, preserves every body it touches byte-for-byte, and reports the parts that need a human decision instead of dropping them silently.

```sh
bun run src/cli/index.ts analyze ./my-plugin     # report only, writes nothing
bun run src/cli/index.ts convert ./my-plugin     # emit + typecheck against @opencode/plugin
```

**Status: MVP.** 8 of 11 hooks across 5 real public plugins convert automatically, and every generated module typechecks. See [benchmarks/RESULTS.md](benchmarks/RESULTS.md).

## What it produces

`convert` writes a complete V2 module, not a patch:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "openslimedit",
  async setup(__opencode) {
    const directory = __opencode.location.directory
    // #region carried-v1
    function resolvePath(filePath: string): string {
      if (path.isAbsolute(filePath)) return path.resolve(directory, filePath)
      return path.normalize(filePath)
    }
    // #endregion carried-v1

    await __opencode.tool.hook("execute.before", async (event) => {
      const input: any = { tool: event.tool, sessionID: event.sessionID, callID: event.id }
      const output: any = { args: event.input }
      try {
        // #region carried-v1
        const args = output.args
        args.oldString = lines.slice(startLine - 1, endLine).join("\n")
        // #endregion carried-v1
      } finally {
        event.input = output.args
      }
    })
  },
})
```

Alongside it:

- `MIGRATION.md` — per-hook status, V2 destination, diagnostics, and the original body of everything that was not converted.
- `migration-report.json` — the same, machine-readable.
- `MIGRATION.md` includes a **manual porting queue** so the remaining work is explicit.

## How it works

```
resolve entry ──► extract IR ──► classify ──► emit V2 ──► typecheck ──► report
   (package.json,      (ts-morph,    (exhaustive   (adapters,    (TypeScript
    tsconfig,           type checker) hook table)   verbatim       program vs
    re-export scan)                                bodies)        @opencode/plugin)
```

The pipeline is a small typed platform (`src/core/pipeline.ts`): each stage declares a Zod schema for its output, the builder carries the output type into the next stage, and a stage that changes shape fails validation instead of feeding bad data forward. Stages are independently testable and observable (`onStage`).

### Why re-emit instead of rewriting in place

Unconvertible hooks are simply not emitted. The module still parses and typechecks, so a partial migration is still a working module, and the original body is preserved in the report instead of being commented into a syntax error.

### Why the typecheck is the gate

The V2 package ships complete `.d.ts`. After emitting, the tool builds a real TypeScript program rooted at the generated file, using the generated project's own imports and the installed `@opencode/plugin`. A hook is only marked `converted` when an adapter exists **and** the result has no scaffold errors.

Errors inside code carried over from V1 are downgraded to review findings with a hint, because they describe the old body, not the generated scaffolding. Missing third-party packages (and missing files that were already missing in the source repo) are warnings, not migration failures.

## Hook coverage

| Status | V1 hooks |
| --- | --- |
| **Converted** | `dispose`, `event`, `tool.execute.before`, `tool.execute.after`, `tool.definition`, `shell.env` |
| **Review** (reported, body preserved) | `chat.message`, `chat.params`, `chat.headers`, `config`, `provider`, `auth`, `permission.ask`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `experimental.session.compacting`, custom `tool` map |
| **Unsupported** (no V2 equivalent) | `command.execute.before` (no global hook), `experimental.provider.small_model`, `experimental.compaction.autocontinue`, `experimental.text.complete` |

The table is `Record<keyof Hooks, Rule>` over the V1 package's own type: adding a hook to V1 makes the tool fail to compile until it is classified. See `src/rules/hooks.ts`.

## Benchmarks

Five public V1 plugins at pinned commits, converted and typechecked:

| Plugin | Hooks | Converted | Review | Unsupported | Typecheck |
| --- | ---: | ---: | ---: | ---: | --- |
| [openslimedit](https://github.com/ASidorenkoCode/openslimedit) | 3 | 3 | 0 | 0 | clean |
| [opencode-smartsnip](https://github.com/carson2222/opencode-smartsnip) | 2 | 2 | 0 | 0 | clean |
| [opencode-notify](https://github.com/kdcokenny/opencode-notify) | 2 | 2 | 0 | 0 | clean |
| [opencode-request-logger](https://github.com/Opencode-DCP/opencode-request-logger) | 1 | 0 | 1 | 0 | clean |
| [opencode-pty](https://github.com/shekohex/opencode-pty) | 3 | 1 | 1 | 1 | clean |

Reproduce:

```sh
bun benchmarks/run.ts --fetch   # clones pinned commits into benchmarks/corpus
bun benchmarks/run.ts           # writes benchmarks/RESULTS.md, exits 1 on regressions
```

The benchmark is also a test (`test/corpus.test.ts`): every corpus plugin must produce a typechecking module.

## Safety model

- **Exhaustive rules.** Hook classification is total over `keyof Hooks`; unknown hooks fall back to `unsupported`, never to a guess.
- **Validated boundaries.** Every pipeline stage output is parsed with Zod before the next stage sees it.
- **Verbatim carry.** Bodies are moved as source text and marked `#region carried-v1`, so behavior is preserved and review is localized.
- **Complete output.** Skipped hooks never leave dangling syntax; the module is always whole.
- **No silent deletion.** Anything not emitted appears in the report with its original body and closest V2 API.
- **Already-V2 detection.** Pointing the tool at a V2 plugin fails with a clear message instead of producing nonsense.

## Repository layout

```
src/
  core/         typed pipeline + diagnostics
  env/          entrypoint resolution, package/tsconfig detection, project copy
  ir/           IR schema (Zod) and ts-morph extraction
  rules/        exhaustive V1 -> V2 hook table
  emit/         V2 module emitter and per-hook adapters
  validate/     TypeScript program + diagnostic mapping
  report/       report schema and Markdown renderer
  api.ts        analyze / convert pipelines
  cli/          CLI (citty)
benchmarks/     corpus manifest, runner, pinned results
test/           unit + corpus tests
DESIGN.md       design notes and known limits
```

## Development

```sh
bun install
bun run typecheck
bun test
bun run bench
```

## Known limits (deliberately reported, not hidden)

- Custom tools use Zod in V1 and JSON Schema in V2; the tool reports each tool and its Zod shape for manual porting.
- `ctx.client.*` calls are the second migration axis. They are bound to the V2 context as `any` so the module compiles, and flagged for porting to `ctx.session`, `ctx.permission`, and friends.
- `chat.params` / `chat.message` split into different V2 hooks with different event shapes; static analysis can only propose a destination.
- `command.execute.before` has no one-to-one V2 hook; the correct destination depends on whether the plugin owns the command.
- The tool validates types, not behavior. A converted plugin still needs a smoke test in a real V2 session.
