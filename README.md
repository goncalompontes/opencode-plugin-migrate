# opencode-plugin-migrate

**Convert OpenCode V1 plugins to V2 — with a typed AST pass, verbatim body carry, and a compile + runtime gate.**

[![CI](https://github.com/goncalompontes/opencode-plugin-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/goncalompontes/opencode-plugin-migrate/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/goncalompontes/opencode-plugin-migrate)](https://github.com/goncalompontes/opencode-plugin-migrate/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-unit%20%2B%20corpus-brightgreen)](test/migration.test.ts)
[![Corpus](https://img.shields.io/badge/corpus-10%20curated%20%C2%B7%20150%20community-informational)](benchmarks/RESULTS.md)

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
- [Inside OpenCode](#inside-opencode)
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

Coverage from the curated corpus: **18/22 hooks converted**, **8/8 tools registered**,
**10/10 modules typecheck**, **9/10 bundle** (the tenth is a known upstream checkout gap).

## Install

Every release ships a packed tarball. Download it and install the local file:

```sh
gh release download v0.2.0 --pattern '*.tgz'
npm install --global ./opencode-plugin-migrate-0.2.0.tgz
opencode-plugin-migrate --help
```

npm 12+ blocks remote tarballs by default; if you prefer one command, allow it:

```sh
npm install --global --allow-remote=root https://github.com/goncalompontes/opencode-plugin-migrate/releases/download/v0.2.0/opencode-plugin-migrate-0.2.0.tgz
```

From source:

```sh
git clone https://github.com/goncalompontes/opencode-plugin-migrate.git
cd opencode-plugin-migrate
bun install && bun run build
./dist/cli.js --help
```

The CLI runs on Node 20+ and Bun. Bundle validation uses `Bun.build`; under Node it is
skipped and reported as `bundle skipped (Node)`. Type checking, conversion, reports and
repair work on both runtimes. npm publishing activates when an `NPM_TOKEN` secret is
configured.

Full options, including npm, OpenCode plugin, and skill installs: **[docs/INSTALL.md](docs/INSTALL.md)**.

## Quick start

```sh
# 1. See what will happen. No writes.
opencode-plugin-migrate analyze ./plugin

# 2. Convert into .migrate/<plugin>/. Writes MIGRATION.md + JSON.
opencode-plugin-migrate convert ./plugin

# 3. Review the report, then fail on anything left to port.
opencode-plugin-migrate convert ./plugin --check --quiet
```

`convert` copies the package, rewrites every V1 authoring import, emits the V2 module,
upgrades `package.json`, typechecks against `@opencode/plugin`, bundles it, and repairs
fixable parameter annotations. Every skipped hook keeps its original body in
`MIGRATION.md` and `migration-report.json`.

## Inside OpenCode

Install the server part and the agent skill together:

```sh
opencode plugin add github:goncalompontes/opencode-plugin-migrate
```

That adds two tools to the session:

| Tool | What it does |
| --- | --- |
| `migrate_analyze` | Reports how a V1 plugin maps to V2. Writes nothing. |
| `migrate_convert` | Converts, typechecks, bundles, and writes `MIGRATION.md` + JSON. |

The plugin also registers the bundled **`opencode-plugin-migrate` skill**, which tells the
agent how to triage the report and finish the review items. If you only want the skill in
another host, install the Markdown directly:

```sh
opencode-plugin-migrate install-skill          # .opencode/skills/opencode-plugin-migrate
opencode-plugin-migrate install-skill --global # ~/.config/opencode/skills/...
```

Or point OpenCode at the catalog in this repository:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "skills": [
    "https://raw.githubusercontent.com/goncalompontes/opencode-plugin-migrate/main/skills/",
  ],
}
```

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
bun benchmarks/run.ts           # full corpus, writes RESULTS.md/COMMUNITY.md
bun run bench:core              # curated 10, used on pull requests
bun run corpus:discover         # refresh the community list from GitHub
```

### Community corpus

Beyond the curated ten, the benchmark discovers real packages from GitHub code
search for `@opencode-ai/plugin`, pins each commit, and records the result:

- **150 packages** discovered; **143 applicable** (7 are compiled-only, already V2,
  or have no plugin entrypoint).
- **80 fully clean** (typecheck + bundle), **120/182 hooks converted**.
- The rest are recorded with the first blocking error in
  [benchmarks/COMMUNITY.md](benchmarks/COMMUNITY.md); a clean baseline that regresses
  fails the run.

### Performance

- Conversion results are cached by `repo@commit` plus a fingerprint of the converter
  source, so unchanged entries are not re-converted. A cached full run is seconds; a
  cold run uses a worker pool (`BENCH_CONCURRENCY`, default 8) and takes a few minutes.
- `--core-only` skips the community corpus for fast PR feedback.
- CI caches both the cloned corpus and `benchmarks/.cache`.

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
src/cli/        CLI entrypoint and skill installer
src/plugin/     OpenCode V2 server plugin (tools + skill registration)
skills/         installable agent skill and HTTP catalog
scripts/        build, pack smoke, coverage floor, capability probe
benchmarks/     pinned corpus, runner, RESULTS.md
test/           fixtures, suites, snapshots
docs/           architecture, install, releasing
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
bun run bench:core        # curated corpus, cached, for PR feedback
bun run bench             # curated + community, cached after the first run
bun run corpus:discover   # refresh the community list from GitHub
```

CI runs Biome, typecheck, tests and the Node CLI on Bun `1.4.4` and `latest`, coverage
floors, pack smoke on Node 20/22, a compatibility matrix for two `@opencode/plugin`
versions, a PR benchmark for the curated corpus, and a weekly workflow for the full
community corpus.

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

## Project docs

- [Installation](docs/INSTALL.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Releasing](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [Agent instructions](AGENTS.md)

## License

[MIT](LICENSE) © 2026 goncalompontes
