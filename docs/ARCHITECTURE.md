# Architecture

`opencode-plugin-migrate` is a typed pipeline: every stage validates its output and
the generated module must pass two independent gates before it is accepted.

## Pipeline

```
resolve entry ──► extract IR ──► classify ──► emit V2 ──► repair ──► typecheck ──► bundle/entry ──► report
```

| Stage | Module | Responsibility |
| --- | --- | --- |
| resolve | `src/env/project.ts` | entrypoint, tsconfig, package metadata, output copy |
| extract | `src/ir/extract.ts` | ts-morph IR: factory, hooks, tools, providers, auth, module scope |
| classify | `src/rules/hooks.ts`, `src/rules/compat.ts` | exhaustive V1→V2 table, capability probe, downgrade |
| emit | `src/emit/emit.ts` | V2 module, adapters, shims, dual entrypoint |
| repair | `src/validate/repair.ts` | bounded deterministic fixers with hook-origin mapping |
| typecheck | `src/validate/typecheck.ts` | real TypeScript program against `@opencode/plugin` |
| bundle | `src/validate/bundle.ts` | `Bun.build` + `Plugin.define` entry shape |
| report | `src/report/*` | Markdown/JSON findings and leftovers |

## Invariants

- Stage outputs are Zod-validated; the pipeline builder preserves types between stages.
- Hook classification is total over `keyof Hooks`; unknown hooks never guess.
- Carried V1 bodies are copied verbatim inside `#region carried-v1 <origin>` markers.
- A hook is `converted` only when an adapter exists and the result typechecks.
- Anything not emitted stays in the report with its original body.
- Incremental runs merge by base hash; manual edits win over regenerated code.
- Auto-repair may only add annotations; it never deletes or comments out code.

## Package layout

```
src/core/       pipeline and diagnostics
src/env/        project/config/import/client/package scaffolding
src/ir/         Zod IR and ts-morph extraction
src/rules/      hook table and target capability probe
src/emit/       emitter and per-hook adapters
src/validate/   typecheck, bundle, repair, incremental merge
src/report/     report schema and renderer
src/cli/        CLI entrypoint and skill installer
src/plugin/     OpenCode V2 server plugin (tools + skill registration)
skills/         installable agent skill and HTTP catalog
scripts/        build, pack smoke, coverage floor, capability probe
benchmarks/     pinned corpus, runner, RESULTS.md
test/           fixtures, suites, snapshots
docs/           architecture, install, releasing
```

## Versioning

Rules are checked against the installed `@opencode/plugin` declaration files. When a
capability is missing, affected hooks downgrade to `review` instead of emitting code
that cannot load. `--target` records the expected version and warns on mismatch.

## Benchmark

`benchmarks/run.ts` has two corpora:

- **curated** (`benchmarks/manifest.ts`): strict expected counts, used by tests and
  PR CI;
- **community** (`benchmarks/community.json`): discovered from GitHub code search,
  pinned, and recorded against `benchmarks/baseline.json`.

Each conversion runs in `benchmarks/worker.ts`; the parent pools workers and caches
results in `benchmarks/.cache` keyed by `repo@commit` and a fingerprint of `src/` plus
the installed `@opencode/plugin` version. A clean baseline regression fails the run;
new failures are reported in `COMMUNITY.md`.

## Distribution surfaces

The pipeline is the product; the three install surfaces are thin adapters over it.

| Surface | Entry | Contract |
| --- | --- | --- |
| Library | `src/index.ts` → `dist/index.js` | `analyzePlugin` / `convertPlugin` |
| CLI | `src/cli/index.ts` → `dist/cli.js` | exit codes `0/1/2`, Markdown/JSON reports |
| OpenCode plugin | `src/plugin/index.ts` (`./server`) | `migrate_analyze`, `migrate_convert`, skill registration |
| Agent skill | `skills/opencode-plugin-migrate/` | workflow and review rubric as Markdown |

The plugin and CLI call the same public API, so a conversion produces identical output
and report artifacts. The skill is data; the plugin embeds it through `ctx.skill`, and
`install-skill` copies it into a filesystem skill source for hosts that do not load this
plugin.

## Known boundaries

- V1 types are authoring-time only; the compatibility shim keeps them compiling.
- Provider models and client calls are resolved/adapted at setup, so dynamic
  inventories need manual work.
- Layout moves are reported as a plan; applying them automatically would break
  relative imports.
