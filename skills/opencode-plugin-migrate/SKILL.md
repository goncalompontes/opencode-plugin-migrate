---
name: OpenCode plugin migration
description: Convert an OpenCode V1 plugin to the V2 plugin API with opencode-plugin-migrate, then review every hook, tool and diagnostic the converter could not decide.
---

# OpenCode plugin migration

Use this skill when a repository still targets `@opencode-ai/plugin` (OpenCode V1) and
must run on `@opencode/plugin` (OpenCode V2), or when a V2 migration report needs triage.

The converter is deterministic: it rewrites the mechanical parts, carries every converted
body verbatim, and reports the rest instead of guessing. Your job is to finish the small
part it reports and to keep its evidence honest.

## Preconditions

- The plugin source is present (a compiled `dist/` only is not enough).
- TypeScript or JavaScript entrypoint, plus `package.json` and usually `tsconfig.json`.
- The target project or this tool has `@opencode/plugin` installed. The converter probes
  its declarations and downgrades unsupported hooks instead of emitting invalid code.

Do not ask for credentials. The tool reads local source files only.

## Workflow

1. **Analyze first. This writes nothing.**

   If the `migrate_analyze` tool is available (this package installed as a plugin), call
   it with the plugin directory. Otherwise run:

   ```sh
   opencode-plugin-migrate analyze <dir> --format both
   ```

   Read the hook table before converting. Confirm the classifications make sense for the
   plugin: `converted`, `review`, `unsupported`.

2. **Convert into a separate output root.**

   Tool: `migrate_convert` with `directory` (and optionally `outDir`, `dual`, `force`).

   CLI:

   ```sh
   opencode-plugin-migrate convert <dir> --out .migrate --check
   ```

   The pipeline copies the package, rewrites every V1 authoring import, emits the V2
   module, upgrades `package.json`, typechecks against the real V2 types, bundles it, and
   applies bounded annotation repairs.

3. **Read the report, not only the exit code.**

   `MIGRATION.md` and `migration-report.json` list every hook, tool, diagnostic, preserved
   manual edit and leftover V1 import. Start with anything that is not `converted`:

   - `review`: the V2 destination exists, but the mapping needs intent. Port by hand.
   - `unsupported`: no V2 equivalent. Find the closest V2 surface and state the loss.
   - Typecheck or bundle failures: map the diagnostic back through its
     `#region carried-v1 <hook>` origin.

4. **Port the remainder.**

   Keep the carried bodies intact where they compile. For a review item, implement the V2
   registration the report names (`ctx.session.hook("context")`, `ctx.tool.transform`,
   `ctx.command.transform`, ...) and adapt the event shape explicitly.

5. **Re-run and verify.**

   ```sh
   opencode-plugin-migrate convert <dir> --check
   ```

   Re-runs are incremental: manual edits survive, conflicts are reported, and unchanged
   input is byte-identical. Use `--force` only when you intentionally discard hand edits.

6. **Prove it loads.** Typecheck and bundle are gates, not a behavior test. Load the plugin
   in a real V2 session and exercise one converted hook and one converted tool.

## Review rubric

- Every V1 hook is either emitted or listed. Silence is a bug.
- A carried body must remain byte-for-byte inside its `#region`.
- A `tool` without JSON Schema input is not converted; confirm `ctx.tool.transform` and
  `z.toJSONSchema` are present.
- `client` calls go through the compatibility facade. Calls the facade cannot map throw
  descriptively; replace them with V2 context domains.
- `chat.message`, `chat.params` and `chat.headers` are bridged with documented loss (for
  example non-text parts). State the loss in the migration notes.
- Never weaken `tsconfig` strictness or delete code to satisfy the type checker.

## If the converter is wrong or incomplete

Treat that as a repository contribution, not a local workaround:

1. Reduce the failure to the smallest plugin shape that reproduces it.
2. Add it as a fixture under `test/fixtures/` or as a pinned corpus entry in
   `benchmarks/manifest.ts`.
3. Change the rule or adapter, then update the expected counts and golden snapshot.
4. Run `bun run lint`, `bun run typecheck`, `bun test`, and `bun run bench:core`.
5. Open a pull request against `goncalompontes/opencode-plugin-migrate` referencing the
   failing real package.

See `AGENTS.md`, `CONTRIBUTING.md` and `references/report-fields.md` in this repository.

## Outputs

- `<outDir>/<plugin>/…` — the rewritten package.
- `<outDir>/<plugin>/MIGRATION.md` — human report.
- `<outDir>/<plugin>/migration-report.json` — machine report.
- `<outDir>/<plugin>/migration-state.json` — incremental state; keep it with the output.
