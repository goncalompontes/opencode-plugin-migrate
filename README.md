# opencode-plugin-migrate

Convert OpenCode **V1** plugins (`@opencode-ai/plugin`) to **V2** plugins (`@opencode/plugin`) using a typed AST pass, then prove the result compiles.

V1 plugins do not load in V2: the entrypoint, context, hook signatures, and tool schema all changed. This tool does the mechanical part, preserves every body it touches byte-for-byte, and reports the parts that need a human decision instead of dropping them silently.

```sh
bun run src/cli/index.ts analyze ./my-plugin     # report only, writes nothing
bun run src/cli/index.ts convert ./my-plugin     # emit + typecheck + bundle validation
bun run src/cli/index.ts convert ./my-plugin --dual   # also keep a V1 server() entrypoint
```

**Status: MVP.** Across 10 packages (8 public plugins, one `.mjs` entry, one local fixture): 18/22 hooks converted, **5/5 custom tools registered**, **V1 client calls routed through a generated facade**, every generated module typechecks and bundles, and **all 7 packages end with zero `@opencode-ai/plugin` imports** — including `opencode-pty`, whose factory pulls tools from 8 other files. See [benchmarks/RESULTS.md](benchmarks/RESULTS.md).

## Install

```sh
npm install -g opencode-plugin-migrate    # or: bun install -g opencode-plugin-migrate
opencode-plugin-migrate --help
```

The published CLI runs under Node 20+ and Bun. Bundle validation uses `Bun.build`; under
Node it is skipped and reported as `bundle skipped (Node)`. Type checking, conversion,
reports and repair work on both runtimes.

## Packaging

```sh
bun run build          # dist/index.js (library) + dist/cli.js (CLI, node shebang)
bun run smoke:pack     # build, pack, install the tarball in a temp project, run the CLI
```

The release workflow (`.github/workflows/release.yml`) bumps the version, runs tests and
the pack smoke test, tags `v<version>`, uploads the tarball to a GitHub release, and
publishes to npm when `NPM_TOKEN` is configured. MIT licensed.

## CLI

```sh
opencode-plugin-migrate analyze ./plugin --format md|json|both
opencode-plugin-migrate convert ./plugin [--out DIR] [--dual] [--target 2.2.7]
opencode-plugin-migrate convert ./plugin --dry-run      # full pipeline, prints the module
opencode-plugin-migrate convert ./plugin --check        # CI gate: non-zero on review/unsupported
opencode-plugin-migrate convert ./plugin --quiet        # exit code only
```

Exit codes: `0` success, `1` validation or `--check` findings, `2` usage error.
`--format both` prints machine-readable JSON followed by Markdown.

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
| **Converted** | `dispose`, `event`, `tool.execute.before`, `tool.execute.after`, `tool.definition`, `shell.env`, `permission.ask`, `chat.message`, `chat.params`, `chat.headers`, `experimental.chat.system.transform`, `config.command`, custom `tool` maps |
| **Review** (reported, body preserved) | `provider`, `auth`, other `config` domains, `experimental.chat.messages.transform`, `experimental.session.compacting` |
| **Unsupported** (no V2 equivalent) | `command.execute.before` (no global hook), `experimental.provider.small_model`, `experimental.compaction.autocontinue`, `experimental.text.complete` |

The table is `Record<keyof Hooks, Rule>` over the V1 package's own type: adding a hook to V1 makes the tool fail to compile until it is classified. See `src/rules/hooks.ts`.

## Conditional hook maps

Some V1 factories return an early hook map:

```ts
if (!enabled) return { event: async ({ event }) => { ... } }
return { "tool.execute.before": ... }
```

The converter models these conditions instead of flattening them:

- hooks from an early return are registered inside `if (<condition>) { ... }`, with the main map in `else`;
- early returns with no hooks are kept in `setup` as an early return, preserving the V1 behaviour;
- conditions that depend on statements inside the branch, or custom tools inside a conditional map, are reported rather than guessed;
- `--dual` keeps the V2 conditional registrations but registers only unconditional hooks in the reconstructed V1 `server()` (with a warning).

## Incremental re-runs

`convert` can run again on the same output:

- The generated module and `migration-state.json` record the base hash of every carried region.
- On a re-run, manual edits to a carried region are kept; if the V1 source changed too, the tool reports `incremental/conflict` and keeps the manual body for review.
- Re-running with no changes is byte-identical.
- `--force` regenerates from scratch and discards preserved edits.
- Pointing `convert` at an already-converted V2 package is a no-op (`already/converted`) instead of an error.

## Target compatibility

Rules are only valid for the target API they were checked against:

- On every run the tool probes the installed `@opencode/plugin` and records its version and capabilities (`session.hook("prompt")`, `tool.transform`, `command.transform`, ...).
- If the installed target lacks a capability an adapter needs, that hook is **downgraded to review** with the reason instead of emitting code that cannot load.
- `--target <version>` records an expected version and warns when it differs from the installed package; the report always names the version actually probed.
- CI has a `compat` matrix that probes `@opencode/plugin@2.2.7` and `2.1.4`.

## Auto-repair

Generated modules are checked, and fixable findings are repaired in bounded passes:

- diagnostics inside carried code are labelled with their origin hook (`#region carried-v1 <hook>`);
- a fixer registry is keyed by TypeScript error code;
- each pass applies one fix, re-checks, and stops on clean, no applicable fixer, repeated source, or max passes;
- fixers may only add annotations — never delete or comment out code. Anything left over stays in the report as a review finding.

Current fixers: missing parameter annotations (`TS7006`) inside carried V1 bodies. Unresolved errors remain visible with their hook origin.

## Providers and auth

- `provider` hooks convert to `ctx.provider.transform`: the V1 `models` function is resolved once at setup and its entries are installed with `editor.models.set(...)`.
- `auth` hooks are reported with the closest V2 surface (`ctx.integration.transform()` with typed forms/OAuth methods); they are not guessed because V2 integrations are structurally different.
- `config` supports `command` today; other domains are reported with the exact keys that were written.

## Scaffolding

Beyond the module, `convert` normalizes the package around it:

- **Config**: `opencode.json(c)` moves `plugin` to `plugins`, and tuples become `{ package, options }` objects (including local paths).
- **Layout**: reports the required moves from `.opencode/plugin/<x>.ts` and `.opencode/plugins/<x>.ts` to `.opencode/plugins/<x>/index.ts`. It plans rather than moves, because moving a file can break its relative imports.
- **TUI**: detects V1 TUI plugins (`@opencode-ai/plugin/tui`, `export const tui`) and tells you to port them separately, never mixing them into a server plugin.
- **Dual mode**: `--dual` emits both the V2 `Plugin.define({ id, setup })` default export and a V1 `server()` entrypoint reconstructed from the original hooks, for hosts on OpenCode >= 1.18.29.
- **Manifest**: swaps the authoring dependency and adds `zod` when the compatibility shim is used.

Every applied or proposed change is listed in the report's **Scaffolding** section.

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

Ten packages at pinned commits or local fixtures, converted and typechecked:

| Plugin | Hooks | Converted | Review | Unsupported | Tools | Typecheck | Runtime | V1 imports |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| [openslimedit](https://github.com/ASidorenkoCode/openslimedit) | 3 | 3 | 0 | 0 | 0/0 | clean | ok | 1 -> 0 |
| [opencode-smartsnip](https://github.com/carson2222/opencode-smartsnip) | 2 | 2 | 0 | 0 | 0/0 | clean | ok | 1 -> 0 |
| [opencode-notify](https://github.com/kdcokenny/opencode-notify) | 2 | 2 | 0 | 0 | 0/0 | clean | known upstream failure | 1 -> 0 |
| [opencode-request-logger](https://github.com/Opencode-DCP/opencode-request-logger) | 1 | 1 | 0 | 0 | 0/0 | clean | ok | 1 -> 0 |
| [opencode-message-notify](https://github.com/Decade-qiu/opencode-message-notify) | 2 | 2 | 0 | 0 | 0/0 | clean | ok | 1 -> 0 |
| [opencode-smart-voice-notify](https://github.com/MasuRii/opencode-smart-voice-notify) | 2 | 2 | 0 | 0 | 0/0 | clean | ok | 0 -> 0 |
| [OpenCode-Image-Router-Plugin](https://github.com/adrivansoft/OpenCode-Image-Router-Plugin) | 1 | 0 | 1 | 0 | 0/0 | clean | ok | 0 -> 0 |
| inline-tools (local fixture) | 0 | 0 | 0 | 0 | 2/2 | clean | ok | 2 -> 0 |
| [opencode-auto-resume](https://github.com/Mte90/opencode-auto-resume) | 6 | 4 | 1 | 1 | 1/1 | clean | ok | 1 -> 0 |
| [opencode-pty](https://github.com/shekohex/opencode-pty) | 3 | 2 | 0 | 1 | 5/5 | clean | ok | 8 -> 0 |

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
bun run lint              # Biome
bun run typecheck
bun test                  # one entrypoint (test/migration.test.ts), 60s per-test budget
bun run coverage:check    # floors for src/rules and src/emit
bun run build             # dist/library + dist/cli.js
bun run smoke:pack        # packed-tarball install smoke test
bun run bench
```

CI runs Biome, typecheck, tests and the Node CLI on Bun `1.4.4` and `latest`; coverage
floors; the pack smoke test on Node 20 and 22; a compatibility matrix for two
`@opencode/plugin` versions; and a PR benchmark job that caches the corpus and posts the
results table as a PR comment.

Both `analyze` and `convert` run a TypeScript program per plugin. The typechecker
shares parsed `lib.*.d.ts` / `@types` declarations across programs, and extraction
skips loading the standard library into ts-morph, which keeps a full 7-plugin
corpus run around 8 seconds instead of ~20.

Suites include golden module snapshots (`test/__snapshots__/`), negative fixtures
(syntax errors, no factory, mixed APIs, unsupported hooks) and a corpus whose per-plugin
counts are asserted by the benchmark. Test suites live in `test/suites/` and are imported by the single
`test/migration.test.ts` entrypoint: Bun runs test *files* concurrently, and two
files each building TypeScript programs contend for CPU and trip timeouts.

## Known limits (deliberately reported, not hidden)

- Namespace/default imports and runtime subpath imports (e.g. `@opencode-ai/plugin/tui` values) cannot be represented by the shim; those files stay on V1, the report lists them, and `package.json` deliberately keeps the V1 dependency.
- Custom tools keep their Zod shape at runtime and are registered through `z.toJSONSchema()`; plugins still on Zod 3 need a Zod 4 upgrade.
- JavaScript/JSX sources are converted structurally: hooks and tool definitions are read from the AST, but there is no type information, and the emitted module is TypeScript.
- Provider models are resolved once at setup, so dynamically changing model inventories need a manual provider transform.
- V1 `auth` hooks are reported, not converted; V2 integrations use typed forms and OAuth method registrations.
- Conditional custom tools and complex branch bodies are reported, not converted.
- Layout changes are reported as a plan, not applied: automatic moves need import rewriting to stay safe.
- V1 `client` calls are adapted, not rewritten: mapped methods preserve the `{ data }` envelope, adapted methods are reported, and unmapped methods throw at the call site so the gap is visible.
- `chat.message` is bridged through prompt text: non-text parts and a real V1 `UserMessage` are not reconstructed, and the report says so.
- `chat.message` bodies that mutate `output.message.model` stay in review, because the V2 prompt hook has no message model; model choice belongs to the context/provider hooks.
- `chat.params` maps generation options onto `event.options`; the V1 `provider` and `message` inputs have no direct V2 field and are stubbed for the body.
- `chat.headers` maps onto the `model.request` event; plugins that need the raw HTTP exchange should use `http.request`.
- `experimental.chat.system.transform` exposes string entries; existing `SystemPart` cache/metadata are preserved by position, but new entries are plain text parts.
- `config.command` becomes a V2 command definition, but V1 template text is sent as prompt text and `$ARGUMENTS` placeholders are not substituted.
- Other `config` domains, `provider`, and `auth` remain in review; see issue #26.
- `command.execute.before` has no one-to-one V2 hook; the correct destination depends on whether the plugin owns the command.
- The tool validates types, not behavior. A converted plugin still needs a smoke test in a real V2 session.
