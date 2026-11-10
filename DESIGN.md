# opencode-plugin-migrate — design notes

Goal: convert OpenCode V1 plugins (`@opencode-ai/plugin`) to V2 (`@opencode/plugin`)
using AST + type information + project/env context, preserving every convertible
part and reporting the rest with actionable suggestions.

Status: design + MVP implementation (2026-11-10). Implemented: typed pipeline,
ts-morph extraction, exhaustive hook table, six V2 adapters, typecheck gate,
Markdown/JSON reports, corpus benchmark, whole-package V1 import rewriting via a
generated compatibility shim, Zod custom tools registered through
`z.toJSONSchema()`, a V1 client compatibility facade, bundle/entry runtime validation, config/layout
scaffolding, a `--dual` V1+V2 entrypoint, a bounded auto-repair loop, version-aware capability probing, and branch-aware hook registration. Not yet implemented: provider/auth transforms, applying layout moves, repair
fixers beyond parameter annotations, bounded auto-repair loop, LLM suggestions.

## Why this is tractable

The V2 package ships complete `.d.ts` for the target API, so every rewrite can be
*verified by the type checker* instead of guessed:

- V1 surface: `Plugin = (input: PluginInput, options?) => Promise<Hooks>`
  - `Hooks` is a flat object whose keys are hook names (`"tool.execute.before"`, …)
- V2 surface: `Plugin = { id: string; setup(ctx: Context): Cleanup | void }`
  - hooks are registered per domain: `ctx.tool.hook("execute.before", fn)`,
    `ctx.session.hook("context", fn)`, `ctx.event.subscribe()`, `ctx.tool.transform()`
- V1 callback shape: `(input, output) => Promise<void>` (mutate `output`)
- V2 callback shape: `(event) => Promise<void>` (mutate one mutable event object)

So the conversion is a **typed re-emission**, not a blind text transform. Each site
can be classified and then typechecked against the real target types.

## Core architecture: decompose → classify → re-emit

Not a mutation of the original file. Parse the V1 plugin into an intermediate
representation (IR), then generate a fresh V2 module from it.

```
src/index.ts (V1)
  │  1. ts.createProgram with the plugin's real tsconfig (type info, symbol table)
  ▼
IR
  ├─ imports (named/default/namespace, resolved package IDs)
  ├─ factory params + closure scope (symbol → declaration site)
  ├─ init statements (everything before `return { ... }`)
  ├─ hook sites[]            ← checker-resolved type of each callback
  └─ tool defs[]             ← tool() calls + Zod shapes
  ▼
classification (rule table, versioned per @opencode/plugin release)
  CONVERTED | CONVERTED_REVIEW | INCOMPATIBLE | DROPPED
  ▼
emit
  ├─ index.ts (V2 module: Plugin.define({ id, setup(ctx) { … } }))
  ├─ MIGRATION.md + migration-report.json (per-site status, original LSP range)
  └─ package/config scaffolding
  ▼
typecheck against target @opencode/plugin
  └─ error → map node → hook site → auto-repair (bounded) → report residual
```

Re-emitting is what makes "preserve converted parts" safe: unsupported hooks are
simply *not emitted*, and the file still parses and typechecks. The original code
for each dropped site is preserved verbatim in the report (and as a commented
block if `--keep-unconverted`).

## Classification buckets (the useful part of the tool)

1. **Mechanical** — safe to rewrite, provable by types
   - entrypoint → `Plugin.define({ id, async setup(ctx) { … } })`
   - `dispose` → cleanup returned from `setup`
   - `event` → `ctx.event.subscribe()`
   - `directory` / `project` → `ctx.location.directory` / `ctx.location.project`
   - options arg → `ctx.options`
   - `tool.execute.before|after` → `ctx.tool.hook("execute.before|after", e)`
   - `shell.env` → `ctx.shell.hook("create.before", e)`
   - `tool.definition` + `tool` map → `ctx.tool.transform(...)` (JSON Schema, not Zod)
   - `permission.ask` → `ctx.permission.hook("evaluate", e)`
   - `experimental.chat.system.transform` / `messages.transform` → `ctx.session.hook("context", e)`
   - `experimental.session.compacting` → `ctx.session.hook("compaction", e)`
   - `chat.headers` → `ctx.session.hook("model.request" | "http.request")`

2. **Signature reshape** — same intent, different data flow
   - `(input, output)` → `(event)`: `input.X` → `event.X` on readonly fields,
     `output.Y` → `event.Y` on mutable fields. The checker can prove which is which.
   - `output.system.push(str)` → `event.system.push({ type: "text", text })`
   - tool `execute(args, ctx)` returning `string` → `{ content }` / `Tool.Result`
   - `output.args.filePath` guard → `event.input` is `unknown`; needs a cast + review flag

3. **Semantic re-home** — needs a judgment call, emit + flag
   - `chat.message` → `session.hook("prompt")`
   - `chat.params` → `session.hook("context")` and `event.options.*`
   - `config` / `provider` / `auth` → domain `transform(...)`; no single global config object
   - `command.execute.before` → `ctx.command.transform` if the plugin owns the command,
     otherwise `prompt` hook — cannot be decided from code alone
   - `ctx.client.*` calls → domain methods (`ctx.session`, `ctx.permission`, …);
     many method names changed, so this needs an SDK method map

4. **No V2 equivalent** — report only, never fabricate
   - `experimental.compaction.autocontinue`
   - `experimental.provider.small_model`
   - `experimental.text.complete`
   - `$` (Bun shell helper): must be replaced by an explicit process API
   - `Bun.*` globals that the V2 plugin host does not expose

## Auto-repair loop

Deterministic first, LLM never as the primary mechanism:

1. Rewrite, then `tsc --noEmit` with the target types.
2. Map each diagnostic back to the originating hook site via emitted-node → IR
   `sourceRange` mapping (keep a Node↔IR id table during emit).
3. Look up a fixer by `(error code, node kind, expected type)`. Examples:
   - TS2339 on `event.system.push` → wrap in `SystemPart` shape
   - TS2345 arg of `ctx.tool.hook` → re-resolve hook name from the domain map
   - TS2322 `string` not assignable to `Tool.Result` → wrap `{ content }`
4. Re-run, max N passes; keep a diff journal so nothing oscillates.
5. Residual errors become report entries with the *original* location, the V2
   type at the failure point (printed via `checker.typeToString`), and 1–3
   candidate fixes. Never silently delete code to make types pass.

The LLM/suggestion layer is optional and last: given the hook, the original body,
the V2 type, and the migration table, propose a patch. Deterministic rules must
stay authoritative so output is reproducible.

## Context/env pass (what "env" should mean here)

- `package.json`: drop `@opencode-ai/plugin`, add `@opencode/plugin` at the targeted
  version; fix `exports` if the package is published.
- Layout: `.opencode/plugin/*.ts` → `.opencode/plugins/<name>/index.ts`
  (V2 configured local paths must be directories; a bare `.ts` is skipped with a warning).
- Config: `plugin` → `plugins`, tuple → `{ package, options }`.
- TUI plugins are a different API (`@opencode/plugin/tui`); detect and split.
- Detect the local V2 version (`node_modules/@opencode/plugin/package.json`) and load
  rules for that version; if the installed `.d.ts` no longer matches a rule's
  expected shape, fail that rule loudly rather than emitting wrong code.
- Dual-support mode: emit the documented `{ ...Plugin.define(...), server() { … } }`
  object so one package serves V1 ≥1.18.29 and V2.

## CLI surface

```
opencode-plugin-migrate analyze ./plugin        # report only, no writes (start here)
opencode-plugin-migrate convert ./plugin        # rewrite in place / --out
  --target 2.2.7        --runtime bun
  --keep-unconverted    --dual
  --report json,md      --check (exit 1 on INCOMPATIBLE)
```

`analyze` alone is already worth shipping: it answers "which of my hooks survive?"
with a per-hook table and no risk.

## Validation strategy

- Golden fixtures: real V1 plugins (opencode-handoff, lowfat, openslimedit,
  opencode-auto-resume, engram) → expected classification + typecheck-clean output.
- Every fixture must `bun build` and load in a real V2 service; grep the log for
  `failed to load plugin` (the V2 failure mode today).
- Property: never emit code the checker rejects without marking it in the report.
- Round-trip idempotence: running on an already-migrated plugin is a no-op.

## Known limits (say them in the report, not in the code)

- Some V1 hooks have no V2 destination at all; those plugins are "port or drop".
- `chat.params` vs `chat.message` and `command.execute.before` need intent, so a
  pure static tool can only propose.
- Server-API call sites (`ctx.client.*`) are the second migration axis and are only
  partially automatable.
- Plugin behavior (not type shape) still needs a smoke test; the tool can generate
  the test skeleton but not assert semantics.
