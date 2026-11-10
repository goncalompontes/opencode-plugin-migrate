# opencode-plugin-migrate

Convert OpenCode **V1** plugins (`@opencode-ai/plugin`) to **V2** plugins (`@opencode/plugin`) using a typed AST pass, then prove the result compiles.

V1 plugins do not load in V2: the entrypoint, context, hook signatures, and tool schema all changed. This tool does the mechanical part, preserves every body it touches byte-for-byte, and reports the parts that need a human decision instead of dropping them silently.

```sh
bun run src/cli/index.ts analyze ./my-plugin     # report only, writes nothing
bun run src/cli/index.ts convert ./my-plugin     # emit + typecheck against @opencode/plugin
```

**Status: MVP.** Across 7 real public plugins: 12/15 hooks converted, **5/5 custom tools registered**, **V1 client calls routed through a generated facade**, every generated module typechecks and bundles, and **all 7 packages end with zero `@opencode-ai/plugin` imports** — including `opencode-pty`, whose factory pulls tools from 8 other files. See [benchmarks/RESULTS.md](benchmarks/RESULTS.md).

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

Alongside it, every other source file that imported `@opencode-ai/plugin` is redirected to a generated `__opencode_v1_shim.ts` (a typed `tool()` + type surface backed by Zod), `package.json` moves from `@opencode-ai/plugin` to `@opencode/plugin` (plus `zod` when the shim is used), and:

- `MIGRATION.md` — per-hook status, V2 destination, diagnostics, and the original body of everything that was not converted.
- `migration-report.json` — the same, machine-readable.
- `MIGRATION.md` includes a **manual porting queue** so the remaining work is explicit.

## How it works

```
resolve entry ──► extract IR ──► classify ──► emit V2 ──► typecheck ──► bundle/entry ──► report
   (package.json,      (ts-morph,    (exhaustive   (adapters,    (TypeScript    (Bun.build with
    tsconfig,           type checker) hook table)   verbatim       program vs     packages external,
    re-export scan)                                bodies)        @opencode/plugin)  entry shape check)
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
| **Converted** | `dispose`, `event`, `tool.execute.before`, `tool.execute.after`, `tool.definition`, `shell.env`, `permission.ask`, custom `tool` maps |
| **Review** (reported, body preserved) | `chat.message`, `chat.params`, `chat.headers`, `config`, `provider`, `auth`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `experimental.session.compacting` |
| **Unsupported** (no V2 equivalent) | `command.execute.before` (no global hook), `experimental.provider.small_model`, `experimental.compaction.autocontinue`, `experimental.text.complete` |

The table is `Record<keyof Hooks, Rule>` over the V1 package's own type: adding a hook to V1 makes the tool fail to compile until it is classified. See `src/rules/hooks.ts`.

## V1 client compatibility

V1 plugins call `client.<domain>.<method>({ path, body })` and read `{ data }`. V2
exposes flat domain methods on the context with no envelope. The emitter generates a
facade that preserves the V1 call shape:

| V1 call | V2 destination |
| --- | --- |
| `session.get({ path: { id } })` | `session.get({ sessionID })` + `{ data }` |
| `session.list({ query })` | `session.list(query)` + `{ data }` |
| `session.messages({ path: { id } })` | `session.context({ sessionID })` + `{ data }` |
| `session.abort({ path: { id } })` | `session.interrupt({ sessionID })` + `{ data }` |
| `session.summarize({ path: { id } })` | `session.compact({ sessionID })` + `{ data }` |
| `tool.ids()` | `tool.list().map(tool => tool.id)` + `{ data }` |
| `app.log({ body })` | `console.log(body.message)` |
| `tui.showToast({ body })` | logged, because V2 server plugins have no TUI (reported as adapted) |

`session.prompt`/`promptAsync`/`command`/`status` and `config.get` have no compatible
V2 shape; the facade throws a descriptive error and the report marks them **unmapped**
instead of silently changing behaviour.

## Benchmarks

Seven public V1 plugins at pinned commits, converted and typechecked:

| Plugin | Hooks | Converted | Review | Unsupported | Tools | Typecheck | Runtime | V1 imports |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| [openslimedit](https://github.com/ASidorenkoCode/openslimedit) | 3 | 3 | 0 | 0 | 0/0 | clean | ok | 1 -> 0 |
| [opencode-smartsnip](https://github.com/carson2222/opencode-smartsnip) | 2 | 2 | 0 | 0 | 0/0 | clean | ok | 1 -> 0 |
| [opencode-notify](https://github.com/kdcokenny/opencode-notify) | 2 | 2 | 0 | 0 | 0/0 | clean | known upstream failure | 1 -> 0 |
| [opencode-request-logger](https://github.com/Opencode-DCP/opencode-request-logger) | 1 | 0 | 1 | 0 | 0/0 | clean | ok | 1 -> 0 |
| [opencode-message-notify](https://github.com/Decade-qiu/opencode-message-notify) | 2 | 2 | 0 | 0 | 0/0 | clean | ok | 1 -> 0 |
| [opencode-smart-voice-notify](https://github.com/MasuRii/opencode-smart-voice-notify) | 2 | 2 | 0 | 0 | 0/0 | clean | ok | 0 -> 0 |
| [opencode-pty](https://github.com/shekohex/opencode-pty) | 3 | 1 | 1 | 1 | 5/5 | clean | ok | 8 -> 0 |

`opencode-notify` is a known upstream failure: its git checkout omits two generated modules,
so it cannot bundle even before migration. The benchmark records that instead of hiding it.

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
- **Two gates.** The emitted module must typecheck against the real V2 types *and* bundle with `Bun.build` (relative imports, shim, entry shape).
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
bun test          # one entrypoint (test/migration.test.ts), 60s per-test budget
bun run bench
```

Both `analyze` and `convert` run a TypeScript program per plugin. The typechecker
shares parsed `lib.*.d.ts` / `@types` declarations across programs, and extraction
skips loading the standard library into ts-morph, which keeps a full 7-plugin
corpus run around 8 seconds instead of ~20.

Test suites live in `test/suites/` and are imported by the single
`test/migration.test.ts` entrypoint: Bun runs test *files* concurrently, and two
files each building TypeScript programs contend for CPU and trip timeouts.

## Known limits (deliberately reported, not hidden)

- Namespace/default imports and runtime subpath imports (e.g. `@opencode-ai/plugin/tui` values) cannot be represented by the shim; those files stay on V1, the report lists them, and `package.json` deliberately keeps the V1 dependency.
- Custom tools keep their Zod shape at runtime and are registered through `z.toJSONSchema()`; plugins still on Zod 3 need a Zod 4 upgrade.
- V1 `client` calls are adapted, not rewritten: mapped methods preserve the `{ data }` envelope, adapted methods are reported, and unmapped methods throw at the call site so the gap is visible.
- `chat.params` / `chat.message` split into different V2 hooks with different event shapes; static analysis can only propose a destination.
- `command.execute.before` has no one-to-one V2 hook; the correct destination depends on whether the plugin owns the command.
- The tool validates types, not behavior. A converted plugin still needs a smoke test in a real V2 session.
