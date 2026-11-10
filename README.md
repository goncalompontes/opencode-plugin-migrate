# opencode-plugin-migrate

**Convert OpenCode V1 plugins to V2 — with a typed AST pass, verbatim body carry, and a compile + runtime gate.**

[![CI](https://github.com/goncalompontes/opencode-plugin-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/goncalompontes/opencode-plugin-migrate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-48%20passing-brightgreen)](test/migration.test.ts)
[![Corpus](https://img.shields.io/badge/corpus-10%20packages%20%C2%B7%2022%20hooks-informational)](benchmarks/RESULTS.md)

V1 plugins do not load in V2: the entrypoint, context, hook signatures, client API,
and tool schema all changed. This tool performs the mechanical conversion, keeps every
body it touches byte-for-byte, and reports the parts that need a human decision instead
of dropping them.

```sh
bun run src/cli/index.ts analyze ./my-plugin   # report only, writes nothing
bun run src/cli/index.ts convert ./my-plugin   # emit + typecheck + bundle
```

- [Why](#why)
- [What it converts](#what-it-converts)
- [Install](#install)
- [Quick start](#quick-start)
- [Benchmark](#benchmark)
- [How it works](#how-it-works)
- [Safety model](#safety-model)
- [CLI](#cli)
- [Scaffolding and re-runs](#scaffolding-and-re-runs)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Limitations](#limitations)

## Why

OpenCode V1 plugins are functions that return a hook map. V2 plugins default-export a
definition with an `id` and `setup(ctx)`, and hooks are registered on domains. The types
changed, the client moved onto the context, tools take JSON Schema, and some experimental
hooks no longer exist.

A text search-and-replace cannot do this safely. This project uses the TypeScript
compiler to understand the original plugin, emits a complete V2 module, and refuses to
call anything "converted" until the result typechecks and bundles.

## What it converts

| Area | V1 | V2 |
| --- | --- | --- |
| Entrypoint | `export const plugin: Plugin = async (input) => ({ ... })` | `Plugin.define({ id, setup(ctx) })` |
| Hooks | returned hook map | `ctx.tool.hook`, `ctx.session.hook`, `ctx.event.subscribe`, ... |
| Custom tools | `tool({ args: zod })` | `ctx.tool.transform` + `z.toJSONSchema` |
| Client | `client.session.get({ path })` | V2 domains through a generated compatibility facade |
| Package imports | every `@opencode-ai/plugin` import | generated typed shim, V1 dependency removed |
| Conditional maps | `if (x) return { ... }` | `if (x) { ... } else { ... }` registration |
| Scaffolding | `plugin` config, layout files, TUI | normalized config, move plans, TUI detection, `--dual` |

Coverage from the real-plugin corpus: **18/22 hooks converted**, **9/9 tools registered**,
**10/10 modules typecheck**, **9/10 bundle** (the tenth is a known upstream checkout gap).

## Install

```sh
npm install -g opencode-plugin-migrate
# or
bun install -g opencode-plugin-migrate
# or from source
git clone https://github.com/goncalompontes/opencode-plugin-migrate.git
cd opencode-plugin-migrate && bun install && bun run build
```

The published CLI runs on Node 20+ and Bun. Bundle validation uses `Bun.build`; under
Node it is skipped and reported as `bundle skipped (Node)`. Type checking, conversion,
reports and repair work on both runtimes.

## Quick start

```sh
# 1. See what will happen. No writes.
opencode-plugin-migrate analyze ./plugin

# 2. Convert into .migrate/<plugin>/. Writes MIGRATION.md + JSON.
opencode-plugin-migrate convert ./plugin

# 3. Review the report, then typecheck the result in its project.
opencode-plugin-migrate convert ./plugin --check --quiet
```

`convert` copies the package, rewrites every V1 authoring import, emits the V2 module,
upgrades `package.json`, typechecks against `@opencode/plugin`, bundles it, and repairs
fixable parameter annotations. Every skipped hook keeps its original body in
`MIGRATION.md` and `migration-report.json`.

## Benchmark

The benchmark runs against pinned public V1 plugins plus two local fixtures. Each entry
carries expected counts, so a regression fails with `expected X, got Y`.

| Package | Hooks | Converted | Review | Unsupported | Tools | Typecheck | Runtime | V1 imports |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: |
| [openslimedit](https://github.com/ASidorenkoCode/openslimedit) | 3 | 3 | 0 | 0 | 0/0 | clean | ok | 1 → 0 |
| [opencode-smartsnip](https://github.com/carson2222/opencode-smartsnip) | 2 | 2 | 0 | 0 | 0/0 | clean | ok | 1 → 0 |
| [opencode-notify](https://github.com/kdcokenny/opencode-notify) | 2 | 2 | 0 | 0 | 0/0 | clean | upstream gap | 1 → 0 |
| [opencode-request-logger](https://github.com/Opencode-DCP/opencode-request-logger) | 1 | 1 | 0 | 0 | 0/0 | clean | ok | 1 → 0 |
| [opencode-message-notify](https://github.com/Decade-qiu/opencode-message-notify) | 2 | 2 | 0 | 0 | 0/0 | clean | ok | 1 → 0 |
| [opencode-smart-voice-notify](https://github.com/MasuRii/opencode-smart-voice-notify) | 2 | 2 | 0 | 0 | 0/0 | clean | ok | 0 → 0 |
| [OpenCode-Image-Router](https://github.com/adrivansoft/OpenCode-Image-Router-Plugin) | 1 | 0 | 1 | 0 | 0/0 | clean | ok | 0 → 0 |
| inline-tools *(fixture)* | 0 | 0 | 0 | 0 | 2/2 | clean | ok | 2 → 0 |
| [opencode-auto-resume](https://github.com/Mte90/opencode-auto-resume) | 6 | 4 | 1 | 1 | 1/1 | clean | ok | 1 → 0 |
| [opencode-pty](https://github.com/shekohex/opencode-pty) | 3 | 2 | 0 | 1 | 5/5 | clean | ok | 8 → 0 |

```sh
bun benchmarks/run.ts --fetch   # clone pinned commits into benchmarks/corpus
bun benchmarks/run.ts           # writes benchmarks/RESULTS.md, exits 1 on regressions
```

The full result and per-plugin notes live in [benchmarks/RESULTS.md](benchmarks/RESULTS.md).

## How it works

```
resolve ─► extract IR ─► classify ─► emit V2 ─► repair ─► typecheck ─► bundle/entry ─► report
```

1. **Resolve** the entrypoint using `package.json`, tsconfig, and V1 importers.
2. **Extract** a typed IR with ts-morph: factory, hooks, tools, providers, auth, imports.
3. **Classify** every hook against an exhaustive `Record<keyof Hooks, Rule>`, then probe
   the installed `@opencode/plugin` for the capabilities each adapter needs.
4. **Emit** a complete V2 module; carried bodies stay verbatim inside
   `#region carried-v1 <hook>` markers.
5. **Repair** fixable diagnostics in bounded passes (annotations only, never deletion).
6. **Typecheck** with the real compiler and the plugin's own tsconfig.
7. **Bundle** with `Bun.build` and verify the `Plugin.define({ id, setup })` shape.
8. **Report** what converted, what needs review, and what was preserved.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [DESIGN.md](DESIGN.md).

## Safety model

- **Exhaustive rules.** Hook classification is total over the V1 hook type; unknown
  hooks fall back to `unsupported`, never a guess.
- **Validated boundaries.** Every pipeline stage output is parsed with Zod.
- **Verbatim carry.** Bodies are moved as source text and labelled with their origin.
- **Complete output.** Skipped hooks never leave dangling syntax; the module is whole.
- **Two gates.** Typecheck against real V2 types, then bundle + entry-shape check.
- **No silent deletion.** Anything not emitted is in the report with its original body.
- **Deterministic repair.** Fixers only add annotations; unresolved errors stay visible.

## CLI

| Flag | Meaning |
| --- | --- |
| `--out DIR` | Output root (default `.migrate`) |
| `--dry-run` | Run everything, print the module, write nothing |
| `--check` | Exit 1 on review/unsupported hooks, leftover V1 imports, or validation failure |
| `--format md\|json\|both` | Report format (`--json` is a shorthand) |
| `--quiet` | Exit code only |
| `--dual` | Emit a V1 `server()` next to the V2 `setup()` |
| `--target VERSION` | Expected `@opencode/plugin` version; warns on mismatch |
| `--force` | Regenerate and discard preserved manual edits |

Exit codes: `0` success, `1` validation or `--check` findings, `2` usage error.

## Scaffolding and re-runs

- `opencode.json(c)`: `plugin` → `plugins`, tuples → `{ package, options }`.
- Layout: reports the moves required by V2 (`.opencode/plugins/<name>/index.ts`).
- TUI: detects V1 TUI plugins and keeps them out of the server conversion.
- Manifest: swaps `@opencode-ai/plugin` for `@opencode/plugin`, adds `zod` when the shim
  is used.
- Incremental: `migration-state.json` stores base hashes; manual edits survive re-runs,
  conflicts are reported, unchanged input is byte-identical.
- `--dual`: keeps a V1 `server()` entrypoint for hosts on OpenCode ≥ 1.18.29.

## Repository layout

```
src/core/       typed pipeline and diagnostics
src/env/        project/config/import/client/package scaffolding
src/ir/         Zod IR and ts-morph extraction
src/rules/      hook table and target capability probe
src/emit/       emitter and per-hook adapters
src/validate/   typecheck, bundle, repair, incremental merge
src/report/     report schema and Markdown/JSON renderer
src/cli/        CLI entrypoint
scripts/        build, pack smoke, coverage floor, capability probe
benchmarks/     pinned corpus, runner, RESULTS.md
test/           fixtures, suites, snapshots
docs/           architecture
```

## Development

```sh
bun install
bun run lint              # Biome
bun run typecheck
bun test                  # one entrypoint, 60s per-test budget
bun run coverage:check    # floors for src/rules and src/emit
bun run build             # dist library + Node CLI
bun run smoke:pack        # packed-tarball install smoke test
bun run bench
```

CI runs Biome, typecheck, tests and the Node CLI on Bun `1.4.4` and `latest`, coverage
floors, pack smoke on Node 20/22, a compatibility matrix for two `@opencode/plugin`
versions, and a PR benchmark that posts the results table as a comment.

## Limitations

- `chat.message` is bridged through prompt text; non-text parts and a full `UserMessage`
  are not reconstructed. Bodies that mutate `output.message.model` stay in review.
- V1 `client` calls are adapted, not rewritten: mapped methods keep the `{ data }`
  envelope, adapted methods are reported, unmapped methods throw at the call site.
- Provider models are resolved once at setup; dynamic inventories need manual work.
- Auth `loader` and prompt validation are reported; OAuth results without refresh/access
  throw a descriptive error.
- Conditional custom tools and complex branch bodies are reported, not converted.
- Layout changes are a plan, not applied.
- Validation proves types and loading, not behavior. Run a smoke test in a real V2 session.

## License

[MIT](LICENSE) © 2026 goncalompontes
